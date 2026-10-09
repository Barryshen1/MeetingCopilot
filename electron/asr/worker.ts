/**
 * ASR worker: VAD segmentation + Whisper turbo transcription.
 * Never blocks the Electron main thread (PLAN §3.1 hard rule).
 *
 * MUST run as an Electron utilityProcess (own OS process), NOT worker_threads:
 * DML inference inside the Electron main process hangs on real segments once
 * Chromium's GPU work is active (warmup passes, first real pipe() never
 * returns — the Natively "0 transcript segments" symptom, root-caused
 * 2026-07-09). A separate process matches the validated plain-node harness.
 * worker_threads support is kept only as a compat path for tests.
 */
import { parentPort as threadPort } from 'worker_threads';
import { VadSegmenter } from './vad';
import {
  WhisperEngine,
  isJunkTranscript,
  isStreamingEngine,
  type AsrEngine,
  type StreamingAsrEngine,
  type StreamingSession,
} from './engine';
import { CloudAsrEngine } from './cloudEngine';
import { AliyunRealtimeEngine } from './aliyunRealtimeEngine';
import { LiveTranslateEngine } from './liveTranslateEngine';
import { LanguageRouter, type LidResult } from './langRouter';
import type { WorkerInit, WorkerInMessage, WorkerOutMessage } from './contract';

// Electron utilityProcess exposes process.parentPort (MessageEvent-style).
interface UtilPort {
  on(ev: 'message', cb: (e: { data: unknown }) => void): void;
  postMessage(m: unknown): void;
}
const utilPort = (process as NodeJS.Process & { parentPort?: UtilPort }).parentPort;

if (!utilPort && !threadPort) throw new Error('asr worker must run in utilityProcess or worker_threads');

function post(msg: WorkerOutMessage): void {
  if (utilPort) utilPort.postMessage(msg);
  else threadPort!.postMessage(msg);
}

function listen(cb: (msg: WorkerInMessage) => void): void {
  if (utilPort) utilPort.on('message', (e) => cb(e.data as WorkerInMessage));
  else threadPort!.on('message', (m) => cb(m as WorkerInMessage));
}

type Channel = 'them' | 'me';

interface PendingSegment {
  pcm: Float32Array;
  startTs: number;
  endTs: number;
  vadCloseTs: number;
  speaker: Channel;
}

const MAX_QUEUE = 10;
/** idle keep-warm: re-touch DML after this much silence so the first real
 * sentence after a lull doesn't pay a cold-GPU tail (~3.5 s measured) */
const KEEPWARM_IDLE_MS = 45_000;
const KEEPWARM_CHECK_MS = 15_000;

let engine: AsrEngine | null = null;
const vads: Record<Channel, VadSegmenter> = { them: new VadSegmenter(), me: new VadSegmenter() };
const routers: Record<Channel, LanguageRouter> = { them: new LanguageRouter(), me: new LanguageRouter() };
let language: 'auto' | string = 'auto';
let queue: PendingSegment[] = [];
let transcribing = false;
let segCounter = 0;
let shuttingDown = false;
let lastInferTs = Date.now();
let partialBusy = false;
/** live partials: on for local (GPU idle), off for cloud (per-call cost) */
const PARTIAL_INTERVAL_MS = 1400;

// ---- true-streaming backend state (backend === 'cloud-realtime') ----
/** live WS session per channel; opened on speech-start, closed after idle */
const streams: Record<Channel, StreamingSession | null> = { them: null, me: null };
/** wallclock of each session's audio t=0 (maps service sentence times) */
const streamEpoch: Record<Channel, number> = { them: 0, me: 0 };
/** last time the channel's VAD saw speech (drives idle close) */
const lastSpeechAt: Record<Channel, number> = { them: 0, me: 0 };
/** ~300 ms pre-roll so the first syllable isn't clipped at session open */
const ring: Record<Channel, { pcm: Float32Array; ms: number }[]> = { them: [], me: [] };
const RING_MS = 300;
/** close the WS after this much silence (cost gate; service dies at ~23 s idle anyway) */
const STREAM_IDLE_CLOSE_MS = 10_000;

// ---- 对方 live translation (LiveTranslate engine replaces the ASR for 'them') ----
let ltEngine: LiveTranslateEngine | null = null;
let ltEnabled = false;
/** after a failed connect, 对方 uses the plain engine until this time */
let ltSuspendedUntil = 0;
const LT_RETRY_AFTER_MS = 60_000;
/** audio sent to a translate session that is not live yet, replayed into the
 * plain engine if that session never comes up (so nothing said is lost) */
const ltBacklog: Record<Channel, Float32Array[] | null> = { them: null, me: null };
const LT_BACKLOG_MAX_FRAMES = 300; // ~30 s of 100 ms frames
/** a translate session takes ~3 s to come up (measured) and keeps the
 * meeting's context, so it stays open through longer pauses than plain ASR */
const LT_IDLE_CLOSE_MS = 30_000;
const streamIsLt: Record<Channel, boolean> = { them: false, me: false };

function ltActive(): boolean {
  return !!ltEngine && ltEnabled && Date.now() >= ltSuspendedUntil;
}

/** the live-stream engine for a channel, or null = VAD-segment path */
function streamEngineFor(ch: Channel): StreamingAsrEngine | null {
  if (ch === 'them' && ltActive()) return ltEngine;
  return engine && isStreamingEngine(engine) ? engine : null;
}

/** service language codes → the names the transcript UI shows */
function langName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (code === 'en' || code.startsWith('en-')) return 'english';
  if (code === 'zh' || code.startsWith('zh-')) return 'chinese';
  return code;
}

setInterval(() => {
  if (!engine || transcribing || shuttingDown || queue.length > 0) return;
  if (engine.ep.startsWith('cloud')) return; // cloud is stateless — nothing to keep warm
  if (Date.now() - lastInferTs < KEEPWARM_IDLE_MS) return;
  transcribing = true;
  const tiny = new Float32Array(4800); // 0.3 s silence
  engine
    .transcribe(tiny, 'english')
    .catch(() => undefined)
    .finally(() => {
      lastInferTs = Date.now();
      transcribing = false;
      void pump();
    });
}, KEEPWARM_CHECK_MS).unref?.();

async function handleInit(init: WorkerInit): Promise<void> {
  try {
    language = init.language;
    if (init.backend === 'cloud-realtime') {
      if (!init.cloud) throw new Error('cloud streaming ASR is not configured');
      engine = await AliyunRealtimeEngine.load(init.cloud);
      post({ type: 'ready', loadMs: 0, warmMs: 0, ep: 'cloud-rt', gpuSuspect: false });
    } else if (init.backend === 'cloud') {
      if (!init.cloud) throw new Error('cloud ASR is not configured');
      engine = await CloudAsrEngine.load(init.cloud);
      post({ type: 'ready', loadMs: 0, warmMs: 0, ep: 'cloud', gpuSuspect: false });
    } else {
      const eng = await WhisperEngine.load({ modelsDir: init.modelsDir, modelId: init.modelId, ep: init.ep });
      engine = eng;
      const warmMs = await eng.warmup();
      // GPU encoder warm pass is ~120 ms; multi-second warm means CPU fallback.
      const gpuSuspect = init.ep.includes('dml') && warmMs > 4000;
      post({ type: 'ready', loadMs: eng.loadMs, warmMs, ep: eng.ep, gpuSuspect });
      // live partials only for the local GPU engine (cloud = per-call cost)
      vads.them.setPartialInterval(PARTIAL_INTERVAL_MS);
      vads.me.setPartialInterval(PARTIAL_INTERVAL_MS);
    }
    post({ type: 'status', state: 'listening', queuedSegments: 0 });
  } catch (e) {
    post({ type: 'error', message: `engine load failed: ${(e as Error).message}`, fatal: true });
    return;
  }
  if (init.liveTranslate) {
    try {
      ltEngine = await LiveTranslateEngine.load({
        url: init.liveTranslate.url,
        apiKey: init.liveTranslate.apiKey,
        target: init.liveTranslate.target,
      });
      ltEnabled = init.liveTranslate.enabled;
      console.log(`[worker] live translate ready (target=${init.liveTranslate.target}, ${ltEnabled ? 'on' : 'off'})`);
    } catch (e) {
      post({ type: 'error', message: `live translation unavailable: ${(e as Error).message}`, fatal: false });
    }
  }
}

/** 实时翻译 on/off mid-meeting: route 对方 to the other engine from now on */
function setLiveTranslate(on: boolean): void {
  const before = streamEngineFor('them');
  ltEnabled = on;
  ltSuspendedUntil = 0;
  const after = streamEngineFor('them');
  console.log(`[worker] live translate ${on ? 'on' : 'off'}${ltEngine ? '' : ' (not configured)'}`);
  if (before === after) return;
  const speaking = vads.them.state === 'speech';
  if (!before) {
    // VAD-segment path → live stream: transcribe what was already collected
    handleVadEvents(vads.them.flush(), 'them');
  } else {
    closeStream('them');
    // live stream → VAD-segment path: the open utterance was already streamed
    if (!after) vads.them.flush();
  }
  // mid-sentence: carry on in the new engine instead of waiting for a pause
  if (after && speaking) {
    lastSpeechAt.them = Date.now();
    ensureStream('them', after);
  }
}

function handleVadEvents(events: ReturnType<VadSegmenter['push']>, channel: Channel): void {
  for (const ev of events) {
    if (ev.type === 'speech-start') {
      post({ type: 'status', state: 'speech', queuedSegments: queue.length });
    } else if (ev.type === 'partial') {
      void doPartial(ev.pcm, channel);
    } else if (ev.type === 'segment') {
      if (queue.length >= MAX_QUEUE) {
        queue.shift();
        post({ type: 'error', message: 'transcribe queue overflow, dropped oldest segment', fatal: false });
      }
      queue.push({ pcm: ev.pcm, startTs: ev.startTs, endTs: ev.endTs, vadCloseTs: Date.now(), speaker: channel });
      void pump();
    }
  }
}

// ---- true-streaming path: VAD is only the session gate; the service does
// sentence endpointing and pushes partial/final text itself ----

function ensureStream(ch: Channel, se: StreamingAsrEngine, replay?: Float32Array[]): void {
  if (streams[ch]) return;
  const isLt = se === ltEngine;
  const preroll = replay ?? ring[ch].map((c) => c.pcm);
  const prerollMs = preroll.reduce((a, p) => a + (p.length / 16000) * 1000, 0);
  streamEpoch[ch] = Date.now() - prerollMs;
  const epoch = streamEpoch[ch];
  const openedAt = Date.now();
  let session: StreamingSession | null = null;
  session = se.openSession(
    {
      onReady: () => {
        if (!isLt) return;
        ltBacklog[ch] = null; // live: nothing to replay any more
        console.log(`[worker] live translate session ready ch=${ch} in ${Date.now() - openedAt}ms`);
      },
      onPartial: (text, translation) => {
        if (shuttingDown || isJunkTranscript(text)) return;
        post({ type: 'partial', speaker: ch, text, ...(translation ? { translation } : {}) });
      },
      onSentence: (s) => {
        if (shuttingDown || isJunkTranscript(s.text)) return;
        const now = Date.now();
        post({
          type: 'segment',
          id: ++segCounter,
          text: s.text,
          lang: langName(s.lang),
          speaker: ch,
          ...(s.translation ? { translation: s.translation } : {}),
          audioMs: Math.max(0, s.endMs - s.beginMs),
          speechStartTs: epoch + s.beginMs,
          speechEndTs: epoch + s.endMs,
          vadCloseTs: epoch + s.endMs,
          inferStartTs: epoch + s.endMs,
          inferEndTs: now,
        });
      },
      onError: (message) => {
        const current = streams[ch] === session;
        if (current) streams[ch] = null;
        if (shuttingDown) return;
        const backlog = isLt ? ltBacklog[ch] : null;
        if (isLt) ltBacklog[ch] = null;
        if (backlog && current) {
          // the translate session never came up (key, model not enabled,
          // network): fall back to the plain engine for a while and replay
          // the audio it swallowed, so nothing said is lost
          ltSuspendedUntil = Date.now() + LT_RETRY_AFTER_MS;
          post({
            type: 'error',
            message: `live translation failed, transcribing ${ch} without translation for ${LT_RETRY_AFTER_MS / 1000} s: ${message}`,
            fatal: false,
          });
          const plain = streamEngineFor(ch);
          if (plain && plain !== ltEngine) ensureStream(ch, plain, backlog);
          return;
        }
        post({
          type: 'error',
          message: `${isLt ? 'live translation' : 'streaming ASR'} (${ch}): ${message}`,
          fatal: false,
        });
        // dropped mid-sentence after working for a while (network blip,
        // service session limit): reconnect now instead of after the pause
        const next = streamEngineFor(ch);
        if (current && next && vads[ch].state === 'speech' && Date.now() - openedAt > 5000) {
          ensureStream(ch, next);
        }
      },
    },
    { language },
  );
  // flush pre-roll first so the first syllable survives, then live frames follow
  for (const pcm of preroll) session.push(pcm);
  ring[ch] = [];
  ltBacklog[ch] = isLt ? [...preroll] : null;
  streamIsLt[ch] = isLt;
  streams[ch] = session;
  console.log(`[worker] stream open ch=${ch}${isLt ? ' (live translate)' : ''}`);
}

function closeStream(ch: Channel): void {
  const s = streams[ch];
  if (!s) return;
  streams[ch] = null;
  ltBacklog[ch] = null;
  console.log(`[worker] stream close ch=${ch}`);
  void s.close().catch(() => undefined);
}

function handleStreamingPcm(pcm: Float32Array, ch: Channel, captureTs: number, se: StreamingAsrEngine): void {
  const events = vads[ch].push(pcm, captureTs);
  for (const ev of events) {
    if (ev.type === 'speech-start') {
      lastSpeechAt[ch] = Date.now();
      post({ type: 'status', state: 'speech', queuedSegments: 0 });
      ensureStream(ch, se);
    } else if (ev.type === 'segment') {
      // local VAD closed the utterance; keep the WS open for the service's own
      // finalization + possible follow-up sentence (idle timer reaps it)
      post({ type: 'status', state: 'listening', queuedSegments: 0 });
    }
    // 'partial' VAD events are meaningless here (service streams its own)
  }
  if (vads[ch].state === 'speech') lastSpeechAt[ch] = Date.now();

  const frameMs = (pcm.length / 16000) * 1000;
  if (streams[ch]) {
    // stream every frame (speech AND trailing silence) so the service's
    // sentence timing stays continuous; cost is bounded by the idle close
    streams[ch]!.push(pcm);
    const backlog = ltBacklog[ch];
    if (backlog) {
      backlog.push(pcm);
      if (backlog.length > LT_BACKLOG_MAX_FRAMES) backlog.shift();
    }
  } else {
    ring[ch].push({ pcm, ms: frameMs });
    let held = ring[ch].reduce((a, c) => a + c.ms, 0);
    while (held > RING_MS && ring[ch].length > 1) {
      held -= ring[ch][0].ms;
      ring[ch].shift();
    }
  }
}

/** reap idle streaming sessions (nobody spoke for STREAM_IDLE_CLOSE_MS) */
setInterval(() => {
  if (!engine || shuttingDown) return;
  for (const ch of ['them', 'me'] as Channel[]) {
    const idleMs = streamIsLt[ch] ? LT_IDLE_CLOSE_MS : STREAM_IDLE_CLOSE_MS;
    if (streams[ch] && vads[ch].state !== 'speech' && Date.now() - lastSpeechAt[ch] > idleMs) {
      closeStream(ch);
    }
  }
}, 2000).unref?.();

/**
 * Live partial: transcribe the open segment so far and emit a transient text.
 * Never delays a final (skips when the queue is busy) and drops if one is
 * already in flight (latest-wins). Uses the channel's sticky language to avoid
 * paying for LID on every partial.
 */
async function doPartial(pcm: Float32Array, channel: Channel): Promise<void> {
  if (!engine || transcribing || partialBusy || queue.length > 0 || shuttingDown) return;
  partialBusy = true;
  try {
    const lang = language === 'auto' ? routers[channel].currentLang : language;
    const r = await engine.transcribe(pcm, lang);
    if (!isJunkTranscript(r.text) && !transcribing) {
      post({ type: 'partial', speaker: channel, text: r.text });
    }
  } catch {
    /* partials are best-effort */
  } finally {
    partialBusy = false;
    void pump(); // a final may have queued while the partial was running
  }
}

async function pump(): Promise<void> {
  if (transcribing || partialBusy || !engine || shuttingDown) return;
  const seg = queue.shift();
  if (!seg) {
    const speaking = vads.them.state === 'speech' || vads.me.state === 'speech';
    post({ type: 'status', state: speaking ? 'speech' : 'listening', queuedSegments: 0 });
    return;
  }
  transcribing = true;
  post({ type: 'status', state: 'transcribing', queuedSegments: queue.length });
  const inferStartTs = Date.now();
  const audioMs = Math.round(seg.pcm.length / 16);

  // 'auto' = real zh/en LID (one decoder step) + sticky routing; an explicit
  // setting bypasses detection entirely.
  const router = routers[seg.speaker];
  let effLang: string = language;
  if (language === 'auto' && engine.detectZhEn) {
    let lid: LidResult | null = null;
    if (router.shouldRunLid(audioMs)) {
      try {
        const r = await engine.detectZhEn(seg.pcm);
        if (r) {
          lid = { lang: r.lang, margin: r.margin };
          console.log(`[worker] lid ${r.lang} margin=${r.margin.toFixed(2)} ${r.lidMs}ms`);
        }
      } catch (e) {
        console.warn(`[worker] lid failed: ${(e as Error).message}`);
      }
    }
    effLang = router.decide(audioMs, lid);
  }

  console.log(`[worker] transcribe start speaker=${seg.speaker} audio=${audioMs}ms lang=${effLang}`);
  try {
    const r = await engine.transcribe(seg.pcm, effLang);
    const inferEndTs = Date.now();
    console.log(
      `[worker] seg audio=${audioMs}ms lang=${effLang} infer=${inferEndTs - inferStartTs}ms raw=${JSON.stringify(r.text.slice(0, 80))}`,
    );
    if (process.env.MC_DEBUG_DUMP === '1') {
      const { writeFileSync } = await import('fs');
      writeFileSync(`${process.env.TEMP}/mc-seg-${Date.now()}.f32`, Buffer.from(seg.pcm.buffer, seg.pcm.byteOffset, seg.pcm.byteLength));
    }
    if (!isJunkTranscript(r.text)) {
      post({
        type: 'segment',
        id: ++segCounter,
        text: r.text,
        lang: r.lang ?? (effLang === 'auto' ? undefined : effLang),
        speaker: seg.speaker,
        audioMs,
        speechStartTs: seg.startTs,
        speechEndTs: seg.endTs,
        vadCloseTs: seg.vadCloseTs,
        inferStartTs,
        inferEndTs,
      });
    }
  } catch (e) {
    post({ type: 'error', message: `transcribe failed: ${(e as Error).message}`, fatal: false });
  } finally {
    lastInferTs = Date.now();
    transcribing = false;
    void pump();
  }
}

listen((msg: WorkerInMessage) => {
  switch (msg.type) {
    case 'init':
      void handleInit(msg);
      break;
    case 'pcm': {
      if (!engine) break;
      // serializers may deliver the payload as ArrayBuffer/Uint8Array
      const pcm =
        msg.pcm instanceof Float32Array
          ? msg.pcm
          : new Float32Array(
              (msg.pcm as unknown as ArrayBufferView).buffer ?? (msg.pcm as unknown as ArrayBuffer),
            );
      const ch: Channel = msg.channel === 'me' ? 'me' : 'them';
      const se = streamEngineFor(ch);
      if (se) handleStreamingPcm(pcm, ch, msg.captureTs, se);
      else handleVadEvents(vads[ch].push(pcm, msg.captureTs), ch);
      break;
    }
    case 'config':
      if (msg.language) language = msg.language;
      if (msg.liveTranslate !== undefined) setLiveTranslate(msg.liveTranslate);
      break;
    case 'flush':
      for (const ch of ['them', 'me'] as Channel[]) {
        if (streams[ch] || streamEngineFor(ch)) {
          vads[ch].flush();
          closeStream(ch);
        } else {
          handleVadEvents(vads[ch].flush(), ch);
        }
      }
      if (engine && isStreamingEngine(engine)) post({ type: 'status', state: 'listening', queuedSegments: 0 });
      break;
    case 'shutdown':
      shuttingDown = true;
      queue = [];
      closeStream('them');
      closeStream('me');
      setImmediate(() => process.exit(0));
      break;
  }
});

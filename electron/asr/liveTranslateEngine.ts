/**
 * Live speech translation engine (Alibaba Cloud Model Studio
 * `qwen3.8-livetranslate-flash-realtime`): one duplex WebSocket returns the
 * original-language transcript AND its translation, sentence by sentence.
 * The worker uses it for the 对方 channel while 实时翻译 is on.
 *
 * Protocol (Model Studio "实时音视频翻译" Realtime API, OpenAI-realtime style):
 *   client: session.update → input_audio_buffer.append (base64 pcm16) … → session.finish
 *   server: session.created → session.updated
 *           input_audio_buffer.speech_started / speech_stopped   (item_id, audio_*_ms)
 *           conversation.item.input_audio_transcription.delta / .completed  (source text)
 *           conversation.item.created  (translation item; previous_item_id = source item)
 *           response.text.delta / .done                         (translation text)
 *           response.done … session.finished | error
 * Deltas are incremental fragments; `.completed` / `.done` carry the full text.
 * Output is text only (`output_modalities: ["text"]`): no dubbed audio is
 * generated, which is also what is billed.
 *
 * Endpoint: wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=…
 * Auth: `Authorization: Bearer <key>` on the handshake (needs the `ws` package).
 */
import WebSocket from 'ws';
import { f32ToPcm16 } from './aliyunRealtimeEngine';
import type {
  AsrEngine,
  StreamingAsrEngine,
  StreamingSentence,
  StreamingSession,
  StreamingSessionCallbacks,
  TranscribeResult,
} from './engine';

export interface LiveTranslateConfig {
  /** full realtime URL incl. ?model= (shared/liveTranslate.ts liveTranslateUrl) */
  url: string;
  apiKey: string;
  /** target language code, e.g. 'zh' */
  target: string;
}

/** server event fields this engine reads (qwen3.8; qwen3.5 `.text` variants tolerated) */
export interface LtServerEvent {
  type?: string;
  item_id?: string;
  previous_item_id?: string;
  audio_start_ms?: number;
  audio_end_ms?: number;
  delta?: string;
  text?: string;
  stash?: string;
  transcript?: string;
  language?: string;
  item?: { id?: string; role?: string };
  response?: { id?: string; status?: string; output?: { id?: string }[] };
  error?: { code?: string; message?: string; type?: string };
}

export function parseLtEvent(data: string): LtServerEvent | null {
  try {
    const j = JSON.parse(data) as LtServerEvent;
    return j && typeof j === 'object' && typeof j.type === 'string' ? j : null;
  } catch {
    return null;
  }
}

/** the session.update this engine sends (exported for tests) */
export function sessionUpdate(target: string): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      // text only: the translation as text, no synthesized speech
      output_modalities: ['text'],
      translation: { language: target },
    },
  };
}

// ---------------------------------------------------------------------------
// Pairing source sentences with their translations (pure; unit-tested)
// ---------------------------------------------------------------------------
//
// What the service does (measured 2026-10-09 against the live model): in its
// default `speaker_detection` mode ONE item spans a speaker's whole turn — a
// 15 s monologue was a single item that only completed after 2.5 s of
// silence. Inside it, text arrives in alternating bursts: a source chunk
// (ending in a whitespace delta, usually a sentence), then the translation of
// that chunk (usually ending in 。？！), then the next source chunk:
//   src "Good" " morning." " "   →  tr "早上好。"   →  src "Everyone" "." " "  →  tr "大家。" …
// A turn is therefore cut into transcript sentences at those boundaries: when
// a new source chunk starts right after a translation burst that began on a
// sentence-final source and itself ends sentence-final, everything so far is
// one aligned (source, translation) pair. If the translation lags a chunk
// behind, the boundary is not clean and the text simply stays in the open
// sentence until a clean one comes (or the turn ends) — never misaligned.

interface Utterance {
  srcId: string;
  order: number;
  startMs?: number;
  endMs?: number;
  /** audio position when the utterance was first seen (fallback start) */
  seenMs: number;
  /** all source text so far (concatenated deltas) */
  source: string;
  /** the service's final transcript of the whole turn */
  finalSource?: string;
  sourceDone: boolean;
  lang?: string;
  /** all translation text so far (concatenated deltas) */
  translation: string;
  finalTranslation?: string;
  translationDone: boolean;
  /** chars of `source` / `translation` already emitted as sentences */
  emittedSrc: number;
  emittedTr: number;
  /** audio ms where the open (not yet emitted) sentence began */
  segBeginMs?: number;
  /** audio ms of the latest source chunk end */
  lastCloseMs?: number;
  lastKind: 'src' | 'tr' | null;
  /** the current translation burst began right after a sentence-final source chunk */
  burstAfterClose: boolean;
  /** wallclock of the first done event (source or translation) */
  halfDoneAt?: number;
  lastActivity: number;
  emitted: boolean;
}

export interface AssemblerCallbacks {
  onPartial(text: string, translation: string): void;
  onSentence(s: StreamingSentence): void;
}

/** how long a turn whose source (or translation) is final waits for the other half */
export const PAIR_GRACE_MS = 4000;
/** a turn with no progress for this long is emitted (or dropped if empty) */
export const STALL_MS = 10_000;

/** source chunk that ends a sentence: terminal punctuation, then the chunk's trailing space */
const SOURCE_SENTENCE_END = /[.!?。！？…;；]["'”’)\]）」』]*\s+$/;
/** translation that ends a sentence */
const TRANSLATION_SENTENCE_END = /[.!?。！？…;；]["'”’)\]）」』]*\s*$/;

/** the part of `final` not yet emitted, given the emitted prefix of `acc` */
function remainder(final: string | undefined, acc: string, emitted: number): string {
  if (final === undefined) return acc.slice(emitted);
  const prefix = acc.slice(0, emitted);
  return final.startsWith(prefix) ? final.slice(prefix.length) : acc.slice(emitted);
}

export class LiveTranslateAssembler {
  private utts = new Map<string, Utterance>();
  /** translation item id → source item id */
  private transToSrc = new Map<string, string>();
  private order = 0;
  private ticker: NodeJS.Timeout | null = null;

  constructor(
    private readonly cb: AssemblerCallbacks,
    /** current audio position in ms (relative to the session's first sample) */
    private readonly audioNow: () => number,
  ) {}

  private utt(srcId: string): Utterance {
    let u = this.utts.get(srcId);
    if (!u) {
      u = {
        srcId,
        order: this.order++,
        seenMs: this.audioNow(),
        source: '',
        sourceDone: false,
        translation: '',
        translationDone: false,
        emittedSrc: 0,
        emittedTr: 0,
        lastKind: null,
        burstAfterClose: false,
        lastActivity: Date.now(),
        emitted: false,
      };
      this.utts.set(srcId, u);
      this.ensureTicker();
    }
    u.lastActivity = Date.now();
    return u;
  }

  /** the utterance a translation item belongs to */
  private uttForTranslation(itemId: string | undefined): Utterance | null {
    if (itemId && this.transToSrc.has(itemId)) {
      const u = this.utts.get(this.transToSrc.get(itemId)!);
      if (u) {
        u.lastActivity = Date.now();
        return u;
      }
      return null; // already emitted and pruned: a late fragment, ignore
    }
    // unmapped (no conversation.item.created seen): the oldest turn still
    // waiting for a translation; turns are translated in speaking order
    let pick: Utterance | null = null;
    for (const u of this.utts.values()) {
      if (u.emitted || u.translationDone) continue;
      if (!pick || u.order < pick.order) pick = u;
    }
    if (!pick) pick = this.utt(`translation:${itemId ?? this.order}`);
    if (itemId) this.transToSrc.set(itemId, pick.srcId);
    pick.lastActivity = Date.now();
    return pick;
  }

  private sourceDelta(u: Utterance, delta: string): void {
    if (u.lastKind === 'tr') this.maybeSplit(u);
    u.source += delta;
    u.lastKind = 'src';
    if (/\s$/.test(delta)) u.lastCloseMs = this.audioNow();
    this.partial(u);
  }

  private translationDelta(u: Utterance, delta: string): void {
    if (u.lastKind !== 'tr') {
      u.burstAfterClose = SOURCE_SENTENCE_END.test(u.source.slice(u.emittedSrc));
    }
    u.translation += delta;
    u.lastKind = 'tr';
    this.partial(u);
  }

  /** a clean (source, translation) sentence boundary inside a long turn */
  private maybeSplit(u: Utterance): void {
    const src = u.source.slice(u.emittedSrc);
    const tr = u.translation.slice(u.emittedTr);
    if (!u.burstAfterClose || !src.trim() || !TRANSLATION_SENTENCE_END.test(tr)) return;
    const beginMs = u.segBeginMs ?? u.startMs ?? u.seenMs;
    const endMs = Math.max(beginMs, u.lastCloseMs ?? this.audioNow());
    this.cb.onSentence({ text: src.trim(), translation: tr.trim() || undefined, beginMs, endMs, lang: u.lang });
    u.emittedSrc = u.source.length;
    u.emittedTr = u.translation.length;
    u.segBeginMs = endMs;
  }

  handle(ev: LtServerEvent): void {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        if (ev.item_id) {
          const u = this.utt(ev.item_id);
          if (typeof ev.audio_start_ms === 'number') u.startMs = ev.audio_start_ms;
        }
        break;
      case 'input_audio_buffer.speech_stopped':
        if (ev.item_id) {
          const u = this.utt(ev.item_id);
          if (typeof ev.audio_end_ms === 'number') u.endMs = ev.audio_end_ms;
        }
        break;
      case 'conversation.item.created':
        // only the translation item points back at its source item
        if (ev.item?.id && ev.previous_item_id && ev.item.role === 'assistant') {
          this.transToSrc.set(ev.item.id, ev.previous_item_id);
          this.utt(ev.previous_item_id);
        }
        break;
      case 'conversation.item.input_audio_transcription.delta':
        if (ev.item_id && ev.delta) {
          const u = this.utt(ev.item_id);
          if (!u.emitted) this.sourceDelta(u, ev.delta);
        }
        break;
      case 'conversation.item.input_audio_transcription.text':
        // qwen3.5 shape: the whole text so far (confirmed `text` + provisional `stash`)
        if (ev.item_id) {
          const u = this.utt(ev.item_id);
          const whole = (ev.text ?? '') + (ev.stash ?? '');
          if (!u.emitted && whole.length >= u.emittedSrc) {
            u.source = whole;
            this.partial(u);
          }
        }
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.item_id) {
          const u = this.utt(ev.item_id);
          if (typeof ev.transcript === 'string') u.finalSource = ev.transcript;
          if (ev.language) u.lang = ev.language;
          u.sourceDone = true;
          u.halfDoneAt ??= Date.now();
          this.flushReady();
        }
        break;
      case 'conversation.item.input_audio_transcription.failed':
        if (ev.item_id) {
          const u = this.utt(ev.item_id);
          u.sourceDone = true;
          u.halfDoneAt ??= Date.now();
          this.flushReady();
        }
        break;
      case 'response.text.delta':
      case 'response.audio_transcript.delta': {
        const u = ev.delta ? this.uttForTranslation(ev.item_id) : null;
        if (u && !u.emitted) this.translationDelta(u, ev.delta!);
        break;
      }
      case 'response.text.text':
      case 'response.audio_transcript.text': {
        const u = this.uttForTranslation(ev.item_id);
        const whole = (ev.text ?? '') + (ev.stash ?? '');
        if (u && !u.emitted && whole.length >= u.emittedTr) {
          u.translation = whole;
          this.partial(u);
        }
        break;
      }
      case 'response.text.done':
      case 'response.audio_transcript.done': {
        const u = this.uttForTranslation(ev.item_id);
        if (u && !u.emitted) {
          const full = ev.text ?? ev.transcript;
          if (typeof full === 'string') u.finalTranslation = full;
          u.translationDone = true;
          u.halfDoneAt ??= Date.now();
          this.flushReady();
        }
        break;
      }
      case 'response.done':
        for (const item of ev.response?.output ?? []) {
          const src = item.id ? this.transToSrc.get(item.id) : undefined;
          const u = src ? this.utts.get(src) : undefined;
          if (u && !u.emitted && !u.translationDone) {
            u.translationDone = true;
            u.halfDoneAt ??= Date.now();
          }
        }
        this.flushReady();
        break;
      default:
        break;
    }
  }

  /** the live bubble shows only the open sentence of a turn */
  private partial(u: Utterance): void {
    const text = u.source.slice(u.emittedSrc).trim();
    const translation = u.translation.slice(u.emittedTr).trim();
    if (text || translation) this.cb.onPartial(text, translation);
  }

  private pending(): Utterance[] {
    return [...this.utts.values()].filter((u) => !u.emitted).sort((a, b) => a.order - b.order);
  }

  /**
   * Emit finished turns IN SPEAKING ORDER: a turn goes out when both halves
   * are final, or one half is final and the other has had PAIR_GRACE_MS to
   * arrive, or it stalled. `force` empties the queue.
   */
  flushReady(force = false): void {
    const now = Date.now();
    let emittedAny = false;
    for (const u of this.pending()) {
      const stalled = now - u.lastActivity >= STALL_MS;
      const empty = !u.source.trim() && !u.translation.trim() && !u.sourceDone && !u.translationDone;
      if (empty) {
        // speech detected but nothing recognized yet: never hold later
        // turns back for it; drop it once it goes quiet
        if (force || stalled) u.emitted = true;
        continue;
      }
      const both = u.sourceDone && u.translationDone;
      const graceOver = u.halfDoneAt !== undefined && now - u.halfDoneAt >= PAIR_GRACE_MS;
      if (!(force || both || graceOver || stalled)) break; // keep order: wait for the head
      this.emit(u);
      emittedAny = true;
    }
    if (emittedAny) {
      // the live bubble was replaced by the finals; show what is still open
      const open = this.pending().filter(
        (u) => u.source.slice(u.emittedSrc).trim() || u.translation.slice(u.emittedTr).trim(),
      );
      if (open.length) this.partial(open[open.length - 1]);
    }
    this.prune();
    if (!this.pending().length) this.stopTicker();
  }

  /** the rest of a finished turn (after any sentences already split off) */
  private emit(u: Utterance): void {
    u.emitted = true;
    let text = remainder(u.finalSource, u.source, u.emittedSrc).trim();
    let translation = remainder(u.finalTranslation, u.translation, u.emittedTr).trim();
    if (!text && !translation) return; // noise, or everything was already emitted
    if (!text) {
      // the recognition half never came: keep what was said, untranslated
      text = translation;
      translation = '';
    }
    const beginMs = u.segBeginMs ?? u.startMs ?? u.seenMs;
    const endMs = Math.max(beginMs, u.endMs ?? this.audioNow());
    this.cb.onSentence({ text, beginMs, endMs, translation: translation || undefined, lang: u.lang });
  }

  /** drop emitted turns (late fragments for them are ignored) */
  private prune(): void {
    for (const [id, u] of this.utts) if (u.emitted) this.utts.delete(id);
    if (this.transToSrc.size > 200) {
      for (const [tid, sid] of this.transToSrc) if (!this.utts.has(sid)) this.transToSrc.delete(tid);
    }
  }

  private ensureTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.flushReady(), 500);
    this.ticker.unref?.();
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /** end of session: emit everything that has text */
  dispose(): void {
    this.flushReady(true);
    this.stopTicker();
  }
}

// ---------------------------------------------------------------------------
// WebSocket session
// ---------------------------------------------------------------------------

const FINISH_TIMEOUT_MS = 15_000;
/** session.update goes out on session.created; this covers a server that skips it */
const UPDATE_FALLBACK_MS = 3000;
/** audio buffered before the session is live (100 ms frames): ~30 s */
const MAX_PENDING_FRAMES = 300;
const DEBUG = process.env.MC_DEBUG_LIVETRANSLATE === '1';

class LiveTranslateSession implements StreamingSession {
  private ws: WebSocket;
  private started = false;
  private dead = false;
  private updateSent = false;
  private finishRequested = false;
  private finishSent = false;
  private pending: string[] = [];
  private pushedSamples = 0;
  private lastServerError: string | null = null;
  private readonly assembler: LiveTranslateAssembler;
  private finishResolve: (() => void) | null = null;
  private finishPromise: Promise<void> | null = null;
  private finishTimer: NodeJS.Timeout | null = null;
  private updateTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: LiveTranslateConfig,
    private readonly cb: StreamingSessionCallbacks,
  ) {
    this.assembler = new LiveTranslateAssembler(
      {
        onPartial: (text, translation) => this.cb.onPartial(text, translation),
        onSentence: (s) => this.cb.onSentence(s),
      },
      () => Math.round(this.pushedSamples / 16),
    );
    this.ws = new WebSocket(cfg.url, {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      handshakeTimeout: 10_000,
    });

    this.ws.on('open', () => {
      this.updateTimer = setTimeout(() => this.sendUpdate(), UPDATE_FALLBACK_MS);
      this.updateTimer.unref?.();
    });

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const ev = parseLtEvent(data.toString());
      if (!ev) return;
      if (DEBUG && ev.type !== 'response.audio.delta') {
        console.log(`[livetranslate] <- ${JSON.stringify(ev).slice(0, 400)}`);
      }
      switch (ev.type) {
        case 'session.created':
          this.sendUpdate();
          break;
        case 'session.updated':
          if (this.dead || this.started) break;
          this.started = true;
          this.cb.onReady?.();
          for (const audio of this.pending) this.sendAudio(audio);
          this.pending = [];
          if (this.finishRequested) this.sendFinish();
          break;
        case 'error': {
          const msg = `${ev.error?.code ?? ev.error?.type ?? 'ERROR'}: ${ev.error?.message ?? 'request failed'}`;
          this.lastServerError = msg;
          if (!this.started) this.fail(msg);
          else console.warn(`[livetranslate] server error: ${msg}`);
          break;
        }
        case 'session.finished':
          this.assembler.dispose();
          this.dead = true;
          this.settleFinish();
          this.ws.close();
          break;
        default:
          if (!this.dead) this.assembler.handle(ev);
      }
    });

    this.ws.on('unexpected-response', (_req, res) => {
      // a refused upgrade (401 bad key, 403 model not enabled, 404 bad path):
      // keep the status and the start of the body, which names the reason
      let body = '';
      res.on('data', (chunk: Buffer) => {
        if (body.length < 600) body += chunk.toString();
      });
      const done = () => this.fail(`HTTP ${res.statusCode}${body.trim() ? `: ${body.trim().slice(0, 300)}` : ''}`);
      res.on('end', done);
      res.on('error', done);
      setTimeout(done, 1500).unref?.();
    });
    this.ws.on('error', (e) => this.fail(`ws error: ${e.message}`));
    this.ws.on('close', (code, reason) => {
      if (this.dead) return;
      const why = this.lastServerError ?? `connection closed (${code}${reason?.length ? ` ${reason.toString()}` : ''})`;
      this.fail(why);
    });
  }

  private sendUpdate(): void {
    if (this.updateSent || this.dead || this.ws.readyState !== WebSocket.OPEN) return;
    this.updateSent = true;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.ws.send(JSON.stringify(sessionUpdate(this.cfg.target)));
  }

  private sendAudio(b64: string): void {
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
  }

  private fail(message: string): void {
    if (this.dead) return;
    this.dead = true;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    // whatever was already recognized still reaches the transcript
    if (this.started) this.assembler.dispose();
    this.settleFinish();
    try {
      this.ws.terminate();
    } catch {
      /* already closed */
    }
    this.cb.onError(message);
  }

  private settleFinish(): void {
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
    const r = this.finishResolve;
    this.finishResolve = null;
    r?.();
  }

  push(pcm: Float32Array): void {
    if (this.dead || this.finishRequested || pcm.length === 0) return;
    const b64 = f32ToPcm16(pcm).toString('base64');
    if (this.started && this.ws.readyState === WebSocket.OPEN) {
      this.pushedSamples += pcm.length;
      this.sendAudio(b64);
    } else {
      // audio time starts with the first sample the service will receive
      this.pushedSamples += pcm.length;
      this.pending.push(b64);
      if (this.pending.length > MAX_PENDING_FRAMES) this.pending.shift();
    }
  }

  private sendFinish(): void {
    if (this.finishSent || this.dead || !this.started || this.ws.readyState !== WebSocket.OPEN) return;
    this.finishSent = true;
    this.ws.send(JSON.stringify({ type: 'session.finish' }));
  }

  close(): Promise<void> {
    if (this.dead) return Promise.resolve();
    if (this.finishPromise) return this.finishPromise;
    if (!this.started && this.pending.length === 0) {
      this.dead = true;
      if (this.updateTimer) clearTimeout(this.updateTimer);
      this.ws.terminate();
      return Promise.resolve();
    }
    this.finishRequested = true;
    this.finishPromise = new Promise<void>((resolve) => {
      this.finishResolve = resolve;
    });
    this.finishTimer = setTimeout(() => {
      this.fail(this.started ? 'timed out waiting for session.finished' : 'timed out waiting for session.updated');
    }, FINISH_TIMEOUT_MS);
    this.finishTimer.unref?.();
    this.sendFinish();
    return this.finishPromise;
  }
}

export class LiveTranslateEngine implements StreamingAsrEngine, AsrEngine {
  readonly ep = 'cloud-lt';
  readonly streaming = true as const;
  readonly loadMs = 0;
  warmMs = 0;
  readonly lidAvailable = false;

  private constructor(private readonly cfg: LiveTranslateConfig) {}

  static async load(cfg: LiveTranslateConfig): Promise<LiveTranslateEngine> {
    if (!cfg.url) throw new Error('live translation is not configured (needs the realtime URL)');
    if (!/^wss?:\/\//.test(cfg.url)) {
      throw new Error(`live translation URL must start with ws:// or wss:// (got: ${cfg.url})`);
    }
    if (/^wss:\/\//.test(cfg.url) && !cfg.apiKey) throw new Error('live translation requires an API key');
    return new LiveTranslateEngine({ ...cfg, target: cfg.target || 'zh' });
  }

  async warmup(): Promise<number> {
    return 0;
  }

  /** the source language is detected by the service; `opts.language` is ignored */
  openSession(cb: StreamingSessionCallbacks): StreamingSession {
    return new LiveTranslateSession(this.cfg, cb);
  }

  /** one-shot path (connection checks / harness): stream the clip, join the sentences */
  async transcribe(pcm: Float32Array): Promise<TranscribeResult> {
    const t0 = Date.now();
    const parts: string[] = [];
    let err: string | null = null;
    const session = this.openSession({
      onPartial: () => undefined,
      onSentence: (s) => parts.push(s.translation ? `${s.text} → ${s.translation}` : s.text),
      onError: (m) => {
        err = m;
      },
    });
    const CHUNK = 1600;
    for (let off = 0; off < pcm.length; off += CHUNK) session.push(pcm.subarray(off, Math.min(off + CHUNK, pcm.length)));
    await session.close();
    if (err && parts.length === 0) throw new Error(err);
    return { text: parts.join(' ').trim(), lang: undefined, inferMs: Date.now() - t0 };
  }
}

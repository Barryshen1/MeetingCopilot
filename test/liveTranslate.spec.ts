import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import {
  DEFAULT_LIVE_TRANSLATE_MODEL,
  liveTranslateUrl,
  normalizeLiveTranslate,
} from '../shared/liveTranslate';
import {
  LiveTranslateAssembler,
  LiveTranslateEngine,
  PAIR_GRACE_MS,
  STALL_MS,
  parseLtEvent,
  sessionUpdate,
  type LtServerEvent,
} from '../electron/asr/liveTranslateEngine';
import type { StreamingSentence } from '../electron/asr/engine';

describe('liveTranslateUrl', () => {
  it('turns the Model Studio ASR endpoint into the realtime endpoint', () => {
    expect(
      liveTranslateUrl(
        'wss://ws-abc123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference',
        DEFAULT_LIVE_TRANSLATE_MODEL,
      ),
    ).toBe(
      'wss://ws-abc123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime',
    );
    expect(liveTranslateUrl('wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference/', 'm')).toBe(
      'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=m',
    );
  });

  it('is unavailable for non-Aliyun or non-wss endpoints', () => {
    expect(liveTranslateUrl('ws://127.0.0.1:10097', 'm')).toBeNull();
    expect(liveTranslateUrl('wss://example.com/api-ws/v1/inference', 'm')).toBeNull();
    expect(liveTranslateUrl('wss://aliyuncs.com.evil.example/x', 'm')).toBeNull();
    expect(liveTranslateUrl('not a url', 'm')).toBeNull();
    expect(liveTranslateUrl(undefined, 'm')).toBeNull();
    expect(liveTranslateUrl('wss://x.aliyuncs.com/api-ws/v1/inference', '')).toBeNull();
  });
});

describe('normalizeLiveTranslate', () => {
  it('defaults to off, qwen3.8, Chinese', () => {
    expect(normalizeLiveTranslate(undefined)).toEqual({
      enabled: false,
      model: DEFAULT_LIVE_TRANSLATE_MODEL,
      target: 'zh',
    });
  });

  it('keeps valid values and repairs invalid ones', () => {
    expect(normalizeLiveTranslate({ enabled: true, model: ' m ', target: 'en' })).toEqual({
      enabled: true,
      model: 'm',
      target: 'en',
    });
    expect(normalizeLiveTranslate({ enabled: 'yes' as unknown as boolean, model: '', target: 'fr' as 'zh' })).toEqual({
      enabled: false,
      model: DEFAULT_LIVE_TRANSLATE_MODEL,
      target: 'zh',
    });
  });
});

describe('protocol helpers', () => {
  it('asks for text-only output in the target language', () => {
    expect(sessionUpdate('zh')).toEqual({
      type: 'session.update',
      session: { output_modalities: ['text'], translation: { language: 'zh' } },
    });
  });

  it('parses events and rejects garbage', () => {
    expect(parseLtEvent('{"type":"session.created"}')?.type).toBe('session.created');
    expect(parseLtEvent('{"no":"type"}')).toBeNull();
    expect(parseLtEvent('nope')).toBeNull();
  });
});

// ---- pairing ----

function harness() {
  const partials: [string, string][] = [];
  const sentences: StreamingSentence[] = [];
  let audioMs = 0;
  const asm = new LiveTranslateAssembler(
    {
      onPartial: (text, translation) => partials.push([text, translation]),
      onSentence: (s) => sentences.push(s),
    },
    () => audioMs,
  );
  const send = (...evs: LtServerEvent[]) => evs.forEach((e) => asm.handle(e));
  return {
    asm,
    partials,
    sentences,
    send,
    setAudio: (ms: number) => {
      audioMs = ms;
    },
  };
}

const started = (id: string, ms: number): LtServerEvent => ({
  type: 'input_audio_buffer.speech_started',
  item_id: id,
  audio_start_ms: ms,
});
const stopped = (id: string, ms: number): LtServerEvent => ({
  type: 'input_audio_buffer.speech_stopped',
  item_id: id,
  audio_end_ms: ms,
});
const srcDelta = (id: string, delta: string): LtServerEvent => ({
  type: 'conversation.item.input_audio_transcription.delta',
  item_id: id,
  delta,
});
const srcDone = (id: string, transcript: string): LtServerEvent => ({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: id,
  transcript,
  language: 'en',
});
const transItem = (src: string, id: string): LtServerEvent => ({
  type: 'conversation.item.created',
  previous_item_id: src,
  item: { id, role: 'assistant' },
});
const trDelta = (id: string, delta: string): LtServerEvent => ({ type: 'response.text.delta', item_id: id, delta });
const trDone = (id: string, text: string): LtServerEvent => ({ type: 'response.text.done', item_id: id, text });

describe('LiveTranslateAssembler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pairs a source sentence with its translation and streams partials', () => {
    const h = harness();
    h.send(
      started('a1', 500),
      srcDelta('a1', 'How are'),
      srcDelta('a1', ' you?'),
      transItem('a1', 't1'),
      trDelta('t1', '你'),
      trDelta('t1', '好吗？'),
      stopped('a1', 1800),
    );
    expect(h.partials.at(-1)).toEqual(['How are you?', '你好吗？']);
    expect(h.sentences).toHaveLength(0);
    h.send(srcDone('a1', 'How are you?'), trDone('t1', '你好吗？'));
    expect(h.sentences).toEqual([
      { text: 'How are you?', translation: '你好吗？', beginMs: 500, endMs: 1800, lang: 'en' },
    ]);
  });

  it('waits for the source when the translation finishes first', () => {
    const h = harness();
    h.send(started('a1', 0), srcDelta('a1', 'Hi'), transItem('a1', 't1'), trDone('t1', '嗨'));
    expect(h.sentences).toHaveLength(0);
    h.send(srcDone('a1', 'Hi there'));
    expect(h.sentences[0]).toMatchObject({ text: 'Hi there', translation: '嗨' });
  });

  it('emits in speaking order even when a later sentence completes first', () => {
    const h = harness();
    h.send(
      started('a1', 0),
      srcDone('a1', 'First.'),
      transItem('a1', 't1'),
      started('a2', 3000),
      srcDone('a2', 'Second.'),
      transItem('a2', 't2'),
      trDone('t2', '第二。'),
    );
    expect(h.sentences).toHaveLength(0); // a1 still waits for its translation
    h.send(trDone('t1', '第一。'));
    expect(h.sentences.map((s) => s.translation)).toEqual(['第一。', '第二。']);
  });

  it('gives up waiting for a missing half after the grace period', () => {
    const h = harness();
    h.send(started('a1', 0), srcDone('a1', 'Lonely sentence.'));
    vi.advanceTimersByTime(PAIR_GRACE_MS + 600);
    expect(h.sentences).toEqual([{ text: 'Lonely sentence.', translation: undefined, beginMs: 0, endMs: 0, lang: 'en' }]);
  });

  it('attaches an unmapped translation to the oldest waiting sentence', () => {
    const h = harness();
    h.send(started('a1', 0), srcDone('a1', 'One.'), trDelta('x9', '一'), trDone('x9', '一。'));
    expect(h.sentences[0]).toMatchObject({ text: 'One.', translation: '一。' });
  });

  it('does not let a speech start with no text block later sentences', () => {
    const h = harness();
    h.send(started('ghost', 0), started('a1', 100), srcDone('a1', 'Real.'), transItem('a1', 't1'), trDone('t1', '真的。'));
    expect(h.sentences.map((s) => s.text)).toEqual(['Real.']);
    vi.advanceTimersByTime(STALL_MS + 600); // the ghost is dropped silently
    expect(h.sentences).toHaveLength(1);
  });

  it('ignores user items in conversation.item.created', () => {
    const h = harness();
    h.send(
      started('a1', 0),
      srcDone('a1', 'One.'),
      transItem('a1', 't1'),
      trDone('t1', '一。'),
      // the next source item points back at the previous translation item
      { type: 'conversation.item.created', previous_item_id: 't1', item: { id: 'a2', role: 'user' } },
      started('a2', 2000),
      srcDone('a2', 'Two.'),
      transItem('a2', 't2'),
      trDone('t2', '二。'),
    );
    expect(h.sentences.map((s) => [s.text, s.translation])).toEqual([
      ['One.', '一。'],
      ['Two.', '二。'],
    ]);
  });

  it('cuts a long turn into aligned sentences at clean boundaries (recorded service pattern)', () => {
    const h = harness();
    h.send(started('a1', 0), { type: 'conversation.item.created', item: { id: 'a1', role: 'assistant' } });
    h.send(transItem('a1', 't1'));
    const at = (ms: number) => h.setAudio(ms);
    at(900);
    h.send(srcDelta('a1', 'Good'), srcDelta('a1', ' morning.'), srcDelta('a1', ' '), trDelta('t1', '早上好。'));
    expect(h.sentences).toHaveLength(0);
    expect(h.partials.at(-1)).toEqual(['Good morning.', '早上好。']);
    at(1500);
    h.send(srcDelta('a1', 'Everyone'), srcDelta('a1', '.'), srcDelta('a1', ' '), trDelta('t1', '大家。'));
    expect(h.sentences).toEqual([
      { text: 'Good morning.', translation: '早上好。', beginMs: 0, endMs: 900, lang: undefined },
    ]);
    // the live bubble now shows only the open sentence
    expect(h.partials.at(-1)).toEqual(['Everyone.', '大家。']);
    at(4000);
    h.send(srcDelta('a1', 'Today I'), srcDelta('a1', ' want to go over the results.'), srcDelta('a1', ' '));
    h.send(trDelta('t1', '今天，'), trDelta('t1', '我想回顾一下结果。'));
    at(6000);
    h.send(srcDelta('a1', 'Questions'), srcDelta('a1', '? '), trDelta('t1', '有问题吗？'));
    h.send(stopped('a1', 6500));
    h.send(srcDone('a1', 'Good morning. Everyone. Today I want to go over the results. Questions?'));
    h.send(trDone('t1', '早上好。大家。今天，我想回顾一下结果。有问题吗？'));
    expect(h.sentences.map((s) => [s.text, s.translation, s.beginMs, s.endMs])).toEqual([
      ['Good morning.', '早上好。', 0, 900],
      ['Everyone.', '大家。', 900, 1500],
      ['Today I want to go over the results.', '今天，我想回顾一下结果。', 1500, 4000],
      ['Questions?', '有问题吗？', 4000, 6500],
    ]);
  });

  it('never splits where the translation is a chunk behind', () => {
    const h = harness();
    h.send(started('a1', 0), transItem('a1', 't1'));
    // source runs ahead: the second chunk starts before the first is translated
    h.send(srcDelta('a1', 'First point. '), srcDelta('a1', 'Second'));
    h.send(trDelta('t1', '第一点。'));
    h.send(srcDelta('a1', ' point. ')); // burst began mid-chunk → no cut here
    expect(h.sentences).toHaveLength(0);
    h.send(trDelta('t1', '第二点。'), srcDelta('a1', 'Third'));
    expect(h.sentences.map((s) => [s.text, s.translation])).toEqual([
      ['First point. Second point.', '第一点。第二点。'],
    ]);
  });

  it('does not cut on a translation that ends mid-sentence', () => {
    const h = harness();
    h.send(started('a1', 0), transItem('a1', 't1'));
    h.send(srcDelta('a1', 'When we started, '), trDelta('t1', '当我们开始时，'), srcDelta('a1', 'nothing worked. '));
    expect(h.sentences).toHaveLength(0);
  });

  it('dispose flushes whatever has text', () => {
    const h = harness();
    h.setAudio(900);
    h.send(srcDelta('a1', 'Cut off mid'));
    h.asm.dispose();
    expect(h.sentences).toEqual([{ text: 'Cut off mid', translation: undefined, beginMs: 900, endMs: 900, lang: undefined }]);
  });
});

// ---- WebSocket session against a local fake service ----

interface Fake {
  url: string;
  received: Record<string, unknown>[];
  close(): Promise<void>;
}

async function fakeService(onMessage: (sock: ServerSocket, msg: Record<string, unknown>) => void, status = 101): Promise<Fake> {
  const received: Record<string, unknown>[] = [];
  const http: Server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{"code":"InvalidApiKey","message":"Invalid API-key provided."}');
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    if (status !== 101) {
      socket.write(`HTTP/1.1 ${status} Unauthorized\r\ncontent-type: application/json\r\ncontent-length: 64\r\n\r\n`);
      socket.write('{"code":"InvalidApiKey","message":"Invalid API-key provided."}  ');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'session.created', session: { id: 's1' } }));
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(msg);
        onMessage(ws, msg);
      });
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/api-ws/v1/realtime?model=m`,
    received,
    close: () =>
      new Promise<void>((r) => {
        wss.close();
        http.close(() => r());
        http.closeAllConnections?.();
      }),
  };
}

describe('LiveTranslateEngine session', () => {
  let fake: Fake | null = null;
  afterEach(async () => {
    await fake?.close();
    fake = null;
  });

  it('configures the session, streams audio and returns paired sentences', async () => {
    let appends = 0;
    fake = await fakeService((ws, msg) => {
      if (msg.type === 'session.update') {
        ws.send(JSON.stringify({ type: 'session.updated' }));
      } else if (msg.type === 'input_audio_buffer.append') {
        appends++;
        if (appends === 3) {
          const evs: LtServerEvent[] = [
            started('a1', 0),
            srcDelta('a1', 'Good morning'),
            transItem('a1', 't1'),
            trDelta('t1', '早上好'),
            stopped('a1', 300),
            srcDone('a1', 'Good morning.'),
            trDone('t1', '早上好。'),
          ];
          for (const e of evs) ws.send(JSON.stringify(e));
        }
      } else if (msg.type === 'session.finish') {
        ws.send(JSON.stringify({ type: 'session.finished' }));
      }
    });
    const engine = await LiveTranslateEngine.load({ url: fake.url, apiKey: '', target: 'zh' });
    const sentences: StreamingSentence[] = [];
    const partials: string[] = [];
    let ready = false;
    const errors: string[] = [];
    const session = engine.openSession({
      onReady: () => {
        ready = true;
      },
      onPartial: (text, translation) => partials.push(`${text}|${translation}`),
      onSentence: (s) => sentences.push(s),
      onError: (m) => errors.push(m),
    });
    // pushed before the session is live: buffered, then flushed in order
    for (let i = 0; i < 3; i++) session.push(new Float32Array(1600).fill(0.1));
    await vi.waitFor(() => expect(sentences).toHaveLength(1), { timeout: 3000 });
    await session.close();

    expect(ready).toBe(true);
    expect(errors).toEqual([]);
    expect(fake.received[0]).toEqual(sessionUpdate('zh'));
    const append = fake.received.find((m) => m.type === 'input_audio_buffer.append')!;
    expect(Buffer.from(append.audio as string, 'base64').length).toBe(3200); // 100 ms pcm16
    expect(fake.received.at(-1)).toEqual({ type: 'session.finish' });
    expect(partials).toContain('Good morning|早上好');
    expect(sentences[0]).toMatchObject({ text: 'Good morning.', translation: '早上好。', beginMs: 0, endMs: 300 });
  });

  it('reports a service error before the session is live', async () => {
    fake = await fakeService((ws, msg) => {
      if (msg.type === 'session.update') {
        ws.send(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', code: 'AccessDenied', message: 'Model not activated' },
          }),
        );
      }
    });
    const engine = await LiveTranslateEngine.load({ url: fake.url, apiKey: '', target: 'zh' });
    const errors: string[] = [];
    engine.openSession({ onPartial: () => {}, onSentence: () => {}, onError: (m) => errors.push(m) });
    await vi.waitFor(() => expect(errors).toEqual(['AccessDenied: Model not activated']), { timeout: 3000 });
  });

  it('reports a refused handshake with its HTTP status and reason', async () => {
    fake = await fakeService(() => {}, 401);
    const engine = await LiveTranslateEngine.load({ url: fake.url, apiKey: '', target: 'zh' });
    const errors: string[] = [];
    engine.openSession({ onPartial: () => {}, onSentence: () => {}, onError: (m) => errors.push(m) });
    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 3000 });
    expect(errors[0]).toMatch(/^HTTP 401/);
    expect(errors[0]).toContain('InvalidApiKey');
  });

  it('requires a key for wss endpoints', async () => {
    await expect(
      LiveTranslateEngine.load({ url: 'wss://x.aliyuncs.com/api-ws/v1/realtime?model=m', apiKey: '', target: 'zh' }),
    ).rejects.toThrow(/API key/);
  });
});

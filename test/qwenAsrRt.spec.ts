import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { AliyunRealtimeEngine } from '../electron/asr/aliyunRealtimeEngine';

describe('Qwen-Audio 3.1 DashScope WebSocket', () => {
  let server: WebSocketServer | null = null;

  async function listen(): Promise<string> {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    if (!server) return;
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it('flushes an early-close clip after task-started and receives the final result', async () => {
    const url = await listen();
    const wire: Array<'run-task' | 'audio' | 'finish-task'> = [];
    const partials: string[] = [];
    const finals: string[] = [];
    const errors: string[] = [];
    let authorization: string | undefined;
    let runTask: any;
    let audio: Buffer | undefined;

    server!.on('connection', (ws, request) => {
      authorization = request.headers.authorization;
      ws.on('message', (frame, isBinary) => {
        if (isBinary) {
          wire.push('audio');
          audio = Buffer.from(frame as Buffer);
          return;
        }
        const task = JSON.parse(frame.toString());
        const action = task.header.action as 'run-task' | 'finish-task';
        wire.push(action);
        if (action === 'run-task') {
          runTask = task;
          setTimeout(() => {
            ws.send(JSON.stringify({ header: { event: 'task-started', task_id: task.header.task_id }, payload: {} }));
          }, 20);
        } else {
          const header = { event: 'result-generated', task_id: task.header.task_id };
          ws.send(JSON.stringify({ header, payload: { output: { sentence: { text: 'Hello', sentence_end: false } } } }));
          ws.send(JSON.stringify({ header, payload: { output: { sentence: {
            text: 'Hello, world.', begin_time: 0, end_time: 400, sentence_end: true,
          } } } }));
          ws.send(JSON.stringify({ header: { event: 'task-finished', task_id: task.header.task_id }, payload: {} }));
        }
      });
    });

    const engine = await AliyunRealtimeEngine.load({
      baseUrl: url,
      model: 'qwen-audio-3.1-asr-flash-streaming',
      apiKey: 'sk-mock',
    });
    const session = engine.openSession({
      onPartial: (text) => partials.push(text),
      onSentence: (sentence) => finals.push(`${sentence.text}:${sentence.endMs}`),
      onError: (message) => errors.push(message),
    }, { language: 'auto' });
    session.push(new Float32Array([0, 0.5, -0.5]));
    await session.close();

    expect(authorization).toBe('Bearer sk-mock');
    expect(wire).toEqual(['run-task', 'audio', 'finish-task']);
    expect(runTask.header.streaming).toBe('duplex');
    expect(runTask.payload).toMatchObject({
      task_group: 'audio', task: 'asr', function: 'recognition',
      model: 'qwen-audio-3.1-asr-flash-streaming',
      parameters: { format: 'pcm', sample_rate: 16000 },
    });
    expect(runTask.payload.parameters.language_hints).toBeUndefined();
    expect(audio?.readInt16LE(2)).toBe(0x3fff);
    expect(partials).toEqual(['Hello']);
    expect(finals).toEqual(['Hello, world.:400']);
    expect(errors).toEqual([]);
  });

  it('reports a socket closed before task-finished', async () => {
    const url = await listen();
    server!.on('connection', (ws) => {
      ws.once('message', () => ws.close());
    });
    const engine = await AliyunRealtimeEngine.load({
      baseUrl: url,
      model: 'qwen-audio-3.1-asr-flash-streaming',
      apiKey: 'sk-mock',
    });
    const error = new Promise<string>((resolve) => {
      engine.openSession({
        onPartial: () => undefined,
        onSentence: () => undefined,
        onError: resolve,
      });
    });
    await expect(error).resolves.toContain('connection closed before task-finished');
  });
});

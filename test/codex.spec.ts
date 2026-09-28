import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexClient, discoverCodexBinary } from '../electron/llm/codex';
import type { ChatMessage } from '../electron/llm/adapter';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

type Message = { id?: number; method?: string; params?: any; error?: any };

/** A real byte-stream peer: exercises JSONL framing, request IDs and event ordering. */
class FakeCodex extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  requests: Message[] = [];
  kill = vi.fn(() => { queueMicrotask(() => this.emit('close')); return true; });
  nextThread = 0;
  handler?: (message: Message) => boolean | void;

  constructor() {
    super();
    let buffer = '';
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, index)) as Message;
        buffer = buffer.slice(index + 1);
        this.requests.push(request);
        queueMicrotask(() => this.respond(request));
      }
      callback();
    } });
  }

  send(message: any) {
    const line = JSON.stringify(message) + '\r\n';
    // Deliberately split frames in the middle of a JSON property.
    this.stdout.write(line.slice(0, 9));
    this.stdout.write(line.slice(9));
  }

  response(request: Message, result: any) { this.send({ id: request.id, result }); }

  private respond(request: Message) {
    if (this.handler?.(request)) return;
    if (request.id === undefined || !request.method) return;
    if (request.method === 'initialize') this.response(request, { userAgent: 'fake' });
    else if (request.method === 'account/read') this.response(request, { account: { type: 'chatgpt', email: 'never-return-this@example.test' }, requiresOpenaiAuth: true });
    else if (request.method === 'model/list') this.response(request, { data: [
      { id: 'catalog-row', model: 'available-model', displayName: 'Available Model', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }] },
    ], nextCursor: null });
    else if (request.method === 'config/read') this.response(request, { config: { mcp_servers: { inherited_server: { enabled: true, command: 'should-never-run' } } } });
    else if (request.method === 'thread/start') this.response(request, { thread: { id: `thread-${++this.nextThread}` } });
    else if (request.method === 'turn/start') {
      const threadId = request.params.threadId;
      const turnId = `turn-${threadId}`;
      this.response(request, { turn: { id: turnId, status: 'inProgress' } });
      queueMicrotask(() => this.complete(threadId, turnId));
    } else this.response(request, {});
  }

  complete(threadId: string, turnId = `turn-${threadId}`, answer = '你好 there') {
    const itemId = `answer-${threadId}`;
    this.send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta: answer.slice(0, 2) } });
    this.send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta: answer.slice(2) } });
    this.send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: answer } } });
    this.send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
  }
}

describe('Codex CLI integration', () => {
  let cwd: string;
  let client: CodexClient;
  let peers: FakeCodex[];
  const config = { binaryPath: process.execPath, model: 'available-model', reasoningEffort: 'low' as const };
  const question: ChatMessage[] = [{ role: 'user', content: 'Hello' }];

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'meetingcopilot-codex-'));
    peers = [];
    spawnMock.mockReset().mockImplementation(() => {
      const peer = new FakeCodex();
      // The first process only initializes app-owned SQLite using an empty home.
      if (spawnMock.mock.calls.at(-1)?.[2]?.env?.CODEX_HOME?.endsWith(`${path.sep}bootstrap`)) return peer;
      peers.push(peer);
      return peer as unknown as ChildProcessWithoutNullStreams;
    });
    client = new CodexClient({ cwd });
  });

  afterEach(async () => {
    await client.dispose();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await rm(cwd, { recursive: true, force: true });
  });

  it('reports missing executables without starting a process', async () => {
    await expect(discoverCodexBinary(path.join(cwd, 'missing-codex'))).rejects.toThrow('not found');
    const status = await client.check({ binaryPath: path.join(cwd, 'missing-codex') });
    expect(status).toMatchObject({ installed: false, authenticated: false, models: [] });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('handshakes once, lists account models, and does not expose account details', async () => {
    const [one, two] = await Promise.all([client.check(config), client.check(config)]);
    expect(one).toEqual(two);
    expect(one).toMatchObject({ installed: true, authenticated: true, accountType: 'chatgpt', models: [{ id: 'available-model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] });
    expect(JSON.stringify(one)).not.toContain('never-return-this');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(peers[0].requests.slice(0, 2).map(r => r.method)).toEqual(['initialize', 'initialized']);
    const [binary, args, options] = spawnMock.mock.calls[0];
    expect(binary).toBeTruthy();
    expect(args.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(options.shell).toBeUndefined();
    expect(args).toContain('features.shell_tool=false');
  });

  it('distinguishes installed but signed-out state', async () => {
    await client.check(config);
    peers[0].handler = req => {
      if (req.method === 'account/read') { peers[0].response(req, { account: null, requiresOpenaiAuth: true }); return true; }
    };
    expect(await client.check(config)).toMatchObject({ installed: true, authenticated: false, error: expect.stringContaining('codex login') });
  });

  it('bootstraps private state without credentials and preserves the real login home afterward', async () => {
    vi.stubEnv('CODEX_HOME', path.join(cwd, 'existing-login'));
    vi.stubEnv('CODEX_THREAD_ID', 'unrelated-active-chat');
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-value');
    await client.check(config);
    const bootstrap = spawnMock.mock.calls[0][2].env;
    const real = spawnMock.mock.calls[1][2].env;
    expect(bootstrap.CODEX_HOME).toContain(path.join(cwd, 'cli-runtime'));
    expect(bootstrap.CODEX_HOME).not.toBe(real.CODEX_HOME);
    expect(bootstrap.OPENAI_API_KEY).toBeUndefined();
    expect(real.CODEX_HOME).toBe(path.join(cwd, 'existing-login'));
    expect(real.OPENAI_API_KEY).toBe('synthetic-test-value');
    expect(real.CODEX_THREAD_ID).toBeUndefined();
    const stateArguments = spawnMock.mock.calls.map(call => call[1].find((arg: string) => arg.startsWith('sqlite_home=')));
    expect(stateArguments[0]).toBe(stateArguments[1]);
    expect(stateArguments[0]).toContain('cli-runtime');
  });

  it('paginates the live model catalog and filters hidden or repeated models', async () => {
    await client.check(config);
    const base = { displayName: 'Name', isDefault: false, supportedReasoningEfforts: [] };
    peers[0].handler = req => {
      if (req.method !== 'model/list') return;
      peers[0].response(req, req.params.cursor
        ? { data: [{ ...base, model: 'first' }, { ...base, model: 'second' }], nextCursor: null }
        : { data: [{ ...base, model: 'first' }, { ...base, model: 'hidden', hidden: true }], nextCursor: 'page-2' });
      return true;
    };
    expect((await client.check(config)).models.map(model => model.id)).toEqual(['first', 'second']);
  });

  it('preserves roles and images, isolates threads, and streams without duplicating the completed item', async () => {
    const image = 'data:image/png;base64,AAAA';
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Reply briefly in English.' },
      { role: 'user', content: 'Previous question' },
      { role: 'assistant', content: 'Previous answer' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: 'Explain this slide' }] },
    ];
    const deltas: string[] = [];
    expect(await client.chat(config, messages, { onDelta: delta => deltas.push(delta) })).toEqual({ text: '你好 there' });
    expect(deltas).toEqual(['你好', ' there']);
    const requests = peers[0].requests;
    const start = requests.find(r => r.method === 'thread/start')!.params;
    expect(start).toMatchObject({ ephemeral: true, environments: [], sandbox: 'read-only', approvalPolicy: 'never', model: 'available-model' });
    expect(start.baseInstructions).toContain('Reply briefly in English.');
    expect(start.config['features.plugins']).toBe(false);
    expect(start.config.mcp_servers).toEqual({ inherited_server: { enabled: false } });
    expect(requests.find(r => r.method === 'thread/inject_items')?.params.items).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Previous question' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Previous answer' }] },
    ]);
    expect(requests.find(r => r.method === 'turn/start')?.params).toMatchObject({
      effort: 'low', sandboxPolicy: { type: 'readOnly', networkAccess: false },
      input: [{ type: 'image', url: image }, { type: 'text', text: 'Explain this slide' }],
    });
    await client.chat(config, question, { onDelta: () => {} });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(peers[0].nextThread).toBe(2);
    expect(requests.some(r => r.method === 'thread/unsubscribe')).toBe(true);
  });

  it('separates interleaved concurrent responses', async () => {
    await client.check(config);
    const turns: Message[] = [];
    peers[0].handler = req => {
      if (req.method !== 'turn/start') return;
      turns.push(req);
      peers[0].response(req, { turn: { id: `turn-${req.params.threadId}`, status: 'inProgress' } });
      if (turns.length === 2) {
        peers[0].complete(turns[1].params.threadId, undefined, `${turns[1].params.input[0].text} answer`);
        peers[0].complete(turns[0].params.threadId, undefined, `${turns[0].params.input[0].text} answer`);
      }
      return true;
    };
    const a: string[] = [], b: string[] = [];
    const result = await Promise.all([
      client.chat(config, [{ role: 'user', content: 'First' }], { onDelta: d => a.push(d) }),
      client.chat(config, [{ role: 'user', content: 'Second' }], { onDelta: d => b.push(d) }),
    ]);
    expect(result.map(r => r.text)).toEqual(['First answer', 'Second answer']);
    expect(a.join('')).toBe('First answer');
    expect(b.join('')).toBe('Second answer');
  });

  it('handles notifications that precede the turn/start response', async () => {
    await client.check(config);
    peers[0].handler = req => {
      if (req.method !== 'turn/start') return;
      peers[0].complete(req.params.threadId);
      peers[0].response(req, { turn: { id: `turn-${req.params.threadId}`, status: 'inProgress' } });
      return true;
    };
    expect((await client.chat(config, question, { onDelta: () => {} })).text).toBe('你好 there');
  });

  it('cancels a pending turn, retains delivered deltas and ignores late output', async () => {
    await client.check(config);
    const abort = new AbortController();
    peers[0].handler = req => {
      if (req.method !== 'turn/start') return;
      const threadId = req.params.threadId, turnId = `turn-${threadId}`;
      peers[0].response(req, { turn: { id: turnId, status: 'inProgress' } });
      peers[0].send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
      peers[0].send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'a', delta: 'Partial' } });
      abort.abort();
      peers[0].complete(threadId);
      return true;
    };
    const deltas: string[] = [];
    await expect(client.chat(config, question, { onDelta: d => deltas.push(d) }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(deltas).toEqual(['Partial']);
    expect(peers[0].requests.some(r => r.method === 'turn/interrupt')).toBe(true);
  });

  it('never starts an already-cancelled request', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(client.chat(config, question, { onDelta: () => {} }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('cancels during thread setup and closes a late-created thread without generating', async () => {
    await client.check(config);
    const abort = new AbortController();
    let began!: () => void;
    const beganPromise = new Promise<void>(resolve => { began = resolve; });
    let setup!: Message;
    peers[0].handler = req => {
      if (req.method === 'thread/start') { setup = req; began(); return true; }
    };
    const chat = client.chat(config, question, { onDelta: () => {} }, abort.signal);
    const assertion = expect(chat).rejects.toMatchObject({ name: 'AbortError' });
    await beganPromise;
    abort.abort();
    await assertion;
    peers[0].response(setup, { thread: { id: 'late-created' } });
    await Promise.resolve();
    expect(peers[0].requests.some(req => req.method === 'turn/start')).toBe(false);
    expect(peers[0].requests.some(req => req.method === 'thread/unsubscribe' && req.params.threadId === 'late-created')).toBe(true);
  });

  it('bounds a stalled initialization and cleans up its child process', async () => {
    let peer!: FakeCodex;
    let launched!: () => void;
    const launchedPromise = new Promise<void>(resolve => { launched = resolve; });
    spawnMock.mockImplementation(() => {
      peer = new FakeCodex();
      peer.handler = req => req.method === 'initialize';
      launched();
      return peer;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const check = client.check(config);
    await launchedPromise;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await check).toMatchObject({ installed: true, error: expect.stringContaining('initialize') });
    expect(peer.kill).toHaveBeenCalled();
    expect(peer.requests.some(req => req.method === 'turn/start')).toBe(false);
  });

  it('surfaces provider failures and does not report partial output as success', async () => {
    await client.check(config);
    peers[0].handler = req => {
      if (req.method !== 'turn/start') return;
      peers[0].response(req, { turn: { id: 'failed-turn', status: 'inProgress' } });
      peers[0].send({ method: 'turn/completed', params: { threadId: req.params.threadId, turn: { id: 'failed-turn', status: 'failed', error: { message: 'Usage limit reached' } } } });
      return true;
    };
    await expect(client.chat(config, question, { onDelta: () => {} })).rejects.toThrow('Usage limit reached');
  });

  it('rejects unexpected process exit and restarts for the next request', async () => {
    await client.check(config);
    peers[0].handler = req => {
      if (req.method !== 'turn/start') return;
      peers[0].emit('exit', 7, null);
      return true;
    };
    await expect(client.chat(config, question, { onDelta: () => {} })).rejects.toThrow('exited (7)');
    expect((await client.chat(config, question, { onDelta: () => {} })).text).toBe('你好 there');
    expect(spawnMock).toHaveBeenCalledTimes(4);
  });

  it('rejects local-file image URLs before creating a process', async () => {
    await expect(client.chat(config, [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///private/secrets' } }] }], { onDelta: () => {} })).rejects.toThrow('Local file URLs');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses server requests for tool execution', async () => {
    await client.check(config);
    peers[0].send({ id: 789, method: 'item/commandExecution/requestApproval', params: {} });
    expect(peers[0].requests.find(r => r.id === 789)?.error?.message).toContain('does not permit');
  });

  it('bounds a stalled turn and sends interruption', async () => {
    await client.check(config);
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    peers[0].handler = req => {
      if (req.method !== 'turn/start') return;
      peers[0].response(req, { turn: { id: 'stalled', status: 'inProgress' } });
      started();
      return true;
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = client.chat(config, question, { onDelta: () => {} });
    const assertion = expect(result).rejects.toThrow('three minutes');
    await start;
    await vi.advanceTimersByTimeAsync(180_000);
    await assertion;
    expect(peers[0].requests.some(r => r.method === 'turn/interrupt')).toBe(true);
  });
});

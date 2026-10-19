import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  ClaudeCodeClient,
  JsonLines,
  claudeCodeArgs,
  claudeCodeCandidates,
  claudeCodeEnv,
  claudeCodeFailureMessage,
  discoverClaudeCodeBinary,
  parseClaudeCodeAuthStatus,
  parseClaudeCodeLine,
  prepareClaudeCodeRequest,
} from '../electron/llm/claudeCode';
import type { ChatMessage } from '../electron/llm/adapter';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

/** A real byte-stream peer for one `claude` process: stdin capture, JSONL out, exit. */
class FakeClaude extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  input = '';
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => { this.exit(null, signal); return true; });

  constructor(private readonly onInput: (peer: FakeClaude) => void) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => { this.input += chunk.toString(); callback(); },
      final: (callback) => { callback(); queueMicrotask(() => this.onInput(this)); },
    });
  }

  /** Deliberately split each frame in the middle of a JSON property. */
  line(event: unknown) {
    const text = `${JSON.stringify(event)}\r\n`;
    this.stdout.write(text.slice(0, 7));
    this.stdout.write(text.slice(7));
  }

  delta(text: string) {
    this.line({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } } });
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    // after any stdout already written has been delivered
    setImmediate(() => { this.stdout.end(); this.stderr.end(); this.emit('exit', code, signal); this.emit('close', code, signal); });
  }
}

/** What claude 2.1.291 prints for one successful streamed answer. */
function answer(peer: FakeClaude, text = '你好 there') {
  peer.line({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools: [], mcp_servers: [] });
  peer.stdout.write('a stray non-JSON line\n');
  peer.line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'never shown' } } });
  peer.delta(text.slice(0, 2));
  peer.delta(text.slice(2));
  peer.line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  peer.line({ type: 'result', subtype: 'success', is_error: false, result: text, duration_ms: 812,
    usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 3 } });
  peer.exit(0);
}

/** Signed-out output observed from the real CLI (it exits 1). */
function authFailure(peer: FakeClaude) {
  const message = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  peer.line({ type: 'system', subtype: 'init' });
  peer.line({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: message }] }, error: 'authentication_failed', is_api_error_message: true });
  peer.line({ type: 'result', subtype: 'success', is_error: true, result: message, terminal_reason: 'api_error' });
  peer.exit(1);
}

describe('Claude Code CLI: request encoding', () => {
  it('builds print-mode arguments that disable tools, sessions, MCP, settings and skills', () => {
    const args = claudeCodeArgs({ model: ' claude-opus-5-5 ', effort: 'low' }, { text: 'Be brief.' });
    expect(args).toEqual([
      '-p', '--model', 'claude-opus-5-5', '--effort', 'low',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--tools', '', '--system-prompt', 'Be brief.',
      '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--safe-mode',
    ]);
  });

  it('omits empty overrides, ignores unknown efforts and refuses flag-like model ids', () => {
    const args = claudeCodeArgs({ model: '', effort: 'turbo' as never }, { file: '/tmp/prompt.txt' });
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
    expect(args).toContain('--system-prompt-file');
    expect(args[args.indexOf('--system-prompt-file') + 1]).toBe('/tmp/prompt.txt');
    expect(args).not.toContain('--system-prompt');
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(claudeCodeArgs({ effort }, { text: '' })).toContain(effort);
    }
    expect(claudeCodeArgs({ model: 'claude-opus-5-5[1m]' }, { text: '' })).toContain('claude-opus-5-5[1m]');
    expect(() => claudeCodeArgs({ model: '--dangerously-skip-permissions' }, { text: '' })).toThrow('valid Claude model');
    expect(() => claudeCodeArgs({ model: 'opus; rm -rf ~' }, { text: '' })).toThrow('valid Claude model');
  });

  it('encodes one stream-json user line with text and base64 image blocks', () => {
    const request = prepareClaudeCodeRequest([
      { role: 'system', content: 'Reply briefly in English.' },
      { role: 'user', content: [{ type: 'text', text: 'Explain this slide' }, { type: 'image_url', image_url: { url: 'data:image/jpg;base64,AAAA\nBBBB' } }] },
    ]);
    expect(request.input.endsWith('\n')).toBe(true);
    expect(request.input.trim().includes('\n')).toBe(false);
    expect(JSON.parse(request.input)).toEqual({ type: 'user', message: { role: 'user', content: [
      { type: 'text', text: 'Explain this slide' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAABBBB' } },
    ] } });
    expect(request.systemPrompt).toContain('Do not use tools');
    expect(request.systemPrompt).toContain('Reply briefly in English.');
  });

  it('flattens earlier turns into a labeled transcript ahead of the current message', () => {
    const request = prepareClaudeCodeRequest([
      { role: 'system', content: 'First rule.' },
      { role: 'user', content: 'Previous question' },
      { role: 'assistant', content: 'Previous answer' },
      { role: 'system', content: 'Second rule.' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: IMAGE } }, { type: 'text', text: 'And this one?' }] },
    ]);
    const content = JSON.parse(request.input).message.content;
    expect(content).toEqual([
      { type: 'text', text: 'Earlier conversation, oldest first:\n\nUser:\nPrevious question\n\nAssistant:\nPrevious answer\n\nCurrent message from the user:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: 'And this one?' },
    ]);
    expect(request.systemPrompt.endsWith('First rule.\n\nSecond rule.')).toBe(true);
  });

  it('rejects requests the CLI cannot take', () => {
    expect(() => prepareClaudeCodeRequest([{ role: 'assistant', content: 'hi' }])).toThrow('end with a user message');
    expect(() => prepareClaudeCodeRequest([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///private/secrets.png' } }] }])).toThrow('data URLs');
    expect(() => prepareClaudeCodeRequest([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }] }])).toThrow('data URLs');
    expect(() => prepareClaudeCodeRequest([
      { role: 'assistant', content: [{ type: 'image_url', image_url: { url: IMAGE } }] },
      { role: 'user', content: 'q' },
    ])).toThrow('Only user messages');
    expect(() => prepareClaudeCodeRequest([{ role: 'user', content: '' }])).toThrow('needs text or an image');
  });
});

describe('Claude Code CLI: child environment', () => {
  it('drops nested-session wiring but keeps deliberate auth and config location', () => {
    const env = claudeCodeEnv('/Users/me/.local/bin/claude', {
      HOME: '/Users/me',
      PATH: '/usr/bin:/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CLAUDE_CODE_SSE_PORT: '1234',
      CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-setup-token',
      CLAUDE_AGENT_SDK_VERSION: '9.9.9',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      ANTHROPIC_API_KEY: 'synthetic-api-key',
      CLAUDE_CONFIG_DIR: '/Users/me/.claude-work',
    }, 'darwin');
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(env.CLAUDE_AGENT_SDK_VERSION).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('synthetic-setup-token');
    expect(env.ANTHROPIC_API_KEY).toBe('synthetic-api-key');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/me/.claude-work');
    expect(env.HOME).toBe('/Users/me');
    expect(env.PATH).toBe('/Users/me/.local/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin');
  });

  it('builds a PATH even when the app was launched without one, and keeps Windows\' Path key', () => {
    expect(claudeCodeEnv('/opt/homebrew/bin/claude', {}, 'linux').PATH).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
    const windows = claudeCodeEnv('C:\\Users\\me\\.local\\bin\\claude.exe', { Path: 'C:\\Windows' }, 'win32');
    expect(windows.Path).toBe('C:\\Users\\me\\.local\\bin;C:\\Windows');
    expect(windows.PATH).toBeUndefined();
  });
});

describe('Claude Code CLI: output decoding', () => {
  it('extracts text deltas and ignores thinking and status events', () => {
    expect(parseClaudeCodeLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } })))
      .toEqual({ type: 'delta', text: 'Hi' });
    expect(parseClaudeCodeLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } } })))
      .toEqual({ type: 'ignored' });
    expect(parseClaudeCodeLine(JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }))).toEqual({ type: 'ignored' });
    expect(parseClaudeCodeLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual({ type: 'ignored' });
  });

  it('reads the final result, success and failure', () => {
    expect(parseClaudeCodeLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', duration_ms: 900,
      usage: { input_tokens: 4, cache_read_input_tokens: 10, cache_creation_input_tokens: 2, output_tokens: 1 } }))).toEqual({
      type: 'result', ok: true, text: 'OK', durationMs: 900,
      usage: { prompt_tokens: 16, completion_tokens: 1, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 6 },
    });
    // the CLI reports API failures with subtype "success" and is_error true
    expect(parseClaudeCodeLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })))
      .toMatchObject({ type: 'result', ok: false, text: 'Not logged in · Please run /login' });
    expect(parseClaudeCodeLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom', 'bang'] })))
      .toMatchObject({ ok: false, text: 'boom; bang' });
    expect(parseClaudeCodeLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true })))
      .toMatchObject({ ok: false, text: expect.stringContaining('error_max_turns') });
  });

  it('marks assistant messages that carry an API error', () => {
    expect(parseClaudeCodeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'A' }, { type: 'text', text: 'B' }] } })))
      .toEqual({ type: 'assistant', text: 'AB' });
    expect(parseClaudeCodeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Failed' }] }, error: 'authentication_failed' })))
      .toEqual({ type: 'assistant', text: 'Failed', error: 'authentication_failed' });
  });

  it('treats garbage as invalid lines instead of failing', () => {
    expect(parseClaudeCodeLine('Warning: something odd')).toEqual({ type: 'invalid', line: 'Warning: something odd' });
    expect(parseClaudeCodeLine('[1,2]')).toMatchObject({ type: 'invalid' });
    expect(parseClaudeCodeLine('null')).toMatchObject({ type: 'invalid' });
    expect(parseClaudeCodeLine('{"type":"result"')).toMatchObject({ type: 'invalid' });
  });

  it('frames JSONL across arbitrary chunks and CRLF', () => {
    const lines = new JsonLines();
    expect(lines.push('{"a":1}\r\n{"b"')).toEqual(['{"a":1}']);
    expect(lines.push(':2}\n\n{"c":3}')).toEqual(['{"b":2}']);
    expect(lines.flush()).toBe('{"c":3}');
    expect(lines.flush()).toBe('');
  });

  it('turns sign-in failures into the claude auth login instruction in both languages', () => {
    const en = claudeCodeFailureMessage('Failed to authenticate: OAuth session expired and could not be refreshed', 'en');
    expect(en).toContain('claude auth login');
    expect(en).toContain('OAuth session expired');
    const zh = claudeCodeFailureMessage('Not logged in · Please run /login', 'zh');
    expect(zh).toContain('未登录');
    expect(zh).toContain('claude auth login');
    expect(claudeCodeFailureMessage('Something else', 'en', true)).toContain('claude auth login');
    expect(claudeCodeFailureMessage('Rate limited, try later', 'en')).toBe('Rate limited, try later');
  });

  it('reads auth status display fields only', () => {
    const signedIn = parseClaudeCodeAuthStatus(JSON.stringify({
      loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'owner@example.test', subscriptionType: 'max',
      orgId: 'never-return-this-org-id', accessToken: 'never-return-this-token', configDirectory: '/Users/me/.claude',
    }));
    expect(signedIn).toEqual({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'owner@example.test', subscriptionType: 'max' });
    expect(parseClaudeCodeAuthStatus('notice: update available\n{"loggedIn":false,"authMethod":"none"}\n')).toEqual({ loggedIn: false, authMethod: 'none' });
    expect(parseClaudeCodeAuthStatus('not json')).toBeUndefined();
    expect(parseClaudeCodeAuthStatus('{"authMethod":"none"}')).toBeUndefined();
  });
});

describe('Claude Code CLI: discovery', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'meetingcopilot-claude-find-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('searches the native installer, Homebrew/npm locations, then PATH on macOS and Linux', () => {
    expect(claudeCodeCandidates(undefined, { platform: 'darwin', home: '/Users/me', env: { PATH: '/custom/bin:/usr/local/bin' } })).toEqual([
      '/Users/me/.local/bin/claude',
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      '/Users/me/.claude/local/claude',
      '/Users/me/.npm-global/bin/claude',
      '/custom/bin/claude',
    ]);
  });

  it('searches the native installer, npm, then Path on Windows', () => {
    expect(claudeCodeCandidates(undefined, {
      platform: 'win32', home: 'C:\\Users\\me',
      env: { USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', Path: 'C:\\Tools' },
    })).toEqual([
      'C:\\Users\\me\\.local\\bin\\claude.exe',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
      'C:\\Tools\\claude.exe',
      'C:\\Tools\\claude.cmd',
    ]);
  });

  it('uses only the override: a path (with ~) or a bare name looked up on PATH', () => {
    const machine = { platform: 'darwin' as const, home: '/Users/me', env: { PATH: '/a:/b' } };
    expect(claudeCodeCandidates('~/tools/claude', machine)).toEqual(['/Users/me/tools/claude']);
    expect(claudeCodeCandidates('/opt/claude/bin/claude', machine)).toEqual(['/opt/claude/bin/claude']);
    expect(claudeCodeCandidates('claude-beta', machine)).toEqual(['/a/claude-beta', '/b/claude-beta']);
  });

  it('returns the first executable candidate and never a directory or non-executable file', async () => {
    const home = path.join(dir, 'home');
    const native = path.join(home, '.local', 'bin', 'claude');
    await mkdir(path.dirname(native), { recursive: true });
    await writeFile(native, '#!/bin/sh\n');
    await chmod(native, 0o755);
    const pathDir = path.join(dir, 'path-bin');
    await mkdir(pathDir);
    await writeFile(path.join(pathDir, 'claude'), '#!/bin/sh\n');
    await chmod(path.join(pathDir, 'claude'), 0o755);
    if (process.platform !== 'win32') {
      await expect(discoverClaudeCodeBinary(undefined, 'en', { home, env: { PATH: pathDir } })).resolves.toBe(native);
      const plain = path.join(dir, 'not-executable');
      await writeFile(plain, 'text');
      await chmod(plain, 0o644);
      await expect(discoverClaudeCodeBinary(plain, 'en')).rejects.toThrow('not executable');
    }
    await expect(discoverClaudeCodeBinary(home, 'en')).rejects.toThrow('not executable');
    await expect(discoverClaudeCodeBinary(path.join(dir, 'missing'), 'zh')).rejects.toThrow('可执行文件');
  });
});

describe('Claude Code CLI: client', () => {
  let cwd: string;
  let client: ClaudeCodeClient;
  let peers: FakeClaude[];
  let script: (peer: FakeClaude, args: string[]) => void;
  let lang: 'en' | 'zh';
  const config = { binaryPath: process.execPath, model: 'claude-opus-5-5', effort: 'low' as const };
  const question: ChatMessage[] = [{ role: 'user', content: 'Hello' }];

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'meetingcopilot-claude-'));
    peers = [];
    lang = 'en';
    script = (peer) => answer(peer);
    spawnMock.mockReset().mockImplementation((_binary: string, args: string[]) => {
      const peer = new FakeClaude((p) => script(p, args));
      peers.push(peer);
      return peer as unknown as ChildProcessWithoutNullStreams;
    });
    client = new ClaudeCodeClient({ cwd, lang: () => lang });
  });

  afterEach(async () => {
    await client.dispose();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await rm(cwd, { recursive: true, force: true });
  });

  it('streams one answer from one process with stdin input, no shell and a scrubbed env', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'sdk-ts');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'synthetic-setup-token');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9');
    const deltas: string[] = [];
    const result = await client.chat(config, [
      { role: 'system', content: 'Reply briefly.' },
      { role: 'user', content: [{ type: 'text', text: 'Explain' }, { type: 'image_url', image_url: { url: IMAGE } }] },
    ], { onDelta: (delta) => deltas.push(delta) });
    expect(result).toEqual({ text: '你好 there', usage: { prompt_tokens: 115, completion_tokens: 3, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 15 } });
    // thinking, the non-JSON line and the complete assistant message add nothing
    expect(deltas).toEqual(['你好', ' there']);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [binary, args, options] = spawnMock.mock.calls[0];
    expect(binary).toBe(process.execPath);
    expect(args.slice(0, 5)).toEqual(['-p', '--model', 'claude-opus-5-5', '--effort', 'low']);
    expect(args[args.indexOf('--system-prompt') + 1]).toContain('Reply briefly.');
    expect(options.shell).toBeUndefined();
    expect(options.cwd).toBe(cwd);
    expect(options.env.CLAUDECODE).toBeUndefined();
    expect(options.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(options.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('synthetic-setup-token');
    const sent = JSON.parse(peers[0].input);
    expect(sent.message.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } });
  });

  it('runs independent processes for concurrent requests', async () => {
    script = (peer) => {
      const text = JSON.parse(peer.input).message.content[0].text;
      setTimeout(() => answer(peer, `${text} answer`), text === 'First' ? 20 : 0);
    };
    const a: string[] = [], b: string[] = [];
    const results = await Promise.all([
      client.chat(config, [{ role: 'user', content: 'First' }], { onDelta: (d) => a.push(d) }),
      client.chat(config, [{ role: 'user', content: 'Second' }], { onDelta: (d) => b.push(d) }),
    ]);
    expect(results.map((r) => r.text)).toEqual(['First answer', 'Second answer']);
    expect(a.join('')).toBe('First answer');
    expect(b.join('')).toBe('Second answer');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('uses the complete assistant message when a CLI streams no deltas, and the result text when given', async () => {
    script = (peer) => {
      peer.line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Whole answer' }] } });
      peer.line({ type: 'result', subtype: 'success', is_error: false, result: 'Whole answer' });
      peer.exit(0);
    };
    const deltas: string[] = [];
    expect((await client.chat(config, question, { onDelta: (d) => deltas.push(d) })).text).toBe('Whole answer');
    expect(deltas).toEqual(['Whole answer']);
    script = (peer) => {
      peer.delta('Streamed only');
      peer.stdout.write(`${JSON.stringify({ type: 'result', is_error: false, subtype: 'success', result: '' })}`); // no trailing newline
      peer.exit(0);
    };
    expect((await client.chat(config, question, { onDelta: () => {} })).text).toBe('Streamed only');
  });

  it('maps a sign-in failure to the claude auth login instruction without showing it as an answer', async () => {
    script = authFailure;
    const deltas: string[] = [];
    await expect(client.chat(config, question, { onDelta: (d) => deltas.push(d) })).rejects.toThrow(/claude auth login.*OAuth session expired/);
    expect(deltas).toEqual([]);
    lang = 'zh';
    await expect(client.chat(config, question, { onDelta: () => {} })).rejects.toThrow(/未登录.*claude auth login/);
  });

  it('does not report partial output as success when the result is an error', async () => {
    script = (peer) => {
      peer.delta('Partial');
      peer.line({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 Overloaded' });
      peer.exit(1);
    };
    const deltas: string[] = [];
    await expect(client.chat(config, question, { onDelta: (d) => deltas.push(d) })).rejects.toThrow('529 Overloaded');
    expect(deltas).toEqual(['Partial']);
  });

  it('reports the last diagnostic lines when the CLI exits without a result', async () => {
    script = (peer) => {
      peer.stderr.write('Error: --input-format=stream-json requires output-format=stream-json.\n');
      peer.exit(1);
    };
    await expect(client.chat(config, question, { onDelta: () => {} })).rejects.toThrow(/exited \(1\).*requires output-format=stream-json/);
  });

  it('cancels a running answer, keeps delivered deltas and kills the process', async () => {
    const abort = new AbortController();
    script = (peer) => { peer.delta('Partial'); setTimeout(() => abort.abort(), 5); };
    const deltas: string[] = [];
    await expect(client.chat(config, question, { onDelta: (d) => deltas.push(d) }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(deltas).toEqual(['Partial']);
    expect(peers[0].kill).toHaveBeenCalled();
  });

  it('never starts an already-cancelled request or an invalid one', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(client.chat(config, question, { onDelta: () => {} }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client.chat({ ...config, model: '--tools=default' }, question, { onDelta: () => {} })).rejects.toThrow('valid Claude model');
    await expect(client.chat(config, [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }] }], { onDelta: () => {} })).rejects.toThrow('data URLs');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('bounds a stalled answer and kills the process', async () => {
    let started!: () => void;
    const start = new Promise<void>((resolve) => { started = resolve; });
    script = () => started();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = client.chat(config, question, { onDelta: () => {} });
    const assertion = expect(result).rejects.toThrow('three minutes');
    await start;
    await vi.advanceTimersByTimeAsync(180_000);
    await assertion;
    expect(peers[0].kill).toHaveBeenCalled();
  });

  it('passes long session material through a private prompt file and removes it afterwards', async () => {
    const material = '简历'.repeat(10_000);
    let during: string | undefined;
    script = (peer, args) => {
      void readFile(args[args.indexOf('--system-prompt-file') + 1], 'utf8').then((text) => { during = text; answer(peer); });
    };
    await client.chat(config, [{ role: 'system', content: material }, { role: 'user', content: 'Q' }], { onDelta: () => {} });
    const args: string[] = spawnMock.mock.calls[0][1];
    expect(args).not.toContain('--system-prompt');
    const file = args[args.indexOf('--system-prompt-file') + 1];
    expect(file.startsWith(path.join(cwd, 'prompts'))).toBe(true);
    expect(during).toContain(material);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(file)).toBe(false);
  });

  it('reports a missing executable without starting a process', async () => {
    const status = await client.check({ binaryPath: path.join(cwd, 'missing-claude') });
    expect(status).toMatchObject({ installed: false, authenticated: false, error: expect.stringContaining('not found') });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reads version and sign-in state, parsing auth status even when it exits 1', async () => {
    let loggedIn = false;
    script = (peer, args) => {
      if (args[0] === '--version') { peer.stdout.write('2.1.291 (Claude Code)\n'); peer.exit(0); return; }
      peer.stdout.write(`${JSON.stringify(loggedIn
        ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'owner@example.test', subscriptionType: 'max', orgId: 'never-return-this' }
        : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', configDirectory: '/Users/me/.claude' }, null, 2)}\n`);
      peer.exit(loggedIn ? 0 : 1);
    };
    const signedOut = await client.check(config);
    expect(signedOut).toMatchObject({ installed: true, authenticated: false, version: '2.1.291', binaryPath: process.execPath, error: expect.stringContaining('claude auth login') });
    expect(signedOut.authMethod).toBeUndefined();
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([['--version'], ['auth', 'status']]);
    loggedIn = true;
    const signedIn = await client.check(config);
    expect(signedIn).toEqual({ installed: true, authenticated: true, binaryPath: process.execPath, version: '2.1.291',
      authMethod: 'claude.ai', apiProvider: 'firstParty', accountEmail: 'owner@example.test', subscriptionType: 'max' });
    expect(JSON.stringify(signedIn)).not.toContain('never-return-this');
  });

  it('says so when the sign-in status cannot be read', async () => {
    script = (peer) => { peer.stdout.write('unexpected output\n'); peer.exit(2); };
    expect(await client.check(config)).toMatchObject({ installed: true, authenticated: false, error: expect.stringContaining('sign-in status') });
  });

  it('stops running processes on dispose', async () => {
    script = () => { /* never answers */ };
    const pending = client.chat(config, question, { onDelta: () => {} });
    pending.catch(() => {});
    await vi.waitFor(() => expect(peers).toHaveLength(1));
    await client.dispose();
    expect(peers[0].kill).toHaveBeenCalled();
    await expect(pending).rejects.toThrow();
  });
});

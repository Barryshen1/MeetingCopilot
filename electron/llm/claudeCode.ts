/**
 * Claude Code CLI integration. The CLI owns authentication; credentials never
 * enter this app. Every request is one short-lived `claude -p` process: the
 * conversation goes in on stdin as a single stream-json user message, the
 * answer streams back as JSONL, and nothing is written to the user's Claude
 * Code settings or session history.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isClaudeCodeEffort, type ClaudeCodeSettings, type ClaudeCodeStatus } from '../../shared/claudeCode';
import type { UiLang } from '../../shared/protocol';
import { redactSecrets } from '../../shared/redact';
import { mainStrings } from '../uiStrings';
import type { ChatContentPart, ChatMessage, ChatResult, ChatStreamCallbacks, ChatUsage } from './adapter';

const STATUS_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 180_000;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STATUS_OUTPUT = 256 * 1024;
/** Kept for error reports when the CLI exits without a result line. */
const MAX_DIAGNOSTIC_CHARS = 4_000;
const DIAGNOSTIC_LINES = 6;
/**
 * Longer system prompts (session materials) go through --system-prompt-file:
 * Windows caps a whole command line at 32,767 characters and Linux caps one
 * argument at 128 KiB.
 */
const SYSTEM_PROMPT_ARG_LIMIT = 16_000;
const TEXT_INSTRUCTIONS = 'Answer the user using only the supplied conversation and images. Do not use tools, inspect files, run commands, or take actions outside this conversation.';
/** Finder-launched apps get a minimal PATH; an npm-installed CLI may still need node from here. */
const POSIX_PATH_FALLBACK = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];
/** Auth the user set up on purpose (`claude setup-token`) survives the env scrub. */
const KEPT_CLAUDE_CODE_ENV = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);
/** Full ids and aliases, including Bedrock/Vertex ids and `[1m]` suffixes; never a flag. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/;
const AUTH_FAILURE = /not logged in|failed to authenticate|authentication_failed|invalid api key|oauth (?:session|token)|please run \/login|claude auth login/i;

type JsonObject = Record<string, any>;

function strings(lang?: UiLang) {
  return mainStrings(lang, 'en').claudeCode;
}

function abortError(): Error {
  const error = new Error('Claude Code request cancelled.');
  error.name = 'AbortError';
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

// ---------- discovery ----------

/** Injectable view of the machine, so the search order is testable on any OS. */
export interface ClaudeCodeEnvironment {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function pathKey(env: NodeJS.ProcessEnv): string {
  // Windows spells it "Path"; Node's env object is case-insensitive there, a copy is not.
  return Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
}

/** Ordered executable candidates. An override is the only candidate. */
export function claudeCodeCandidates(override?: string, machine: ClaudeCodeEnvironment = {}): string[] {
  const platform = machine.platform ?? process.platform;
  const env = machine.env ?? process.env;
  const home = machine.home ?? os.homedir();
  const p = platform === 'win32' ? path.win32 : path.posix;
  const pathDirs = (env[pathKey(env)] || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const selected = override?.trim();
  if (selected) {
    if (!selected.includes('/') && !selected.includes('\\')) return pathDirs.map(dir => p.join(dir, selected));
    return [selected.startsWith('~/') || selected.startsWith('~\\') ? p.join(home, selected.slice(2)) : selected];
  }
  const candidates = platform === 'win32'
    ? [
      ...(env.USERPROFILE ? [p.join(env.USERPROFILE, '.local', 'bin', 'claude.exe')] : []),
      ...(env.APPDATA ? [p.join(env.APPDATA, 'npm', 'claude.cmd')] : []),
      ...pathDirs.flatMap(dir => ['claude.exe', 'claude.cmd'].map(name => p.join(dir, name))),
    ]
    : [
      p.join(home, '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      p.join(home, '.claude', 'local', 'claude'),
      p.join(home, '.npm-global', 'bin', 'claude'),
      ...pathDirs.map(dir => p.join(dir, 'claude')),
    ];
  return [...new Set(candidates)];
}

/** Finder-launched apps do not inherit a login shell's PATH. Never invoke a shell to find Claude Code. */
export async function discoverClaudeCodeBinary(override?: string, lang?: UiLang, machine: ClaudeCodeEnvironment = {}): Promise<string> {
  const windows = (machine.platform ?? process.platform) === 'win32';
  for (const candidate of claudeCodeCandidates(override, machine)) {
    try {
      await access(candidate, windows ? constants.F_OK : constants.X_OK);
      // Windows cannot spawn npm's .cmd shim without cmd.exe. Run the package's
      // native executable instead, so user-controlled paths never become shell input.
      if (windows && /\.cmd$/i.test(candidate)) {
        const native = path.win32.join(path.win32.dirname(candidate), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
        await access(native, constants.F_OK);
        return native;
      }
      // A directory passes X_OK (search permission); it is not an executable.
      if (!(await stat(candidate)).isFile()) continue;
      return candidate;
    } catch { /* try the next installation */ }
  }
  throw new Error(override?.trim() ? strings(lang).selectedNotFound : strings(lang).notFound);
}

/**
 * The child's environment. A launch from inside a Claude Code session (or an
 * Agent SDK host) inherits that session's wiring — nested-session markers,
 * SDK entrypoints, a proxy base URL — and any of it breaks the child's own
 * sign-in. Deliberate auth (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY) and
 * the config location (CLAUDE_CONFIG_DIR) stay.
 */
export function claudeCodeEnv(binary: string, source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key === 'ANTHROPIC_BASE_URL' || key.startsWith('CLAUDE_AGENT_SDK_') ||
      (key.startsWith('CLAUDE_CODE_') && !KEPT_CLAUDE_CODE_ENV.has(key))) delete env[key];
  }
  const p = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const key = pathKey(env);
  const dirs = [p.dirname(binary), ...(env[key] || '').split(delimiter), ...(platform === 'win32' ? [] : POSIX_PATH_FALLBACK)];
  env[key] = [...new Set(dirs.filter(Boolean))].join(delimiter);
  return env;
}

// ---------- request encoding ----------

/** Arguments for one answer. No tools, MCP servers, settings files, skills, plugins or session file. */
export function claudeCodeArgs(config: ClaudeCodeSettings, systemPrompt: { text: string } | { file: string }): string[] {
  const model = config.model?.trim();
  if (model && !MODEL_ID.test(model)) throw new Error('Enter a valid Claude model ID or alias, for example claude-opus-5-5.');
  return [
    '-p',
    ...(model ? ['--model', model] : []),
    ...(isClaudeCodeEffort(config.effort) ? ['--effort', config.effort] : []),
    // stream-json input requires stream-json output; partial messages carry the text deltas.
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', '',
    ...('file' in systemPrompt ? ['--system-prompt-file', systemPrompt.file] : ['--system-prompt', systemPrompt.text]),
    '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--safe-mode',
  ];
}

function parts(content: ChatMessage['content']): ChatContentPart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

/** The app's screenshots are data URLs; the CLI takes Anthropic base64 image blocks. */
function imageBlock(url: string): JsonObject {
  const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  if (!match) throw new Error('Claude Code images must be PNG, JPEG, WebP or GIF data URLs. Local file and web URLs are not accepted.');
  return { type: 'image', source: { type: 'base64', media_type: match[1].toLowerCase().replace('image/jpg', 'image/jpeg'), data: match[2].replace(/\s+/g, '') } };
}

export interface ClaudeCodeRequest {
  systemPrompt: string;
  /** exactly one stream-json line, newline included */
  input: string;
}

/**
 * One user turn for the CLI. System messages join the system prompt; earlier
 * turns become a labeled transcript ahead of the final user message, because
 * a print-mode session starts empty and has no history to inject into.
 */
export function prepareClaudeCodeRequest(messages: ChatMessage[]): ClaudeCodeRequest {
  const system = messages.filter(message => message.role === 'system').map(message => parts(message.content).map(part => {
    if (part.type !== 'text') throw new Error('System instructions cannot contain images.');
    return part.text;
  }).join('\n')).join('\n\n');
  const conversation = messages.filter(message => message.role !== 'system');
  const last = conversation.at(-1);
  if (!last || last.role !== 'user') throw new Error('A Claude Code request must end with a user message.');
  const history = conversation.slice(0, -1);
  const content: JsonObject[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const previous = content.at(-1);
    if (previous?.type === 'text') previous.text += `\n\n${text}`;
    else content.push({ type: 'text', text });
  };
  const pushMessage = (message: ChatMessage, label?: string) => {
    let labeled = !label;
    for (const part of parts(message.content)) {
      if (part.type === 'text') {
        if (!part.text) continue;
        pushText(labeled ? part.text : `${label}\n${part.text}`);
      } else {
        if (message.role !== 'user') throw new Error('Only user messages can contain images.');
        if (!labeled) pushText(label!);
        content.push(imageBlock(part.image_url.url));
      }
      labeled = true;
    }
  };
  if (history.length) {
    pushText('Earlier conversation, oldest first:');
    for (const message of history) pushMessage(message, message.role === 'assistant' ? 'Assistant:' : 'User:');
    pushMessage(last, 'Current message from the user:');
  } else {
    pushMessage(last);
  }
  if (!content.length) throw new Error('A Claude Code request needs text or an image.');
  return {
    systemPrompt: [TEXT_INSTRUCTIONS, system].filter(Boolean).join('\n\n'),
    input: `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`,
  };
}

// ---------- response decoding ----------

export type ClaudeCodeEvent =
  /** a streamed text fragment of the answer */
  | { type: 'delta'; text: string }
  /** a complete assistant message; `error` marks an API failure surfaced as text */
  | { type: 'assistant'; text: string; error?: string }
  /** the final line: the answer, or the human-readable failure */
  | { type: 'result'; ok: boolean; text: string; usage?: ChatUsage; durationMs?: number }
  | { type: 'ignored' }
  | { type: 'invalid'; line: string };

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Decode one stdout line. Thinking deltas, init/status lines and unknown events are ignored. */
export function parseClaudeCodeLine(line: string): ClaudeCodeEvent {
  let event: any;
  try { event = JSON.parse(line); } catch { return { type: 'invalid', line }; }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { type: 'invalid', line };
  if (event.type === 'stream_event') {
    const inner = event.event;
    if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') {
      return { type: 'delta', text: inner.delta.text };
    }
    return { type: 'ignored' };
  }
  if (event.type === 'assistant') {
    const blocks: unknown[] = Array.isArray(event.message?.content) ? event.message.content : [];
    const text = blocks.filter((block: any) => block?.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('');
    const error = typeof event.error === 'string' ? event.error : event.is_api_error_message ? 'api_error' : undefined;
    return { type: 'assistant', text, ...(error ? { error } : {}) };
  }
  if (event.type === 'result') {
    const ok = event.is_error === false || (event.is_error === undefined && event.subtype === 'success');
    const failure = typeof event.result === 'string' && event.result.trim() ? event.result
      : Array.isArray(event.errors) && event.errors.length ? event.errors.map(String).join('; ')
        : `Claude Code failed to generate a response (${String(event.subtype ?? 'unknown error')}).`;
    const usage = event.usage && typeof event.usage === 'object' ? event.usage : undefined;
    const cached = tokens(usage?.cache_read_input_tokens);
    const fresh = tokens(usage?.input_tokens) + tokens(usage?.cache_creation_input_tokens);
    return {
      type: 'result',
      ok,
      text: ok ? (typeof event.result === 'string' ? event.result : '') : failure,
      ...(usage ? { usage: { prompt_tokens: cached + fresh, completion_tokens: tokens(usage.output_tokens), prompt_cache_hit_tokens: cached, prompt_cache_miss_tokens: fresh } } : {}),
      ...(typeof event.duration_ms === 'number' ? { durationMs: event.duration_ms } : {}),
    };
  }
  return { type: 'ignored' };
}

/** JSONL framing across arbitrary chunk boundaries, CRLF tolerant. */
export class JsonLines {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) lines.push(line);
    }
    if (this.buffer.length > MAX_LINE_BYTES) throw new Error('Claude Code sent an oversized output line.');
    return lines;
  }

  /** the unterminated final line, if any */
  flush(): string {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest;
  }
}

/** An auth failure becomes the actionable "run claude auth login" message; the CLI's own text stays as detail. */
export function claudeCodeFailureMessage(detail: string, lang?: UiLang, authFailure = false): string {
  const clean = redactSecrets(detail.trim()).slice(0, 500);
  if (authFailure || AUTH_FAILURE.test(clean)) return clean ? `${strings(lang).signedOut} (${clean})` : strings(lang).signedOut;
  return clean || 'Claude Code failed to generate a response.';
}

/** `claude auth status` display fields only; never tokens, org ids or config paths. */
export function parseClaudeCodeAuthStatus(stdout: string): { loggedIn: boolean; authMethod?: string; apiProvider?: string; email?: string; subscriptionType?: string } | undefined {
  const text = stdout.trim();
  let value: any;
  try { value = JSON.parse(text); } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return undefined;
    try { value = JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
  }
  if (!value || typeof value !== 'object' || typeof value.loggedIn !== 'boolean') return undefined;
  const field = (name: string) => typeof value[name] === 'string' && value[name] ? { [name]: value[name] as string } : {};
  return { loggedIn: value.loggedIn, ...field('authMethod'), ...field('apiProvider'), ...field('email'), ...field('subscriptionType') };
}

function lastLines(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-DIAGNOSTIC_LINES).join(' | ');
}

// ---------- client ----------

/** Independent requests use independent CLI processes; nothing stays warm between answers. */
export class ClaudeCodeClient {
  private children = new Set<ChildProcessWithoutNullStreams>();
  private disposed = false;

  constructor(private readonly options: {
    /** app-owned, otherwise empty working directory; never the user's project */
    cwd: string;
    /** language of the actionable errors (sign-in, not found, timeout) */
    lang?: () => UiLang | undefined;
  }) {}

  private spawnCli(binary: string, args: string[]): ChildProcessWithoutNullStreams {
    if (this.disposed) throw new Error('Claude Code client has been disposed.');
    const child = spawn(binary, args, { cwd: this.options.cwd, env: claudeCodeEnv(binary), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.children.add(child);
    child.once('close', () => this.children.delete(child));
    return child;
  }

  /** One short command with no prompt and no generation; resolves on any exit code. */
  private run(binary: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnCli(binary, args);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Claude Code did not respond to "${args.join(' ')}" within 20 seconds.`));
      }, STATUS_TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (data: string) => { if (stdout.length < MAX_STATUS_OUTPUT) stdout += data; });
      child.stderr.on('data', (data: string) => { if (stderr.length < MAX_STATUS_OUTPUT) stderr += data; });
      child.stdin.on('error', () => { /* the exit status reports the problem */ });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.stdin.end();
    });
  }

  async check(config: ClaudeCodeSettings = {}): Promise<ClaudeCodeStatus> {
    const lang = this.options.lang?.();
    let binaryPath: string | undefined;
    let version: string | undefined;
    try {
      binaryPath = await discoverClaudeCodeBinary(config.binaryPath, lang);
      await mkdir(this.options.cwd, { recursive: true });
      const [versionRun, authRun] = await Promise.all([this.run(binaryPath, ['--version']), this.run(binaryPath, ['auth', 'status'])]);
      version = /\d+\.\d+\.\d+[^\s)]*/.exec(versionRun.stdout)?.[0];
      // `auth status` exits 1 while signed out but still prints its JSON.
      const account = parseClaudeCodeAuthStatus(authRun.stdout);
      if (!account) throw new Error(strings(lang).statusUnreadable);
      const authenticated = account.loggedIn;
      return {
        installed: true, authenticated, binaryPath, version,
        ...(authenticated ? {
          authMethod: account.authMethod, apiProvider: account.apiProvider,
          accountEmail: account.email, subscriptionType: account.subscriptionType,
        } : { error: strings(lang).signedOut }),
      };
    } catch (error) {
      return { installed: !!binaryPath, authenticated: false, binaryPath, version, error: redactSecrets(asError(error).message) };
    }
  }

  async chat(config: ClaudeCodeSettings, messages: ChatMessage[], callbacks: ChatStreamCallbacks, signal?: AbortSignal): Promise<ChatResult> {
    if (signal?.aborted) throw abortError();
    const lang = this.options.lang?.();
    const request = prepareClaudeCodeRequest(messages);
    const promptFile = request.systemPrompt.length > SYSTEM_PROMPT_ARG_LIMIT
      ? path.join(this.options.cwd, 'prompts', `${randomUUID()}.txt`) : undefined;
    const args = claudeCodeArgs(config, promptFile ? { file: promptFile } : { text: request.systemPrompt });
    const binary = await abortable(discoverClaudeCodeBinary(config.binaryPath, lang), signal);
    await mkdir(this.options.cwd, { recursive: true });
    const removePrompt = () => promptFile ? rm(promptFile, { force: true }).catch(() => {}) : Promise.resolve();
    if (promptFile) {
      await mkdir(path.dirname(promptFile), { recursive: true });
      await writeFile(promptFile, request.systemPrompt, { encoding: 'utf8', mode: 0o600 });
    }
    if (signal?.aborted) { await removePrompt(); throw abortError(); }
    let child: ChildProcessWithoutNullStreams;
    try { child = this.spawnCli(binary, args); } catch (error) { await removePrompt(); throw error; }

    return new Promise<ChatResult>((resolve, reject) => {
      const lines = new JsonLines();
      let diagnostics = '';
      let text = '';
      let streamed = false;
      let authFailure = false;
      let done = false;
      let exited = false;
      const note = (output: string) => { diagnostics = (diagnostics + output).slice(-MAX_DIAGNOSTIC_CHARS); };
      const stop = () => {
        if (exited) return;
        child.kill();
        const force = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 1_000);
        force.unref?.();
      };
      const finish = (error?: Error, result?: ChatResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) stop();
        else if (!exited) {
          // The result line is final; a CLI that lingers after it is stopped.
          const linger = setTimeout(stop, 5_000);
          linger.unref?.();
          child.once('close', () => clearTimeout(linger));
        }
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => finish(abortError());
      const timer = setTimeout(() => finish(new Error(strings(lang).timedOut)), TURN_TIMEOUT_MS);
      signal?.addEventListener('abort', abort, { once: true });

      const append = (delta: string) => {
        if (!delta || done) return;
        text += delta;
        callbacks.onDelta(delta);
      };
      const handle = (line: string) => {
        const event = parseClaudeCodeLine(line);
        if (event.type === 'invalid') note(`${line}\n`);
        else if (event.type === 'delta') { streamed = true; append(event.text); }
        else if (event.type === 'assistant') {
          // An API failure arrives as assistant text too; it must never read as an answer.
          if (event.error) authFailure ||= event.error === 'authentication_failed';
          // Without partial messages (older CLIs) the whole answer arrives here once.
          else if (!streamed) append(event.text);
        } else if (event.type === 'result') {
          if (!event.ok) finish(new Error(claudeCodeFailureMessage(event.text, lang, authFailure)));
          else if (!(event.text || text).trim()) finish(new Error('Claude Code completed without an answer. Try another model.'));
          else finish(undefined, { text: event.text || text, ...(event.usage ? { usage: event.usage } : {}) });
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (data: string) => {
        try { for (const line of lines.push(data)) if (!done) handle(line); } catch (error) { finish(asError(error)); }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (data: string) => note(data));
      child.stdin.on('error', () => { /* the exit handler reports why */ });
      child.on('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ENOENT' ? new Error(strings(lang).notFound) : error));
      child.on('close', (code, closeSignal) => {
        exited = true;
        void removePrompt();
        const rest = lines.flush();
        if (rest && !done) handle(rest);
        if (done) return;
        const detail = lastLines(diagnostics);
        finish(new Error(claudeCodeFailureMessage(
          `Claude Code exited (${closeSignal || code || 'closed'}) without an answer.${detail ? ` ${detail}` : ''}`, lang, authFailure,
        )));
      });
      child.stdin.end(request.input);
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const children = [...this.children];
    this.children.clear();
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode != null || child.signalCode != null) { resolve(); return; }
      child.once('close', () => resolve());
      child.kill();
      const force = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1_000);
      force.unref?.();
    })));
  }
}

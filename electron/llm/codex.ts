/** Codex CLI integration. The CLI owns authentication; credentials never enter this app. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CodexModel, CodexSettings, CodexStatus } from '../../shared/codex';
import type { ChatContentPart, ChatMessage, ChatResult, ChatStreamCallbacks } from './adapter';

const RPC_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 180_000;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const TEXT_INSTRUCTIONS = 'Answer the user using only the supplied conversation and images. Do not use tools, inspect files, run commands, or take actions outside this conversation.';

// Runtime overrides only: never modify the user's Codex configuration.
const TEXT_CONFIG: Record<string, unknown> = {
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.apps': false,
  'features.plugins': false,
  'features.browser_use': false,
  'features.browser_use_external': false,
  'features.in_app_browser': false,
  'features.code_mode': false,
  'features.computer_use': false,
  'features.image_generation': false,
  'features.multi_agent': false,
  'features.memories': false,
  'features.chronicle': false,
  'features.hooks': false,
  'features.shell_snapshot': false,
  'features.workspace_dependencies': false,
  'features.tool_suggest': false,
  'features.goals': false,
  'web_search': 'disabled',
  'project_doc_max_bytes': 0,
  'mcp_servers': {},
};

type JsonObject = Record<string, any>;
type RpcMessage = { id?: number | string; method?: string; params?: JsonObject; result?: any; error?: { code?: number; message?: string } };

async function npmNativeBinary(packageRoot: string): Promise<string | undefined> {
  const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const target = process.platform === 'win32' ? `${architecture}-pc-windows-msvc`
    : process.platform === 'darwin' ? `${architecture}-apple-darwin` : `${architecture}-unknown-linux-musl`;
  const packageName = `codex-${process.platform}-${process.arch}`;
  const roots = [packageRoot, path.join(packageRoot, 'node_modules', '@openai', packageName), path.join(path.dirname(packageRoot), packageName)];
  for (const root of roots) for (const directory of ['bin', 'codex']) {
    const binary = path.join(root, 'vendor', target, directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    try { await access(binary, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return await realpath(binary); } catch { /* another npm version/layout */ }
  }
  return undefined;
}

function abortError(): Error {
  const error = new Error('Codex request cancelled.');
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

/** Finder-launched apps do not inherit a login shell's PATH. Never invoke a shell to find Codex. */
export async function discoverCodexBinary(override?: string): Promise<string> {
  const home = os.homedir();
  const expandHome = (value: string) => value.startsWith('~/') || value.startsWith('~\\') ? path.join(home, value.slice(2)) : value;
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const selected = override?.trim();
  const candidates: string[] = selected
    ? (selected.includes('/') || selected.includes('\\') ? [expandHome(selected)] : pathDirs.map(dir => path.join(dir, selected)))
    : [
      ...pathDirs.flatMap(dir => names.map(name => path.join(dir, name))),
      ...['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin')].flatMap(dir => names.map(name => path.join(dir, name))),
      ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm', 'codex.cmd')] : []),
      ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'codex.exe')] : []),
      '/Applications/Codex.app/Contents/Resources/codex',
      path.join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
    ];
  if (!selected && process.platform !== 'win32') {
    const root = path.join(home, '.nvm', 'versions', 'node');
    for (const version of await readdir(root).catch(() => [] as string[])) candidates.push(path.join(root, version, 'bin', 'codex'));
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      // Windows cannot spawn npm's .cmd shim without cmd.exe. Locate npm's native
      // executable instead, so user-controlled paths never become shell input.
      if (process.platform === 'win32' && /\.cmd$/i.test(candidate)) {
        const native = await npmNativeBinary(path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex'));
        if (native) return native;
        continue;
      }
      const resolved = await realpath(candidate);
      if (/[/\\]bin[/\\]codex\.js$/i.test(resolved)) {
        const native = await npmNativeBinary(path.resolve(path.dirname(resolved), '..'));
        if (native) return native;
        continue;
      }
      return resolved;
    } catch { /* try next installation */ }
  }
  throw new Error(selected
    ? 'The selected Codex executable was not found or is not executable. Select the codex binary, not a shell command.'
    : 'Codex CLI was not found. Install Codex CLI, run codex login, or choose its executable in Settings.');
}

class AppServer {
  private nextId = 1;
  private buffer = '';
  private dead?: Error;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(message: RpcMessage) => void>();
  private closeListeners = new Set<(error: Error) => void>();
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  private child: ChildProcessWithoutNullStreams;

  constructor(binary: string, cwd: string, runtime: { sqliteHome: string; bootstrapHome?: string }) {
    const args = ['app-server', '--listen', 'stdio://'];
    // Suppress environment/tool side effects during startup as well as per thread.
    for (const [key, value] of Object.entries(TEXT_CONFIG)) args.push('-c', `${key}=${JSON.stringify(value)}`);
    args.push('-c', `sqlite_home=${JSON.stringify(runtime.sqliteHome)}`, '-c', `log_dir=${JSON.stringify(path.join(runtime.sqliteHome, 'logs'))}`);
    const env = { ...process.env };
    // A launch from Codex Desktop must not inherit its active chat/runtime wiring.
    // Preserve the user's actual CLI home and intentional API-key environment.
    for (const key of Object.keys(env)) if (key.startsWith('CODEX_') && key !== 'CODEX_HOME' && key !== 'CODEX_API_KEY') delete env[key];
    if (runtime.bootstrapHome) {
      env.CODEX_HOME = runtime.bootstrapHome;
      delete env.CODEX_API_KEY;
      delete env.OPENAI_API_KEY;
    }
    this.child = spawn(binary, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.closed = new Promise(resolve => this.child.once('close', () => resolve()));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (data: string) => this.receive(data));
    // Drain stderr without exposing account data or inheriting terminal output.
    this.child.stderr.resume();
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex CLI exited (${signal || code || 'closed'}). Check the CLI path and sign-in, then retry.`)));
    this.ready = this.request('initialize', {
      clientInfo: { name: 'meeting_copilot', title: 'MeetingCopilot', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    }).then(() => this.send({ method: 'initialized' })).catch(error => { this.fail(asError(error)); throw error; });
  }

  get alive(): boolean { return !this.dead; }

  request(method: string, params: JsonObject = {}): Promise<any> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // An unanswered setup request might have created a thread or turn.
        // Restarting bounds that work and rejects every affected caller.
        const error = new Error(`Codex CLI timed out during ${method}. Check the CLI and try again.`);
        reject(error);
        this.fail(error);
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { this.fail(asError(error)); }
    });
  }

  subscribe(listener: (message: RpcMessage) => void, onClose: (error: Error) => void): () => void {
    this.listeners.add(listener);
    this.closeListeners.add(onClose);
    if (this.dead) onClose(this.dead);
    return () => { this.listeners.delete(listener); this.closeListeners.delete(onClose); };
  }

  dispose(): void { this.fail(new Error('Codex connection closed.')); }

  private send(message: RpcMessage): void {
    if (this.dead) throw this.dead;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(data: string): void {
    if (this.dead) return;
    this.buffer += data;
    if (this.buffer.length > MAX_LINE_BYTES) { this.fail(new Error('Codex sent an oversized protocol message.')); return; }
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { this.fail(new Error('Codex sent invalid JSON. Update Codex CLI and try again.')); return; }
      if (!message || typeof message !== 'object') continue;
      if (message.id !== undefined && message.method) {
        // This integration never grants tool, permission, or interactive requests.
        this.send({ id: message.id, error: { code: -32601, message: 'MeetingCopilot does not permit tool execution or interactive requests.' } });
      } else if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'Codex request failed.'));
        else pending.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    }
  }

  private fail(error: Error): void {
    if (this.dead) return;
    this.dead = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of [...this.closeListeners]) listener(error);
    this.listeners.clear();
    this.closeListeners.clear();
    this.child.stdin.end();
    this.child.kill();
    const forceStop = setTimeout(() => this.child.kill('SIGKILL'), 1_000);
    forceStop.unref();
    void this.closed.then(() => clearTimeout(forceStop));
  }
}

function parts(content: ChatMessage['content']): ChatContentPart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function imageUrl(url: string): string {
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return url;
  } catch { /* report the actionable error below */ }
  throw new Error('Codex images must be image data URLs or HTTP(S) URLs. Local file URLs are not accepted.');
}

function prepareMessages(messages: ChatMessage[]): { instructions: string; history: JsonObject[]; input: JsonObject[] } {
  const system = messages.filter(message => message.role === 'system').map(message => parts(message.content).map(part => {
    if (part.type !== 'text') throw new Error('System instructions cannot contain images.');
    return part.text;
  }).join('\n')).join('\n\n');
  const conversation = messages.filter(message => message.role !== 'system');
  const last = conversation.at(-1);
  if (!last || last.role !== 'user') throw new Error('A Codex request must end with a user message.');
  const history = conversation.slice(0, -1).map(message => ({
    type: 'message',
    role: message.role,
    content: parts(message.content).map(part => {
      if (part.type === 'text') return { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
      if (message.role !== 'user') throw new Error('Only user messages can contain images.');
      return { type: 'input_image', image_url: imageUrl(part.image_url.url) };
    }),
  }));
  return {
    instructions: [TEXT_INSTRUCTIONS, system].filter(Boolean).join('\n\n'),
    history,
    input: parts(last.content).map(part => part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image', url: imageUrl(part.image_url.url) }),
  };
}

/** Independent requests use independent ephemeral threads on one warm CLI process. */
export class CodexClient {
  private connections = new Map<string, Promise<AppServer>>();
  private activeServers = new Set<AppServer>();
  private disposed = false;
  constructor(private readonly options: { cwd: string }) {}

  private async connection(binary: string): Promise<AppServer> {
    if (this.disposed) throw new Error('Codex client has been disposed.');
    let pending = this.connections.get(binary);
    if (pending) {
      const existing = await pending;
      if (existing.alive) return existing;
      if (this.connections.get(binary) !== pending) return this.connection(binary);
      this.connections.delete(binary);
    }
    pending = (async () => {
      await mkdir(this.options.cwd, { recursive: true });
      if (this.disposed) throw new Error('Codex client has been disposed.');
      const metadata = await stat(binary);
      const versionKey = createHash('sha256').update(`${binary}:${metadata.size}:${metadata.mtimeMs}`).digest('hex').slice(0, 16);
      const runtimeRoot = path.join(this.options.cwd, 'cli-runtime', versionKey);
      const bootstrapHome = path.join(runtimeRoot, 'bootstrap');
      const sqliteHome = path.join(runtimeRoot, 'state');
      await mkdir(bootstrapHome, { recursive: true });
      await mkdir(sqliteHome, { recursive: true });
      const start = (bootstrap = false) => {
        if (this.disposed) throw new Error('Codex client has been disposed.');
        const server = new AppServer(binary, this.options.cwd, { sqliteHome, ...(bootstrap ? { bootstrapHome } : {}) });
        this.activeServers.add(server);
        void server.closed.then(() => this.activeServers.delete(server));
        return server;
      };
      // Codex initializes its state DB by indexing CODEX_HOME's existing chats.
      // First initialize OUR state with an empty, app-owned home, then reconnect
      // with the real CLI home for login. Only official CLI/config APIs are used:
      // no credentials copied, no SQL edits, no changes to the user's database.
      // Repeat this tiny bootstrap on each connection (idempotent); a new binary
      // version receives a new state directory, avoiding cross-version migrations.
      const bootstrap = start(true);
      try { await bootstrap.ready; } finally { bootstrap.dispose(); await bootstrap.closed; }
      const server = start();
      await server.ready;
      if (this.disposed) { server.dispose(); throw new Error('Codex client has been disposed.'); }
      return server;
    })();
    this.connections.set(binary, pending);
    try { return await pending; } catch (error) {
      if (this.connections.get(binary) === pending) this.connections.delete(binary);
      throw error;
    }
  }

  async check(config: CodexSettings = {}): Promise<CodexStatus> {
    let binaryPath: string | undefined;
    let authenticated = false;
    let accountType: string | undefined;
    try {
      binaryPath = await discoverCodexBinary(config.binaryPath);
      const server = await this.connection(binaryPath);
      const account = await server.request('account/read', { refreshToken: false });
      authenticated = !!account?.account || account?.requiresOpenaiAuth === false;
      accountType = account?.account?.type;
      const models: CodexModel[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const result = await server.request('model/list', { ...(cursor ? { cursor } : {}), limit: 100 });
        for (const model of result?.data || []) {
          if (!model || model.hidden || typeof model.model !== 'string' || seen.has(model.model)) continue;
          seen.add(model.model);
          models.push({ id: model.model, displayName: model.displayName || model.model, isDefault: !!model.isDefault,
            defaultReasoningEffort: model.defaultReasoningEffort,
            supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [] });
        }
        const next = result?.nextCursor;
        if (next && next === cursor) throw new Error('Codex returned a repeated model-list cursor.');
        cursor = typeof next === 'string' && next ? next : undefined;
      } while (cursor);
      return { installed: true, authenticated, binaryPath, accountType, models,
        ...(!authenticated ? { error: 'Codex is installed. Run codex login in your terminal, then check again.' } : {}) };
    } catch (error) {
      return { installed: !!binaryPath, authenticated, binaryPath, accountType, models: [], error: asError(error).message };
    }
  }

  async chat(config: CodexSettings, messages: ChatMessage[], callbacks: ChatStreamCallbacks, signal?: AbortSignal): Promise<ChatResult> {
    if (signal?.aborted) throw abortError();
    const prepared = prepareMessages(messages);
    const binary = await abortable(discoverCodexBinary(config.binaryPath), signal);
    const server = await abortable(this.connection(binary), signal);
    if (signal?.aborted) throw abortError();
    return new Promise<ChatResult>((resolve, reject) => {
      let threadId: string | undefined;
      let turnId: string | undefined;
      let done = false;
      let text = '';
      const completedItems = new Set<string>();
      const itemText = new Map<string, string>();
      let unsubscribe = () => {};
      const cleanupThread = async (interrupt: boolean) => {
        if (!threadId || !server.alive) return;
        if (interrupt && turnId) await server.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        await server.request('thread/unsubscribe', { threadId }).catch(() => {});
      };
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        unsubscribe();
        void cleanupThread(!!error);
        if (error) reject(error); else resolve({ text });
      };
      const abort = () => finish(abortError());
      const timer = setTimeout(() => finish(new Error('Codex response timed out after three minutes. Try a faster model or lower reasoning effort.')), TURN_TIMEOUT_MS);
      signal?.addEventListener('abort', abort, { once: true });
      const append = (id: string, delta: string) => {
        if (!delta || done) return;
        itemText.set(id, (itemText.get(id) || '') + delta);
        text += delta;
        callbacks.onDelta(delta);
      };
      unsubscribe = server.subscribe(message => {
        const params = message.params;
        if (done || !threadId || params?.threadId !== threadId) return;
        if (turnId && params?.turnId && params.turnId !== turnId) return;
        try {
          if (message.method === 'turn/started') turnId = params?.turn?.id || turnId;
          else if (message.method === 'item/agentMessage/delta') {
            if (typeof params?.delta === 'string') append(params.itemId || '', params.delta);
          } else if (message.method === 'item/completed' && params?.item?.type === 'agentMessage') {
            const item = params.item;
            if (!completedItems.has(item.id) && typeof item.text === 'string') {
              // Older servers may send only item/completed. Never double-append deltas.
              const previous = itemText.get(item.id) || '';
              if (item.text.startsWith(previous)) append(item.id, item.text.slice(previous.length));
              completedItems.add(item.id);
            }
          } else if (message.method === 'turn/completed') {
            const turn = params?.turn;
            if (turnId && turn?.id !== turnId) return;
            if (turn?.status === 'failed') finish(new Error(turn.error?.message || 'Codex failed to generate a response.'));
            else if (turn?.status === 'interrupted') finish(abortError());
            else if (turn?.status === 'completed') finish(text ? undefined : new Error('Codex completed without an answer. Try another model.'));
          }
        } catch (error) { finish(asError(error)); }
      }, error => finish(error));

      void (async () => {
        try {
          // Config tables merge: mcp_servers={} does NOT remove inherited servers.
          // Ask the CLI for effective names and explicitly disable each one before
          // creating a thread. Never forward, persist, or log configuration values.
          const effective = await server.request('config/read', { includeLayers: false, cwd: this.options.cwd });
          const serverNames = Object.keys(effective?.config?.mcp_servers || {});
          const threadConfig = { ...TEXT_CONFIG, mcp_servers: Object.fromEntries(serverNames.map(name => [name, { enabled: false }])) };
          if (done) return;
          const created = await server.request('thread/start', {
            cwd: this.options.cwd,
            ...(config.model?.trim() ? { model: config.model.trim() } : {}),
            approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
            environments: [], dynamicTools: [],
            baseInstructions: prepared.instructions, developerInstructions: TEXT_INSTRUCTIONS,
            config: threadConfig,
          });
          threadId = created?.thread?.id;
          if (!threadId) throw new Error('Codex did not create a conversation. Update Codex CLI and try again.');
          if (done) { await cleanupThread(false); return; }
          if (prepared.history.length) await server.request('thread/inject_items', { threadId, items: prepared.history });
          if (done) { await cleanupThread(false); return; }
          const started = await server.request('turn/start', {
            threadId, input: prepared.input, environments: [], approvalPolicy: 'never',
            sandboxPolicy: { type: 'readOnly', networkAccess: false },
            ...(config.model?.trim() ? { model: config.model.trim() } : {}),
            ...(config.reasoningEffort ? { effort: config.reasoningEffort } : {}),
          });
          turnId = started?.turn?.id || turnId;
          if (done) { await cleanupThread(true); return; }
          if (!turnId) throw new Error('Codex did not start a response. Update Codex CLI and try again.');
          if (started.turn.status === 'failed') finish(new Error(started.turn.error?.message || 'Codex failed to start.'));
        } catch (error) { finish(asError(error)); }
      })();
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const servers = [...this.activeServers];
    for (const server of servers) server.dispose();
    this.activeServers.clear();
    this.connections.clear();
    await Promise.all(servers.map(server => server.closed));
  }
}

/**
 * Auto-managed local ASR sidecar. When the streaming ASR backend points at
 * ws://127.0.0.1:<port>, the app spawns tools/funasr_stream_server.py itself
 * for FunASR, or tools/moss_asr_server.py for MOSS-Transcribe-Diarize, and
 * reaps it on quit — selecting the local preset is all the user does.
 *
 * If something already listens on the port (sidecar started manually or left
 * over), it is reused and never killed by us — we only reap processes we
 * spawned.
 *
 * `appRoot` throughout this file is the *resource root* (see
 * electron/resourcePaths.ts): the repo root in development, `resources/` in a
 * packaged build. It must always be a real directory — it is both the script
 * lookup base (`<appRoot>/tools/*.py`) and the spawn cwd, and python can do
 * neither inside app.asar.
 */
import { spawn, execFile, type ChildProcess } from 'child_process';
import { connect } from 'net';
import { existsSync, statSync } from 'fs';
import { isAbsolute, join, posix, win32 } from 'path';

const DEFAULT_PYTHON = 'C:\\ProgramData\\miniconda3\\envs\\funasr\\python.exe';
const DEFAULT_MOSS_PYTHON = 'C:\\ProgramData\\miniconda3\\envs\\moss-asr\\python.exe';
/** model load + warm; first-ever run also downloads the selected model */
const READY_TIMEOUT_MS = 15 * 60_000;

export function pythonCandidates(
  appRoot: string,
  platform: string = process.platform,
  explicit: string | undefined = process.env.MC_FUNASR_PYTHON,
): string[] {
  // join per the REQUESTED platform, not the host — keeps the function (and
  // its tests) deterministic when asked about a foreign platform
  const j = platform === 'win32' ? win32.join : posix.join;
  // dev-only convenience: a packaged build has no <resources>/.venv, and that
  // is fine — resolvePython() only probes, so a missing path just fails over
  // to the next candidate instead of throwing
  const venv =
    platform === 'win32'
      ? j(appRoot, '.venv', 'Scripts', 'python.exe')
      : j(appRoot, '.venv', 'bin', 'python');
  const candidates = [
    explicit,
    venv,
    ...(platform === 'win32' ? [DEFAULT_PYTHON, 'python'] : ['python3', 'python']),
  ].filter((v): v is string => !!v);
  return [...new Set(candidates)];
}

export function mossPythonCandidates(
  appRoot: string,
  platform: string = process.platform,
  explicit: string | undefined = process.env.MC_MOSS_PYTHON,
): string[] {
  const j = platform === 'win32' ? win32.join : posix.join;
  const venv =
    platform === 'win32'
      ? j(appRoot, '.venv-moss', 'Scripts', 'python.exe')
      : j(appRoot, '.venv-moss', 'bin', 'python');
  const candidates = [
    explicit,
    venv,
    ...(platform === 'win32' ? [DEFAULT_MOSS_PYTHON] : ['python3', 'python']),
  ].filter((v): v is string => !!v);
  return [...new Set(candidates)];
}

async function canRunPython(candidate: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(candidate, ['--version'], { timeout: 5_000 }, (error, stdout, stderr) =>
      resolve(!error && /^Python 3\.\d+/.test(`${stdout}${stderr}`.trim())),
    );
  });
}

export async function resolvePython(
  candidates: string[],
  probe: (candidate: string) => Promise<boolean> = canRunPython,
): Promise<string> {
  for (const candidate of candidates) {
    if (await probe(candidate)) return candidate;
  }
  throw new Error(
    'no usable Python found; set a Python path in Settings or MC_FUNASR_PYTHON',
  );
}

/** An explicit saved path is authoritative: never silently use a different Python. */
export async function resolveConfiguredPython(
  configuredPath: string | undefined,
  candidates: string[],
  probe: (candidate: string) => Promise<boolean> = canRunPython,
): Promise<string> {
  const chosen = configuredPath?.trim();
  if (!chosen) return resolvePython(candidates, probe);
  if (!isAbsolute(chosen)) {
    throw new Error('FunASR Python path must be absolute');
  }
  let fileExists = false;
  try {
    fileExists = existsSync(chosen) && statSync(chosen).isFile();
  } catch {
    // A path with broken symlinks or unreadable components is equally unusable.
  }
  if (!fileExists) {
    throw new Error('FunASR Python interpreter does not exist');
  }
  if (!(await probe(chosen))) {
    throw new Error('FunASR Python cannot run --version');
  }
  return chosen;
}

export type LocalSidecarModel = 'nano' | 'paraformer' | 'moss';

export function sidecarModelArg(model: string | undefined): LocalSidecarModel {
  if (model?.toLowerCase().includes('moss')) return 'moss';
  return model?.toLowerCase().includes('paraformer') ? 'paraformer' : 'nano';
}

export function sidecarEnvironment(
  modelArg: LocalSidecarModel,
  base: NodeJS.ProcessEnv = process.env,
  modelscopeCache?: string,
): NodeJS.ProcessEnv {
  // Packaged scripts live in signed Resources/tools. A .pyc written there
  // after launch invalidates the macOS code signature's sealed resources.
  const env: NodeJS.ProcessEnv = { ...base, PYTHONDONTWRITEBYTECODE: '1' };
  if (modelArg !== 'moss') {
    if (modelscopeCache && !env.MODELSCOPE_CACHE) env.MODELSCOPE_CACHE = modelscopeCache;
    return env;
  }
  // hf-xet stalled on the reviewed Windows/TUN setup before writing any
  // weight bytes; regular Hub HTTP downloaded the same pinned snapshot
  // immediately and supports the normal cache/resume path.
  return { ...env, HF_HUB_DISABLE_XET: env.HF_HUB_DISABLE_XET || '1' };
}

export function sidecarLaunchArgs(
  modelArg: LocalSidecarModel,
  script: string,
  port: number,
  mossDevice = process.env.MC_MOSS_DEVICE || 'auto',
): string[] {
  // -B also prevents bytecode writes if the inherited environment changes.
  return modelArg === 'moss'
    ? ['-B', script, '--port', String(port), '--device', mossDevice]
    : ['-B', script, '--port', String(port), '--model', modelArg, '--device', 'auto'];
}

export type SidecarStopPlan =
  | { kind: 'command'; file: string; args: string[] }
  | { kind: 'signal'; pid: number; signal: NodeJS.Signals };

export function sidecarStopPlan(platform: string, pid: number): SidecarStopPlan {
  if (platform === 'win32') {
    return { kind: 'command', file: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] };
  }
  return { kind: 'signal', pid: -pid, signal: 'SIGTERM' };
}

/** ws://127.0.0.1:10097/... -> 10097; null for anything non-local (pure, tested) */
export function parseLocalWsPort(url: string | undefined): number | null {
  if (!url) return null;
  const m = /^ws:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?(?:\/|$)/i.exec(url.trim());
  if (!m) return null;
  return m[1] ? parseInt(m[1], 10) : 80;
}

function portOpen(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

export class FunasrSidecar {
  private proc: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private modelArg: LocalSidecarModel | null = null;
  private configuredPythonPath: string | null = null;

  /** make sure something serves the port; spawn the python sidecar if needed */
  async ensureRunning(
    port: number,
    appRoot: string,
    model?: string,
    pythonPath?: string,
    modelscopeCache?: string,
  ): Promise<void> {
    const requestedModel = sidecarModelArg(model);
    const requestedPath = requestedModel === 'moss' ? null : pythonPath?.trim() || null;
    if (this.proc && (this.modelArg !== requestedModel || this.configuredPythonPath !== requestedPath)) {
      await this.stop();
    }
    if (await portOpen(port)) return; // manual instance or an earlier spawn
    if (!this.starting) {
      this.starting = this.spawnAndWait(port, appRoot, requestedModel, requestedPath, modelscopeCache).finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async spawnAndWait(
    port: number,
    appRoot: string,
    modelArg: LocalSidecarModel,
    configuredPythonPath: string | null,
    modelscopeCache?: string,
  ): Promise<void> {
    const isMoss = modelArg === 'moss';
    const python = isMoss
      ? await resolvePython(mossPythonCandidates(appRoot))
      : await resolveConfiguredPython(configuredPythonPath ?? undefined, pythonCandidates(appRoot));
    const script = join(appRoot, 'tools', isMoss ? 'moss_asr_server.py' : 'funasr_stream_server.py');
    if (!existsSync(script)) {
      throw new Error(`sidecar script not found: ${script}`);
    }
    console.log(
      `[sidecar] spawning local ASR model=${modelArg} on :${port} (first load can take several minutes)`,
    );
    return new Promise((resolve, reject) => {
      const proc = spawn(
        python,
        sidecarLaunchArgs(modelArg, script, port),
        {
          cwd: appRoot,
          windowsHide: true,
          detached: process.platform !== 'win32',
          env: sidecarEnvironment(modelArg, process.env, modelscopeCache),
        },
      );
      this.proc = proc;
      this.modelArg = modelArg;
      this.configuredPythonPath = configuredPythonPath;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => {
          void this.stop().finally(() =>
            reject(
              new Error(
                'the local ASR engine was not ready within 15 minutes (check the model download and the python log)',
              ),
            ),
          );
        });
      }, READY_TIMEOUT_MS);
      proc.stdout?.on('data', (d: Buffer) => {
        const s = d.toString();
        process.stdout.write(`[sidecar] ${s}`);
        if (s.includes(isMoss ? 'MOSS_ASR_READY' : 'FUNASR_READY')) settle(resolve);
      });
      proc.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
      proc.on('exit', (code) => {
        this.proc = null;
        this.modelArg = null;
        this.configuredPythonPath = null;
        const envName = isMoss ? 'moss-asr' : 'funasr';
        settle(() =>
          reject(new Error(`the local ASR engine exited (code ${code}); check the conda env "${envName}"`)),
        );
      });
      proc.on('error', (e) => settle(() => reject(e)));
    });
  }

  /** reap only what we spawned; kill the whole tree (python may have children) */
  async stop(): Promise<void> {
    const p = this.proc;
    this.proc = null;
    this.modelArg = null;
    this.configuredPythonPath = null;
    if (!p?.pid) return;
    let didExit = false;
    const exited = new Promise<void>((resolve) =>
      p.once('exit', () => {
        didExit = true;
        resolve();
      }),
    );
    const plan = sidecarStopPlan(process.platform, p.pid);
    try {
      if (plan.kind === 'command') {
        execFile(plan.file, plan.args, () => undefined);
      } else {
        process.kill(plan.pid, plan.signal);
      }
    } catch {
      p.kill('SIGTERM');
    }
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    if (!didExit) {
      try {
        if (process.platform === 'win32') p.kill();
        else process.kill(-p.pid, 'SIGKILL');
      } catch {
        p.kill('SIGKILL');
      }
    }
  }
}

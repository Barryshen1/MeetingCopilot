/**
 * macOS 📷: capture the window the user is working in (not the whole display)
 * through the bundled `mc-window-shot` helper (native/mac-window-shot).
 *
 * Only that window's pixels are captured, so MeetingCopilot never appears in
 * the image and does not have to be hidden first (隐身 stays intact: the
 * overlay keeps its content protection and never flickers). The helper
 * reports a missing Screen Recording grant explicitly instead of returning a
 * wallpaper-only picture.
 */
import { execFile } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export function windowShotHelperPath(resourceRoot: string): string {
  return join(resourceRoot, 'resources', 'bin', 'mc-window-shot');
}

export type WindowShotErrorCode = 'permission' | 'no-window' | 'capture' | 'unavailable';

export class WindowShotError extends Error {
  constructor(
    readonly code: WindowShotErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface WindowShot {
  dataUrl: string;
  app: string;
  title: string;
  width: number;
  height: number;
}

interface HelperResult {
  ok: boolean;
  code?: string;
  message?: string;
  app?: string;
  title?: string;
  width?: number;
  height?: number;
}

/** the helper's JSON line (the last non-empty stdout line); pure, tested */
export function parseHelperOutput(stdout: string): HelperResult | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]) as HelperResult;
      if (j && typeof j === 'object' && typeof j.ok === 'boolean') return j;
    } catch {
      /* not the JSON line */
    }
  }
  return null;
}

function errorCode(code: string | undefined): WindowShotErrorCode {
  return code === 'permission' || code === 'no-window' ? code : 'capture';
}

/** "Google Chrome · Positional Encoding - NeetCode" (title omitted when empty or redundant) */
export function windowLabel(app: string, title: string): string {
  const a = app.trim();
  const t = title.trim();
  if (!t || t === a) return a;
  if (!a) return t;
  return `${a} · ${t}`;
}

export async function captureWorkingWindow(opts: {
  helperPath: string;
  excludePids: number[];
  excludeBundleIds?: string[];
  maxEdge?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<WindowShot> {
  if (!existsSync(opts.helperPath)) throw new WindowShotError('unavailable', 'window capture helper is missing');
  const dir = mkdtempSync(join(tmpdir(), 'mc-shot-'));
  const out = join(dir, 'window.png');
  const args = ['--out', out, '--max-edge', String(opts.maxEdge ?? 2400)];
  for (const pid of opts.excludePids) args.push('--exclude-pid', String(pid));
  for (const id of opts.excludeBundleIds ?? []) args.push('--exclude-bundle', id);
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        opts.helperPath,
        args,
        { timeout: opts.timeoutMs ?? 15_000, signal: opts.signal, maxBuffer: 1024 * 1024 },
        (error, out) => {
          // a non-zero exit still carries the JSON verdict on stdout
          if (out && parseHelperOutput(out)) resolve(out);
          else if (error) reject(error);
          else resolve(out ?? '');
        },
      );
      child.stdin?.end();
    });
    const result = parseHelperOutput(stdout);
    if (!result) throw new WindowShotError('capture', 'window capture helper gave no answer');
    if (!result.ok) throw new WindowShotError(errorCode(result.code), result.message ?? 'window capture failed');
    const png = readFileSync(out);
    if (!png.length) throw new WindowShotError('capture', 'window capture produced an empty image');
    return {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      app: result.app ?? '',
      title: result.title ?? '',
      width: result.width ?? 0,
      height: result.height ?? 0,
    };
  } catch (error) {
    if (error instanceof WindowShotError) throw error;
    if (opts.signal?.aborted) throw opts.signal.reason ?? error;
    throw new WindowShotError('capture', (error as Error).message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

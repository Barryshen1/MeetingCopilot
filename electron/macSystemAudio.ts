/**
 * macOS "对方" channel: what the Mac is playing, captured by the bundled
 * mc-system-audio helper (Core Audio process tap, macOS 14.2+). It never
 * opens a microphone, so the user's own voice only reaches the transcript
 * through the separate 🎤 channel.
 *
 * The helper writes 16 kHz mono Float32 PCM to stdout; this host cuts it into
 * the same 1600-sample (100 ms) frames the renderer's PCM worklet produces.
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export const SYSTEM_AUDIO_FRAME_SAMPLES = 1600;
const FRAME_BYTES = SYSTEM_AUDIO_FRAME_SAMPLES * 4;

export function systemAudioHelperPath(resourceRoot: string): string {
  return join(resourceRoot, 'resources', 'bin', 'mc-system-audio');
}

/** Splits a byte stream into whole Float32 frames; keeps the remainder. */
export class PcmFramer {
  private pending = Buffer.alloc(0);
  constructor(private readonly onFrame: (frame: ArrayBuffer) => void) {}

  push(chunk: Buffer): void {
    let data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (data.length >= FRAME_BYTES) {
      // copy into a fresh, aligned ArrayBuffer (Buffer slices share a pool)
      const frame = new ArrayBuffer(FRAME_BYTES);
      new Uint8Array(frame).set(data.subarray(0, FRAME_BYTES));
      this.onFrame(frame);
      data = data.subarray(FRAME_BYTES);
    }
    this.pending = Buffer.from(data);
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
  }
}

export interface SystemAudioCallbacks {
  onPcm: (frame: ArrayBuffer, captureTs: number) => void;
  /** the helper died after it had started (device change, permission revoked) */
  onFailure?: (message: string) => void;
  onLevel?: (rms: number) => void;
}

export class MacSystemAudio {
  private child: ChildProcess | null = null;

  constructor(private readonly helperPath: string) {}

  get running(): boolean {
    return this.child !== null;
  }

  get available(): boolean {
    return process.platform === 'darwin' && existsSync(this.helperPath);
  }

  /** Resolves once the tap is running; rejects with the helper's reason. */
  start(cb: SystemAudioCallbacks): Promise<void> {
    if (this.child) return Promise.resolve();
    if (!this.available) return Promise.reject(new Error(`system audio helper not found at ${this.helperPath}`));
    const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const framer = new PcmFramer((frame) => cb.onPcm(frame, Date.now()));
    let started = false;
    let lastError = '';
    let stderrBuf = '';

    return new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (chunk: Buffer) => framer.push(chunk));
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (text: string) => {
        stderrBuf += text;
        let i: number;
        while ((i = stderrBuf.indexOf('\n')) >= 0) {
          const line = stderrBuf.slice(0, i).trim();
          stderrBuf = stderrBuf.slice(i + 1);
          if (line.startsWith('ready')) {
            started = true;
            console.log(`[sysaudio] ${line}`);
            resolve();
          } else if (line.startsWith('level ')) {
            cb.onLevel?.(Number(line.slice(6)) || 0);
          } else if (line.startsWith('error ')) {
            lastError = line.replace(/^error \d+ /, '');
            console.warn(`[sysaudio] ${line}`);
          }
        }
      });
      child.on('error', (e) => {
        lastError = e.message;
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) this.child = null;
        framer.reset();
        const message = lastError || `system audio helper exited (${signal ?? code})`;
        if (!started) reject(new Error(message));
        else if (code !== 0 && signal !== 'SIGTERM') cb.onFailure?.(message);
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.stdin?.end();
      child.kill('SIGTERM');
    });
  }
}

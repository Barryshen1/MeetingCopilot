import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  WindowShotError,
  captureWorkingWindow,
  parseHelperOutput,
  windowLabel,
  windowShotHelperPath,
} from '../electron/macWindowShot';

describe('parseHelperOutput', () => {
  it('reads the last JSON line and ignores noise', () => {
    expect(parseHelperOutput('warning: something\n{"ok":true,"app":"Google Chrome","title":"NeetCode","width":2400,"height":1500}\n'))
      .toEqual({ ok: true, app: 'Google Chrome', title: 'NeetCode', width: 2400, height: 1500 });
    expect(parseHelperOutput('{"ok":false,"code":"permission","message":"no"}')?.code).toBe('permission');
    expect(parseHelperOutput('')).toBeNull();
    expect(parseHelperOutput('not json\n[1,2]')).toBeNull();
  });
});

describe('windowLabel', () => {
  it('names the app and the window, without repeating itself', () => {
    expect(windowLabel('Google Chrome', 'Positional Encoding - NeetCode')).toBe('Google Chrome · Positional Encoding - NeetCode');
    expect(windowLabel('Preview', '')).toBe('Preview');
    expect(windowLabel('Notes', 'Notes')).toBe('Notes');
    expect(windowLabel('', 'Untitled')).toBe('Untitled');
  });
});

describe('captureWorkingWindow (fake helper)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  /** a stand-in for mc-window-shot: records its arguments, writes a "PNG" to --out */
  function fakeHelper(body: string): string {
    dir = mkdtempSync(join(tmpdir(), 'mc-fake-shot-'));
    const path = join(dir, 'mc-window-shot');
    writeFileSync(path, `#!/bin/sh\necho "$@" > "${dir}/args"\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it('returns the image and the window it came from, excluding MeetingCopilot', async () => {
    const helperPath = fakeHelper(
      'out=""; while [ $# -gt 0 ]; do if [ "$1" = "--out" ]; then out="$2"; fi; shift; done\n' +
        'printf "PNGDATA" > "$out"\n' +
        'echo \'{"ok":true,"windowId":7,"app":"Google Chrome","title":"Docs","width":1200,"height":800}\'',
    );
    const shot = await captureWorkingWindow({ helperPath, excludePids: [4242], excludeBundleIds: ['io.github.barryshen1.meetingcopilot'] });
    expect(shot).toEqual({
      dataUrl: `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`,
      app: 'Google Chrome',
      title: 'Docs',
      width: 1200,
      height: 800,
    });
    const { readFileSync } = await import('fs');
    const args = readFileSync(join(dir, 'args'), 'utf8');
    expect(args).toContain('--exclude-pid 4242');
    expect(args).toContain('--exclude-bundle io.github.barryshen1.meetingcopilot');
    expect(args).toContain('--max-edge 2400');
  });

  it('reports a missing Screen Recording grant as a permission error', async () => {
    const helperPath = fakeHelper('echo \'{"ok":false,"code":"permission","message":"Screen Recording permission is not granted"}\'; exit 1');
    await expect(captureWorkingWindow({ helperPath, excludePids: [] })).rejects.toMatchObject({
      code: 'permission',
    });
  });

  it('reports no open window, and a missing helper, distinctly', async () => {
    const helperPath = fakeHelper('echo \'{"ok":false,"code":"no-window","message":"none"}\'; exit 1');
    await expect(captureWorkingWindow({ helperPath, excludePids: [] })).rejects.toMatchObject({ code: 'no-window' });
    await expect(captureWorkingWindow({ helperPath: join(dir, 'missing'), excludePids: [] })).rejects.toBeInstanceOf(WindowShotError);
    await expect(captureWorkingWindow({ helperPath: join(dir, 'missing'), excludePids: [] })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('treats a helper that crashes without an answer as a capture error', async () => {
    const helperPath = fakeHelper('echo boom >&2; exit 3');
    await expect(captureWorkingWindow({ helperPath, excludePids: [] })).rejects.toMatchObject({ code: 'capture' });
  });
});

describe('windowShotHelperPath', () => {
  it('lives next to the system-audio helper', () => {
    expect(windowShotHelperPath('/App/Resources')).toBe(join('/App/Resources', 'resources', 'bin', 'mc-window-shot'));
  });
});

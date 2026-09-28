import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { revealAppWindow } from '../electron/windowReveal';

/** records the order of the calls, like the real restore -> show -> focus */
function fakeWindow({ minimized = false, destroyed = false } = {}) {
  const calls: string[] = [];
  let isMin = minimized;
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => isMin,
    restore: () => {
      calls.push('restore');
      isMin = false;
    },
    show: () => {
      calls.push('show');
    },
    focus: () => {
      calls.push('focus');
    },
  };
}

describe('revealAppWindow', () => {
  it('shows and focuses a hidden main window', () => {
    const main = fakeWindow();
    expect(revealAppWindow(null, main)).toBe(main);
    expect(main.calls).toEqual(['show', 'focus']);
  });

  it('restores a minimised window before showing it', () => {
    const main = fakeWindow({ minimized: true });
    revealAppWindow(null, main);
    expect(main.calls).toEqual(['restore', 'show', 'focus']);
  });

  it('prefers the setup wizard while it is open', () => {
    const setup = fakeWindow({ minimized: true });
    const main = fakeWindow();
    expect(revealAppWindow(setup, main)).toBe(setup);
    expect(setup.calls).toEqual(['restore', 'show', 'focus']);
    expect(main.calls).toEqual([]);
  });

  it('skips destroyed windows and is a no-op when none is left', () => {
    const setup = fakeWindow({ destroyed: true });
    const main = fakeWindow();
    expect(revealAppWindow(setup, main)).toBe(main);
    expect(setup.calls).toEqual([]);
    expect(main.calls).toEqual(['show', 'focus']);

    expect(revealAppWindow(null, fakeWindow({ destroyed: true }))).toBeNull();
    expect(revealAppWindow(undefined, null)).toBeNull();
  });
});

describe('main process wiring', () => {
  // main.ts has no Electron test harness; this pins the regression itself. On
  // macOS a Dock-icon click on the running app only arrives as `activate`.
  const main = readFileSync(join(process.cwd(), 'electron', 'main.ts'), 'utf8');

  it('reveals the window when the Dock icon is clicked (activate)', () => {
    expect(main).toMatch(/app\.on\(\s*'activate'[\s\S]{0,500}?revealAppWindow\(setupWin, win\)/);
  });

  it('reveals the window on a second launch (second-instance)', () => {
    expect(main).toMatch(/app\.on\(\s*'second-instance'[\s\S]{0,200}?revealAppWindow\(setupWin, win\)/);
  });
});

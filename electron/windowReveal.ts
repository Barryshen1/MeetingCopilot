/**
 * "Bring MeetingCopilot back to the front" — shared by a second launch
 * (`second-instance`) and, on macOS, a click on the Dock icon of the running
 * app (`activate`).
 *
 * Kept out of main.ts so the behaviour is unit-testable with plain fakes, the
 * same way electron/screenshot.ts is.
 */
import type { BrowserWindow } from 'electron';

export type RevealableWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'isMinimized' | 'restore' | 'show' | 'focus'
>;

/**
 * The wizard wins while it is open (first run, or 重新运行配置向导); otherwise
 * the main overlay. A minimised window (⌘M) is restored first, a hidden one
 * (「—」 / the toggle hotkey / the tray) is shown, and either way it ends up
 * focused. Returns the window that was revealed, or null when there is none.
 */
export function revealAppWindow<W extends RevealableWindow>(
  setupWin: W | null | undefined,
  mainWin: W | null | undefined,
): W | null {
  const target = [setupWin, mainWin].find((w): w is W => !!w && !w.isDestroyed());
  if (!target) return null;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  return target;
}

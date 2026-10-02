export type CaptureKind = 'loopback' | 'input';

/** Electron's display-media loopback token is currently Windows-only. */
export function captureKindForPlatform(platform: string): CaptureKind {
  return platform === 'win32' ? 'loopback' : 'input';
}

/** Defaults apply only to newly created settings; saved user choices win. */
export function defaultHotkeysForPlatform(platform: string): { toggle: string; shot: string } {
  if (platform === 'darwin') {
    return { toggle: 'Command+B', shot: 'Command+Shift+S' };
  }
  return { toggle: 'Control+B', shot: 'Control+Shift+S' };
}

export function whisperExecutionProvidersForPlatform(
  platform: string,
): ('dml' | 'cpu')[] {
  return platform === 'win32' ? ['dml', 'cpu'] : ['cpu'];
}

/** "对方" source where the user picked no specific input device. */
export type ThemSource = 'loopback' | 'system' | 'input';

/**
 * Where the "对方" (other party) channel comes from.
 * - Windows: Electron's system loopback.
 * - macOS: always the bundled system-audio helper (what the Mac plays). An
 *   input device is never used for 对方 there: "default" is the built-in
 *   microphone, which recorded the user's own voice even with 🎤 off, and
 *   virtual devices such as BlackHole are no longer needed. A saved
 *   themDeviceId is ignored.
 * - Linux: the selected ordinary input.
 */
export function themSourceFor(platform: string, _themDeviceId?: string): ThemSource {
  if (platform === 'win32') return 'loopback';
  if (platform === 'darwin') return 'system';
  return 'input';
}

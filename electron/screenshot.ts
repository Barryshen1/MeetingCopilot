import type { BrowserWindow, DesktopCapturerSource, Display } from 'electron';

type CaptureWindow = Pick<BrowserWindow, 'isDestroyed' | 'isVisible' | 'hide' | 'showInactive'>;
type CaptureSources = (options: {
  types: Array<'screen'>;
  thumbnailSize: { width: number; height: number };
}) => Promise<DesktopCapturerSource[]>;

export class ScreenCaptureError extends Error {}

/** Keep the assistant hidden for the whole capture or region-selection flow. */
export async function withCaptureWindowHidden<T>(
  window: CaptureWindow | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const restore = window && !window.isDestroyed() && window.isVisible();
  try {
    if (restore) {
      window.hide();
      // Give the compositor and any app-owned popups time to disappear.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return await action();
  } finally {
    if (restore && !window.isDestroyed()) window.showInactive();
  }
}

async function waitForCapture(pending: Promise<DesktopCapturerSource[]>, signal?: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ScreenCaptureError('Screen capture timed out.')), 30_000);
    onAbort = () => reject(signal?.reason ?? new Error('Screen capture cancelled.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    // Electron cannot cancel source enumeration. Ignore a late result while
    // allowing cancellation/timeout to restore the window immediately.
    return await Promise.race([pending, interrupted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** Capture one explicitly chosen display, with the assistant out of the way. */
export async function captureDisplayScreenshot({
  display, window, getSources, signal,
}: {
  display: Pick<Display, 'id' | 'size' | 'scaleFactor'>;
  window?: CaptureWindow;
  getSources: CaptureSources;
  signal?: AbortSignal;
}): Promise<string> {
  signal?.throwIfAborted();
  return withCaptureWindowHidden(window, async () => {
    signal?.throwIfAborted();
    const sources = await waitForCapture(getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    }), signal);
    signal?.throwIfAborted();
    // Source count need not match display count (e.g. PipeWire). An unknown
    // display ID must not silently send a different screen to the model.
    const source = sources.find((s) => s.display_id === String(display.id));
    if (!source || source.thumbnail.isEmpty()) {
      throw new ScreenCaptureError('The selected display could not be captured.');
    }
    return source.thumbnail.toDataURL();
  });
}

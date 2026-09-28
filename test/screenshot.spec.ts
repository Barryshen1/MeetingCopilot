import { describe, expect, it, vi } from 'vitest';
import type { DesktopCapturerSource } from 'electron';
import { captureDisplayScreenshot, ScreenCaptureError, withCaptureWindowHidden } from '../electron/screenshot';

const display = { id: 2, size: { width: 1920, height: 1080 }, scaleFactor: 2 };
const source = (id: string, empty = false) => ({
  display_id: id,
  thumbnail: { isEmpty: () => empty, toDataURL: () => `data:image/png;screen=${id}` },
}) as unknown as DesktopCapturerSource;
const captureWindow = (visible = true) => ({
  isDestroyed: vi.fn(() => false), isVisible: () => visible,
  hide: vi.fn(), showInactive: vi.fn(),
});

describe('withCaptureWindowHidden', () => {
  it('waits for the compositor and keeps the window hidden until the async task finishes', async () => {
    vi.useFakeTimers();
    try {
      const window = captureWindow();
      let finish!: (value: string) => void;
      const task = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
      const pending = withCaptureWindowHidden(window, task);

      expect(window.hide).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(199);
      expect(task).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledOnce();
      expect(window.showInactive).not.toHaveBeenCalled();

      finish('selected region');
      await expect(pending).resolves.toBe('selected region');
      expect(window.showInactive).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the window when the async task fails', async () => {
    const window = captureWindow();
    await expect(withCaptureWindowHidden(window, async () => {
      expect(window.showInactive).not.toHaveBeenCalled();
      throw new Error('Selection failed');
    })).rejects.toThrow('Selection failed');
    expect(window.showInactive).toHaveBeenCalledOnce();
  });

  it('restores the window when the async task is cancelled', async () => {
    const window = captureWindow();
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const pending = withCaptureWindowHidden(window, () => {
      started();
      return new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
    });
    await ready;
    expect(window.showInactive).not.toHaveBeenCalled();
    controller.abort(new Error('Selection cancelled'));
    await expect(pending).rejects.toThrow('Selection cancelled');
    expect(window.showInactive).toHaveBeenCalledOnce();
  });

  it('leaves an already hidden window hidden', async () => {
    const window = captureWindow(false);
    await expect(withCaptureWindowHidden(window, async () => 'done')).resolves.toBe('done');
    expect(window.hide).not.toHaveBeenCalled();
    expect(window.showInactive).not.toHaveBeenCalled();
  });
});

describe('current-display screenshots', () => {
  it('captures the requested display at native resolution regardless of source order', async () => {
    const getSources = vi.fn(async () => [source('1'), source('2')]);
    expect(await captureDisplayScreenshot({ display, getSources })).toBe('data:image/png;screen=2');
    expect(getSources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 3840, height: 2160 } });
  });

  it.each([[], [source('1')], [source('')], [source(''), source('')], [source('2', true)]])(
    'refuses unavailable, ambiguous or empty screen captures (%#)', async (...sources) => {
      await expect(captureDisplayScreenshot({ display, getSources: async () => sources }))
        .rejects.toBeInstanceOf(ScreenCaptureError);
    },
  );

  it('hides the assistant before capture and restores it even when permission is denied', async () => {
    const window = captureWindow();
    const getSources = vi.fn(async () => {
      expect(window.hide).toHaveBeenCalledOnce();
      expect(window.showInactive).not.toHaveBeenCalled();
      throw new Error('Permission denied');
    });
    await expect(captureDisplayScreenshot({ display, window, getSources })).rejects.toThrow('Permission denied');
    expect(window.showInactive).toHaveBeenCalledOnce();
  });

  it('keeps an already hidden assistant hidden', async () => {
    const window = captureWindow(false);
    await captureDisplayScreenshot({ display, window, getSources: async () => [source('2')] });
    expect(window.hide).not.toHaveBeenCalled();
    expect(window.showInactive).not.toHaveBeenCalled();
  });

  it('restores the assistant when a pending capture is cancelled', async () => {
    const window = captureWindow();
    const controller = new AbortController();
    const getSources = vi.fn(async () => [source('2')]);
    const pending = captureDisplayScreenshot({ display, window, getSources, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(getSources).not.toHaveBeenCalled();
    expect(window.showInactive).toHaveBeenCalledOnce();
  });

  it('restores the assistant on cancellation even if source enumeration never finishes', async () => {
    const window = captureWindow();
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const pending = captureDisplayScreenshot({
      display, window, signal: controller.signal,
      getSources: () => { started(); return new Promise(() => {}); },
    });
    await ready;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(window.showInactive).toHaveBeenCalledOnce();
  });

  it('restores the assistant after a stalled capture times out', async () => {
    vi.useFakeTimers();
    try {
      const window = captureWindow();
      const pending = captureDisplayScreenshot({ display, window, getSources: () => new Promise(() => {}) });
      const rejected = expect(pending).rejects.toThrow('Screen capture timed out.');
      await vi.advanceTimersByTimeAsync(31_000);
      await rejected;
      expect(window.showInactive).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

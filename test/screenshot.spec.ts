import { describe, expect, it, vi } from 'vitest';
import type { DesktopCapturerSource } from 'electron';
import { captureDisplayScreenshot, ScreenCaptureError } from '../electron/screenshot';

const display = { id: 2, size: { width: 1920, height: 1080 }, scaleFactor: 2 };
const source = (id: string, empty = false) => ({
  display_id: id,
  thumbnail: { isEmpty: () => empty, toDataURL: () => `data:image/png;screen=${id}` },
}) as unknown as DesktopCapturerSource;
const captureWindow = (visible = true) => ({
  isDestroyed: vi.fn(() => false), isVisible: () => visible,
  hide: vi.fn(), showInactive: vi.fn(),
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

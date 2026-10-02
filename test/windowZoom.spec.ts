import { describe, expect, it, vi } from 'vitest';
import { FULL_SIZE_WIDTH, MIN_ZOOM, applyWindowZoom, zoomForWidth, type ZoomableWindow } from '../electron/windowZoom';

function fakeWindow(width: number, zoom = 1, destroyed = false) {
  let current = zoom;
  const setZoomFactor = vi.fn((z: number) => { current = z; });
  const win: ZoomableWindow = {
    isDestroyed: () => destroyed,
    getContentBounds: () => ({ x: 0, y: 0, width, height: 560 }),
    webContents: { getZoomFactor: () => current, setZoomFactor },
  };
  return { win, setZoomFactor };
}

describe('window zoom', () => {
  it('keeps full size at the default width or wider and scales in proportion below it', () => {
    expect(zoomForWidth(FULL_SIZE_WIDTH)).toBe(1);
    expect(zoomForWidth(1600)).toBe(1);
    expect(zoomForWidth(705)).toBeCloseTo(0.75, 5);
    expect(zoomForWidth(640)).toBeCloseTo(640 / 940, 5); // the window's minimum width
  });

  it('never goes below the floor and ignores nonsense widths', () => {
    expect(zoomForWidth(100)).toBe(MIN_ZOOM);
    expect(zoomForWidth(0)).toBe(1);
    expect(zoomForWidth(Number.NaN)).toBe(1);
  });

  it('applies the width-derived zoom, skips no-op updates and destroyed windows', () => {
    const narrow = fakeWindow(705);
    applyWindowZoom(narrow.win);
    expect(narrow.setZoomFactor).toHaveBeenCalledWith(expect.closeTo(0.75, 5));
    applyWindowZoom(narrow.win);
    expect(narrow.setZoomFactor).toHaveBeenCalledTimes(1);

    const forced = fakeWindow(705, 0.75);
    applyWindowZoom(forced.win, 1);
    expect(forced.setZoomFactor).toHaveBeenCalledWith(1);

    const gone = fakeWindow(705, 1, true);
    applyWindowZoom(gone.win);
    applyWindowZoom(null);
    expect(gone.setZoomFactor).not.toHaveBeenCalled();
  });
});

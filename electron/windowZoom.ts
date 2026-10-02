/**
 * The main overlay shrinks as a whole when its window gets narrower: title
 * bar, buttons and text keep their proportions instead of wrapping and
 * crowding. Full size (zoom 1) at the default width or wider; below that the
 * page zoom follows the window width. The window's own minimum width bounds
 * how small it gets.
 *
 * Kept out of main.ts so the arithmetic is unit-testable without Electron.
 */
import type { BrowserWindow } from 'electron';

/** Default overlay width in main.ts; the layout is designed at this size. */
export const FULL_SIZE_WIDTH = 940;
/** Never smaller than this, whatever the window reports. */
export const MIN_ZOOM = 0.6;

export function zoomForWidth(contentWidth: number): number {
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) return 1;
  return Math.min(1, Math.max(MIN_ZOOM, contentWidth / FULL_SIZE_WIDTH));
}

export type ZoomableWindow = Pick<BrowserWindow, 'isDestroyed' | 'getContentBounds'> & {
  webContents: Pick<BrowserWindow['webContents'], 'getZoomFactor' | 'setZoomFactor'>;
};

/** Apply the width-derived zoom; skips no-op updates during a drag-resize. */
export function applyWindowZoom(win: ZoomableWindow | null | undefined, zoom?: number): void {
  if (!win || win.isDestroyed()) return;
  const next = zoom ?? zoomForWidth(win.getContentBounds().width);
  if (Math.abs(win.webContents.getZoomFactor() - next) > 0.005) win.webContents.setZoomFactor(next);
}

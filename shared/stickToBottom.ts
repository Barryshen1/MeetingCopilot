/**
 * "Follow the newest line" for the transcript and answer panes.
 *
 * The old rule re-derived stickiness from the distance to the bottom on every
 * scroll event. A scroll event is dispatched a frame after the programmatic
 * jump to the bottom, so when more text arrived in between (live partials,
 * streamed answer deltas) the pane looked "scrolled up" and stopped following
 * for good. Content growth never moves scrollTop up; only the user does. So:
 * un-stick only when scrollTop moves UP, re-stick when the user reaches the
 * bottom again.
 */
export const STICK_THRESHOLD_PX = 48;

export interface ScrollSample {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function nextStick(stuck: boolean, prevScrollTop: number, now: ScrollSample): boolean {
  const distance = now.scrollHeight - now.scrollTop - now.clientHeight;
  if (distance < STICK_THRESHOLD_PX) return true;
  // a 1px tolerance absorbs fractional scrollTop under page zoom
  if (now.scrollTop < prevScrollTop - 1) return false;
  return stuck;
}

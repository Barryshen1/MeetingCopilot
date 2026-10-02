import { describe, expect, it } from 'vitest';
import { nextStick } from '../shared/stickToBottom';

describe('follow the newest line', () => {
  it('keeps following when text arrived before the scroll event fired', () => {
    // jumped to 400 (bottom); a 120px partial bubble grew before the event
    expect(nextStick(true, 400, { scrollTop: 400, scrollHeight: 1020, clientHeight: 500 })).toBe(true);
  });

  it('stops following only when the user scrolls up', () => {
    expect(nextStick(true, 400, { scrollTop: 250, scrollHeight: 900, clientHeight: 500 })).toBe(false);
  });

  it('resumes once the user is back at the bottom', () => {
    expect(nextStick(false, 250, { scrollTop: 380, scrollHeight: 900, clientHeight: 500 })).toBe(true);
    expect(nextStick(false, 250, { scrollTop: 300, scrollHeight: 900, clientHeight: 500 })).toBe(false);
  });

  it('ignores sub-pixel scrollTop jitter under page zoom', () => {
    expect(nextStick(true, 400.5, { scrollTop: 399.8, scrollHeight: 1100, clientHeight: 500 })).toBe(true);
  });
});

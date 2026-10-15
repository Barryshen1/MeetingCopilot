import { describe, expect, it } from 'vitest';
import {
  THEM_TALKING_STALE_MS,
  planContinuousAnswer,
  themStillTalking,
  type ContinuousTarget,
} from '../shared/continuousAnswer';
import { appendSegment, nextSegmentId, type TranscriptSegment } from '../shared/transcript';
import { isLikelyQuestion } from '../shared/textHeuristics';

const target = (over: Partial<ContinuousTarget> = {}): ContinuousTarget => ({
  sessionId: 's1',
  segmentId: 7,
  turnId: 'req-1',
  question: '这个是怎么决定的？',
  ...over,
});
const exists = () => true;

describe('planContinuousAnswer', () => {
  it('opens a card for a bubble that has none', () => {
    expect(planContinuousAnswer(null, { sessionId: 's1', segmentId: 7, question: '怎么做？' }, exists)).toEqual({
      action: 'new',
    });
  });

  it('re-asks in the same card when the bubble grew', () => {
    const plan = planContinuousAnswer(
      target(),
      { sessionId: 's1', segmentId: 7, question: '这个是怎么决定的？这块儿就是这个time啊。' },
      exists,
    );
    expect(plan).toEqual({ action: 'restart', turnId: 'req-1' });
  });

  it('skips when the same text was already asked', () => {
    expect(planContinuousAnswer(target(), { sessionId: 's1', segmentId: 7, question: ' 这个是怎么决定的？ ' }, exists)).toEqual({
      action: 'skip',
    });
  });

  it('opens a new card for a new bubble, another session, or a card that was cleared', () => {
    const q = { question: '这个是怎么决定的？再说一下。' };
    expect(planContinuousAnswer(target(), { sessionId: 's1', segmentId: 8, ...q }, exists).action).toBe('new');
    expect(planContinuousAnswer(target(), { sessionId: 's2', segmentId: 7, ...q }, exists).action).toBe('new');
    expect(planContinuousAnswer(target(), { sessionId: 's1', segmentId: 7, ...q }, () => false).action).toBe('new');
  });
});

describe('themStillTalking', () => {
  it('is true only while a 对方 partial is fresh', () => {
    expect(themStillTalking(0, 10_000)).toBe(false); // a final cleared it
    expect(themStillTalking(9_000, 10_000)).toBe(true);
    expect(themStillTalking(10_000 - THEM_TALKING_STALE_MS, 10_000)).toBe(false); // stale partial
  });
});

// The Oct 15 meeting: one 90-second 对方 remark arrived as many sentences that
// merged into ONE bubble, and every sentence opened another answer card (14
// cards for that bubble, several streaming at once). Replay that shape.
describe('one long 对方 remark → one card', () => {
  const sentences = [
    '那我们就再好一些，就是把它再、再完善一下。',
    '呃，我、我看起来应该可以，以前我们只有那个李牧阳他投过一次。',
    '最近这个score还可以了，我觉得差不多他那个能中了。',
    '然后science这块儿，我觉得AI for science agent这块儿应该现在还是比较hot的。',
    '你可以在slides里面整理一下，就是说这个paper，你想一想，就是大概有两部分吧，对吧？',
    '一个是benchmarking，还有一个是agentic这样一个evaluation这个framework。',
    '然后看看哪块要miss的，可以下一次把它加进来啊。',
    'uh.那有没有、没有、有没有什么其他的问题啊？好，那行，那我们就先这样。',
  ];

  function replay(gapMs: number) {
    let segs: TranscriptSegment[] = [];
    let prev: ContinuousTarget | null = null;
    const cards = new Map<string, number>(); // turnId -> times asked
    let t = 1_000_000;
    let req = 0;
    for (const text of sentences) {
      const startTs = t;
      t += 3000; // the sentence itself
      segs = appendSegment(segs, { id: nextSegmentId(segs), text, speaker: 'them', startTs, endTs: t });
      t += gapMs;
      const last = segs[segs.length - 1];
      if (!isLikelyQuestion(last.text)) continue;
      const plan = planContinuousAnswer(prev, { sessionId: 's1', segmentId: last.id, question: last.text }, (id) =>
        cards.has(id),
      );
      if (plan.action === 'skip') continue;
      const requestId = `req-${++req}`;
      if (plan.action === 'restart') {
        const asked = cards.get(plan.turnId)!;
        cards.delete(plan.turnId);
        cards.set(requestId, asked + 1);
      } else {
        cards.set(requestId, 1);
      }
      prev = { sessionId: 's1', segmentId: last.id, turnId: requestId, question: last.text };
    }
    return { bubbles: segs.length, cards: cards.size, asks: [...cards.values()].reduce((a, b) => a + b, 0) };
  }

  it('keeps one card for one bubble, re-asked as the remark grows', () => {
    const r = replay(1500); // pauses shorter than the 2.5 s merge window
    expect(r.bubbles).toBe(1);
    expect(r.cards).toBe(1);
    expect(r.asks).toBeGreaterThan(1);
  });

  it('gives separate remarks separate cards', () => {
    const r = replay(4000); // long pauses: each sentence is its own bubble
    expect(r.bubbles).toBe(sentences.length);
    expect(r.cards).toBe(r.asks);
  });
});

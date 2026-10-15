/**
 * 持续答 (continuous answering): ONE answer card per 对方 bubble.
 *
 * The ASR delivers a long 对方 turn sentence by sentence, and appendSegment
 * merges those sentences into one bubble (same segment id, growing text). The
 * trigger used to fire after every merged sentence and append a NEW card each
 * time — one bubble of a 90-second remark produced 14 cards, several of them
 * streaming at once.
 *
 * Now the card belongs to the bubble: when the bubble grows, the same card is
 * re-asked with the full text (the earlier request is cancelled), and nothing
 * is asked while 对方 is still mid-sentence. Pure logic, unit-tested.
 */

/** what the current continuous card answers */
export interface ContinuousTarget {
  sessionId: string;
  /** the 对方 bubble (TranscriptSegment.id) the card belongs to */
  segmentId: number;
  /** the card; equals the id of its latest request */
  turnId: string;
  /** the bubble text that request was asked with */
  question: string;
}

export type ContinuousPlan =
  /** this exact text was already asked: nothing to do */
  | { action: 'skip' }
  /** a bubble without a card yet: append one */
  | { action: 'new' }
  /** the bubble grew: re-ask in its existing card */
  | { action: 'restart'; turnId: string };

export function planContinuousAnswer(
  prev: ContinuousTarget | null,
  next: { sessionId: string; segmentId: number; question: string },
  turnExists: (turnId: string) => boolean,
): ContinuousPlan {
  const sameBubble =
    !!prev && prev.sessionId === next.sessionId && prev.segmentId === next.segmentId && turnExists(prev.turnId);
  if (!sameBubble) return { action: 'new' };
  if (prev.question.trim() === next.question.trim()) return { action: 'skip' };
  return { action: 'restart', turnId: prev.turnId };
}

/**
 * A live 对方 partial newer than this means the other party is still speaking.
 * Streaming partials refresh several times a second during speech; a partial
 * that stopped updating (a false start that never became a sentence) stops
 * holding the answer back after this long.
 */
export const THEM_TALKING_STALE_MS = 1500;

/** is 对方 mid-sentence? (lastPartialAt = 0 after a final) */
export function themStillTalking(lastPartialAt: number, now: number): boolean {
  return lastPartialAt > 0 && now - lastPartialAt < THEM_TALKING_STALE_MS;
}

/**
 * OEAI practice (UIUC Oral English Assessment Interview, the ITA certification
 * interview). A friend plays the examiner; after I have answered, the app rates
 * that answer the way OEAI raters would. It evaluates what I already said — it
 * never produces an answer for a question I have not answered yet.
 *
 * Test format and rating criteria: https://linguistics.illinois.edu/testing/oral-english-assessment-interview-oeai-ita-certification-test
 */
import type { Speaker } from './protocol';

/** one transcript line, as far as pairing questions and answers is concerned */
export interface OeaiLine {
  id: number;
  text: string;
  speaker?: Speaker;
}

export interface OeaiPair {
  /** the examiner's lines right before my answer ('' when none were transcribed) */
  question: string;
  /** my consecutive lines that contain the clicked one */
  answer: string;
}

/** keeps one evaluation request bounded, whatever the transcript holds */
export const OEAI_MAX_PART_CHARS = 3000;

const clip = (text: string) => (text.length > OEAI_MAX_PART_CHARS ? text.slice(-OEAI_MAX_PART_CHARS) : text);

/**
 * The question/answer pair a click on one of MY lines refers to: my run of
 * consecutive lines containing it, plus the examiner's run right before that.
 * Lines without a speaker count as the other party, like everywhere else.
 */
export function oeaiPairFor(lines: readonly OeaiLine[], lineId: number): OeaiPair | null {
  const i = lines.findIndex((l) => l.id === lineId);
  if (i < 0) return null;
  const who = (l: OeaiLine) => l.speaker ?? 'them';
  if (who(lines[i]) !== 'me') return null;
  let a0 = i;
  let a1 = i;
  while (a0 > 0 && who(lines[a0 - 1]) === 'me') a0--;
  while (a1 < lines.length - 1 && who(lines[a1 + 1]) === 'me') a1++;
  const q1 = a0 - 1;
  let q0 = q1;
  while (q0 > 0 && who(lines[q0 - 1]) === 'them') q0--;
  const join = (from: number, to: number) =>
    lines.slice(from, to + 1).map((l) => l.text.trim()).filter(Boolean).join(' ');
  return {
    question: q1 >= 0 ? clip(join(q0, q1)) : '',
    answer: clip(join(a0, a1)),
  };
}

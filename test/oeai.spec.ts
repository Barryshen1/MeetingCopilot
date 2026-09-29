import { describe, expect, it } from 'vitest';
import { OEAI_MAX_PART_CHARS, oeaiPairFor, type OeaiLine } from '../shared/oeai';
import { buildAnswerMessages } from '../electron/llm/prompts';

const lines: OeaiLine[] = [
  { id: 1, speaker: 'them', text: 'Hi, how is your semester going?' },
  { id: 2, speaker: 'me', text: 'It is going well.' },
  { id: 3, speaker: 'them', text: 'Can you define a hash table' },
  { id: 4, speaker: 'them', text: 'as you would explain it to undergraduates?' },
  { id: 5, speaker: 'me', text: 'Sure. A hash table stores key value pairs,' },
  { id: 6, speaker: 'me', text: 'and it uses a hash function to find the bucket.' },
  { id: 7, speaker: 'them', text: 'Thanks.' },
];

describe('oeaiPairFor', () => {
  it('pairs my whole answer run with the examiner run right before it', () => {
    const want = {
      question: 'Can you define a hash table as you would explain it to undergraduates?',
      answer: 'Sure. A hash table stores key value pairs, and it uses a hash function to find the bucket.',
    };
    expect(oeaiPairFor(lines, 5)).toEqual(want);
    expect(oeaiPairFor(lines, 6)).toEqual(want); // clicking any of my lines works
  });

  it('only rates MY lines, and unknown ids are ignored', () => {
    expect(oeaiPairFor(lines, 3)).toBeNull();
    expect(oeaiPairFor(lines, 99)).toBeNull();
  });

  it('has an empty question when nothing from the examiner was transcribed (shared mic)', () => {
    const shared: OeaiLine[] = [{ id: 1, speaker: 'me', text: 'Define recursion. Recursion is when a function calls itself.' }];
    expect(oeaiPairFor(shared, 1)).toEqual({ question: '', answer: shared[0].text });
  });

  it('treats lines without a speaker as the examiner and bounds each part', () => {
    const long = 'x'.repeat(OEAI_MAX_PART_CHARS + 500);
    const pair = oeaiPairFor([{ id: 1, text: 'What is Big-O?' }, { id: 2, speaker: 'me', text: long }], 2);
    expect(pair?.question).toBe('What is Big-O?');
    expect(pair?.answer.length).toBe(OEAI_MAX_PART_CHARS);
  });
});

describe('OEAI scenario prompt', () => {
  const pair = { question: 'Can you define a hash table?', answer: 'A hash table stores key value pairs.' };
  const msgs = buildAnswerMessages({
    mode: 'oeai',
    oeai: pair,
    recentTranscript: ['unrelated meeting line'],
    resume: 'SECRET RESUME',
    history: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }],
  });
  const system = String(msgs[0].content);
  const user = String(msgs[msgs.length - 1].content);

  it('uses the OEAI rater scenario, not the interview teleprompter', () => {
    expect(msgs[0].role).toBe('system');
    expect(system).toContain('OEAI');
    expect(system).toContain('Term Definitions');
    for (const c of ['Fluency', 'Pronunciation', 'Language Control', 'Coherence', 'Comprehension']) {
      expect(system).toContain(c);
    }
    expect(system).not.toContain('提词器');
  });

  it('rates the answer I gave and refuses to answer before I have', () => {
    expect(user).toContain(pair.question);
    expect(user).toContain(pair.answer);
    expect(system).toContain('如果【我的回答】为空');
    const empty = buildAnswerMessages({ mode: 'oeai', oeai: { question: pair.question, answer: '  ' }, recentTranscript: [] });
    expect(String(empty[1].content)).toContain('（空）');
  });

  it('keeps meeting material, transcript and history out of the evaluation', () => {
    expect(msgs).toHaveLength(2);
    const all = msgs.map((m) => String(m.content)).join('\n');
    expect(all).not.toContain('SECRET RESUME');
    expect(all).not.toContain('old answer');
    expect(all).not.toContain('unrelated meeting line');
  });
});

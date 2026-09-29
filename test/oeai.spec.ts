import { describe, expect, it } from 'vitest';
import { buildAnswerMessages, buildStablePrefix } from '../electron/llm/prompts';
import { isLikelyOeaiPrompt, isLikelyQuestion } from '../shared/textHeuristics';

describe('OEAI oral-answer mode', () => {
  it('auto-triggers on short examiner instructions without punctuation', () => {
    for (const prompt of ['Define recursion.', 'Compare SQL and NoSQL.', 'Give an example.', '请定义递归', '比较 SQL 和 NoSQL']) {
      expect(isLikelyOeaiPrompt(prompt)).toBe(true);
    }
    expect(isLikelyQuestion('Define recursion.')).toBe(false);
    for (const remark of ['Okay.', 'Thanks.', 'I will define recursion.']) {
      expect(isLikelyOeaiPrompt(remark)).toBe(false);
    }
  });

  it('answers an examiner question in the selected language without requesting a score', () => {
    const msgs = buildAnswerMessages({
      mode: 'segment',
      oeaiMode: true,
      question: 'Can you define a hash table for undergraduates?',
      recentTranscript: ['Can you define a hash table for undergraduates?'],
      answerLang: 'english',
      resume: 'I taught data structures.',
    });
    expect(msgs[0].content).toBe(buildStablePrefix('I taught data structures.', '', 'english', undefined, 'oeai'));
    expect(msgs[0].content).toContain('【英文】');
    expect(msgs[0].content).toContain('术语和一般知识可依据通用知识回答');
    expect(msgs[0].content).not.toContain('回答只能基于此');
    expect(msgs[1].role).toBe('system');
    expect(msgs[1].content).toContain('OEAI');
    expect(msgs[1].content).toContain('Term Definitions');
    expect(msgs[1].content).toContain('直接写出我接下来可以照着念的回答');
    expect(msgs[msgs.length - 1].content).toContain('Can you define a hash table for undergraduates?');
    const fullPrompt = JSON.stringify(msgs);
    expect(fullPrompt).not.toContain('X/5');
    expect(fullPrompt).not.toContain('Fluency');
    expect(fullPrompt).not.toContain('Pronunciation');
    expect(fullPrompt).not.toContain('【我的回答】');
  });

  it('keeps automatic language selection tied to the current question', () => {
    const msgs = buildAnswerMessages({
      mode: 'continuous',
      oeaiMode: true,
      question: 'Why are hash tables useful?',
      recentTranscript: ['这是早先的中文对话', 'Why are hash tables useful?'],
      answerLang: 'auto',
      resume: '中文简历',
    });
    expect(msgs[0].content).toContain('本轮明确提问');
    expect(msgs[1].content).toContain('自动时根据本轮提问');
    expect(msgs[msgs.length - 1].content).toContain('Why are hash tables useful?');
  });

  it('uses reference material for personal facts without turning OEAI into a job interview', () => {
    const msgs = buildAnswerMessages({
      mode: 'continuous',
      oeaiMode: true,
      question: 'Define a hash table.',
      recentTranscript: ['Define a hash table.'],
      answerLang: 'english',
      resume: 'I taught data structures.',
      jd: 'Software engineer job description',
    });
    expect(msgs[0].content).toContain('I taught data structures.');
    expect(msgs[0].content).toContain('Software engineer job description');
    expect(msgs[0].content).toContain('口试题未要求时无需贴合岗位');
    expect(msgs[0].content).not.toContain('回答向它贴合');
  });

  it('uses the Chinese setting for a continuous answer when chosen', () => {
    const msgs = buildAnswerMessages({
      mode: 'continuous',
      oeaiMode: true,
      recentTranscript: ['请解释一下你的研究'],
      answerLang: 'chinese',
    });
    expect(msgs[0].content).toContain('用【中文】输出');
    expect(msgs[1].content).toContain('OEAI');
    expect(msgs[msgs.length - 1].content).toContain('请解释一下你的研究');
  });

  it('treats a typed OEAI question as an answer request while ordinary free mode remains free', () => {
    const oeai = buildAnswerMessages({
      mode: 'free',
      oeaiMode: true,
      freeQuestion: 'What would you say if a student is confused about recursion?',
      recentTranscript: [],
      answerLang: 'auto',
    });
    expect(oeai[0].content).toContain('OEAI 模拟口试回答助手');
    expect(oeai[1].content).toContain('OEAI');
    expect(oeai[oeai.length - 1].content).toContain('What would you say');
    const ordinary = buildAnswerMessages({
      mode: 'free',
      freeQuestion: 'What model are you?',
      recentTranscript: [],
      answerLang: 'auto',
    });
    expect(ordinary).toEqual([{ role: 'user', content: 'What model are you?' }]);
  });

  it('keeps translation independent of the OEAI setting', () => {
    const msgs = buildAnswerMessages({
      mode: 'translate',
      oeaiMode: true,
      question: 'A hash table maps keys to values.',
      recentTranscript: [],
      answerLang: 'english',
    });
    expect(msgs[0].content).toContain('翻译成【简体中文】');
    expect(JSON.stringify(msgs)).not.toContain('OEAI');
  });
});

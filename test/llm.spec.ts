import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import {
  SseParser,
  extractDelta,
  extractMessageText,
  toProxyRules,
  chatOnce,
  chatStream,
  type ChatMessage,
} from '../electron/llm/adapter';
import {
  buildAnswerMessages,
  buildMemoUpdateMessages,
  buildPrewarmMessages,
  buildStablePrefix,
  buildTranslateMessages,
  buildVisionMessages,
  clampMemo,
  clampTranscript,
  classifyQuestion,
  formatReferenceFiles,
  isLikelyQuestion,
  langDirective,
  questionHint,
  smartClip,
  JD_PRIORITY,
  MAX_BACKGROUND_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_MEMO_CHARS,
  MAX_REFERENCE_CHARS,
  MAX_SCREENSHOT_CONTEXT_CHARS,
  RESUME_PRIORITY,
} from '../electron/llm/prompts';

describe('SseParser', () => {
  it('parses complete events', () => {
    const p = new SseParser();
    expect(p.push('data: {"a":1}\n\ndata: {"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles payloads split across chunks', () => {
    const p = new SseParser();
    expect(p.push('data: {"a"')).toEqual([]);
    expect(p.push(':1}\n')).toEqual(['{"a":1}']);
  });

  it('handles CRLF and ignores non-data lines', () => {
    const p = new SseParser();
    expect(p.push(': comment\r\nevent: x\r\ndata: {"a":1}\r\n\r\n')).toEqual(['{"a":1}']);
  });

  it('stops at [DONE]', () => {
    const p = new SseParser();
    expect(p.push('data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":2}\n\n')).toEqual(['{"a":1}']);
    expect(p.done).toBe(true);
    expect(p.push('data: {"c":3}\n\n')).toEqual([]);
  });
});

describe('extractDelta', () => {
  it('extracts streaming delta content', () => {
    expect(extractDelta('{"choices":[{"delta":{"content":"你好"}}]}')).toBe('你好');
  });
  it('tolerates role-only/empty deltas and bad json', () => {
    expect(extractDelta('{"choices":[{"delta":{"role":"assistant"}}]}')).toBe('');
    expect(extractDelta('not json')).toBe('');
  });
});

describe('buildAnswerMessages', () => {
  it('segment mode quotes the target sentence and includes context', () => {
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: '你们的核心优势是什么？',
      recentTranscript: ['我们先自我介绍', '你们的核心优势是什么？'],
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain('你们的核心优势是什么？');
    expect(msgs[1].content).toContain('我们先自我介绍');
  });

  it('continuous mode without a resolved question falls back to the latest speech', () => {
    const msgs = buildAnswerMessages({ mode: 'continuous', recentTranscript: ['刚才那句'] });
    expect(msgs[1].content).toContain('面试官最新的话');
  });

  it('continuous mode with the resolved question quotes it (v1 label bug fix)', () => {
    const msgs = buildAnswerMessages({
      mode: 'continuous',
      question: '你为什么从上一家公司离职？',
      recentTranscript: ['寒暄', '你为什么从上一家公司离职？'],
    });
    const user = msgs[msgs.length - 1].content as string;
    expect(user).toContain('你为什么从上一家公司离职？');
    expect(user).not.toContain('对方最新发言');
  });

  it('teleprompter persona: first-person, read-aloud output', () => {
    const msgs = buildAnswerMessages({ mode: 'segment', question: 'x', recentTranscript: [] });
    const sys = msgs[0].content as string;
    expect(sys).toContain('提词');
    expect(sys).toContain('第一人称');
    expect(sys).toContain('照着念');
    expect(sys).toContain('绝不编造');
  });

  it('free mode passes the user question through', () => {
    const msgs = buildAnswerMessages({
      mode: 'free',
      freeQuestion: '帮我总结一下刚才的对话',
      recentTranscript: [],
    });
    // no context/KB => no system prompt at all, just the raw question
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('帮我总结一下刚才的对话');
  });

  it('free mode does NOT inject the meeting-assistant persona (truthful model identity)', () => {
    const withCtx = buildAnswerMessages({
      mode: 'free',
      freeQuestion: '你是什么模型',
      recentTranscript: ['对方说了些话'],
      background: '我的简历',
    });
    const joined = JSON.stringify(withCtx);
    expect(joined).not.toContain('实时会议/面试助手');
    expect(joined).not.toContain('帮用户想好接下来怎么回答');
    // reference material is offered, not a persona
    expect(joined).toContain('供参考');
    expect(withCtx[withCtx.length - 1].content).toBe('你是什么模型');
  });

  it('answerLang hook steers the reply language (default chinese)', () => {
    const zh = buildAnswerMessages({ mode: 'segment', question: 'x', recentTranscript: [] });
    expect(zh[0].content).toContain('【中文】');
    expect(zh[0].content).not.toContain('【英文】');

    const en = buildAnswerMessages({
      mode: 'segment',
      question: 'x',
      recentTranscript: [],
      answerLang: 'english',
    });
    expect(en[0].content).toContain('【英文】');
    expect(en[0].content).not.toContain('- 用【中文】回答');

    const enCont = buildAnswerMessages({
      mode: 'continuous',
      recentTranscript: ['a'],
      answerLang: 'english',
    });
    expect(enCont[0].content).toContain('【英文】');
  });

  it('auto answer language follows the current question before older context or resume', () => {
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: 'What was the biggest challenge?',
      recentTranscript: ['你们的团队有多少人？', 'What was the biggest challenge?'],
      resume: '我的中文简历',
      history: [{ role: 'assistant', content: '上一轮的中文回答' }],
      answerLang: 'auto',
    });
    const sys = msgs[0].content as string;
    expect(sys).toContain('本轮明确提问');
    expect(sys).toContain('最近一条');
    expect(sys).toContain('不要根据本提示、简历');
    expect(sys).not.toContain('- 用【中文】输出');
    expect(msgs[msgs.length - 1].content).toContain('What was the biggest challenge?');
  });

  it('auto continuous mode without a question uses recent transcript language', () => {
    const msgs = buildAnswerMessages({
      mode: 'continuous',
      recentTranscript: ['你们好。', 'Could you explain the architecture?'],
      answerLang: 'auto',
    });
    expect(msgs[0].content).toContain('最近一条有实际内容的对话转录');
    expect(msgs[msgs.length - 1].content).toContain('Could you explain the architecture?');
  });

  it('free mode uses the current question language despite Chinese reference material', () => {
    const msgs = buildAnswerMessages({
      mode: 'free',
      freeQuestion: 'Summarize the discussion.',
      recentTranscript: ['这是中文会议转录'],
      background: '中文资料',
      answerLang: 'auto',
    });
    expect(msgs[0].content).toContain('current user question');
    expect(msgs[msgs.length - 1].content).toBe('Summarize the discussion.');
    expect(JSON.stringify(msgs)).not.toContain('实时面试提词器');
  });
});

describe('isLikelyQuestion (continuous-mode gate)', () => {
  it('accepts real questions (zh + en)', () => {
    expect(isLikelyQuestion('你们的核心优势是什么？')).toBe(true);
    expect(isLikelyQuestion('能不能介绍一下你的项目')).toBe(true);
    expect(isLikelyQuestion('请问你怎么看这个方向')).toBe(true);
    expect(isLikelyQuestion('Could you tell me about your experience?')).toBe(true);
    expect(isLikelyQuestion('How do you handle conflict')).toBe(true);
  });
  it('rejects short/statement fragments', () => {
    expect(isLikelyQuestion('嗯')).toBe(false);
    expect(isLikelyQuestion('好的')).toBe(false);
    expect(isLikelyQuestion('我明白了')).toBe(false);
  });
  it('treats long utterances (>=40 chars) as likely-answerable', () => {
    const long = '我们这边其实一直在做这个方向的落地大概有三年了积累了不少经验和数据也踩过很多坑希望多交流一下';
    expect(long.length).toBeGreaterThanOrEqual(40);
    expect(isLikelyQuestion(long)).toBe(true);
  });
});

describe('buildAnswerMessages history (session coherence)', () => {
  it('injects prior Q&A between system and the new user turn', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '上一个问题' },
      { role: 'assistant', content: '上一个回答' },
    ];
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: '新问题',
      recentTranscript: [],
      history,
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[1]).toEqual(history[0]);
    expect(msgs[2]).toEqual(history[1]);
    expect(msgs[msgs.length - 1].content).toContain('新问题');
  });
  it('translate mode ignores history entirely', () => {
    const msgs = buildAnswerMessages({
      mode: 'translate',
      question: 'Hello',
      recentTranscript: [],
      history: [{ role: 'user', content: 'leak?' }],
    });
    expect(JSON.stringify(msgs)).not.toContain('leak?');
  });
});

describe('dual-slot material injection (resume / JD)', () => {
  it('injects resume + JD as delimited sections of the system prompt', () => {
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: 'x',
      recentTranscript: [],
      resume: '我做过一个实时音频转录项目，用 whisper + DirectML。',
      jd: '岗位职责：负责语音产品研发。',
    });
    const sys = msgs[0].content as string;
    expect(sys).toContain('【简历】');
    expect(sys).toContain('DirectML');
    expect(sys).toContain('【岗位JD】');
    expect(sys).toContain('语音产品研发');
  });
  it('legacy background is treated as resume material (compat)', () => {
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: 'x',
      recentTranscript: [],
      background: '我的全局知识库内容',
    });
    const sys = msgs[0].content as string;
    expect(sys).toContain('【简历】');
    expect(sys).toContain('我的全局知识库内容');
  });
  it('omits sections when empty', () => {
    const msgs = buildAnswerMessages({ mode: 'segment', question: 'x', recentTranscript: [], background: '  ' });
    const sys = msgs[0].content as string;
    // the persona text may mention 【简历】 in its rules — check section headers
    expect(sys).not.toContain('【简历】（');
    expect(sys).not.toContain('【岗位JD】（');
    expect(sys).not.toContain('【简历结束】');
  });
  it('caps oversized material to the char budget', () => {
    const huge = 'A'.repeat(20000);
    const msgs = buildAnswerMessages({ mode: 'segment', question: 'x', recentTranscript: [], resume: huge });
    const sys = msgs[0].content as string;
    // system prompt = persona + <=8000 material chars + delimiters
    expect(sys.length).toBeLessThan(9000);
  });
  it('translate mode never carries material', () => {
    const msgs = buildAnswerMessages({
      mode: 'translate',
      question: 'Hello',
      recentTranscript: [],
      resume: '机密简历内容',
      jd: '机密JD内容',
    });
    const joined = JSON.stringify(msgs);
    expect(joined).not.toContain('机密简历内容');
    expect(joined).not.toContain('机密JD内容');
  });
});

describe('additional session reference files', () => {
  const attachments = [
    { id: 'a', name: 'project-notes.md', text: '项目结论：延迟下降 30%。' },
    { id: 'b', name: 'design.py', text: 'def solve(items): return len(items)' },
  ];

  it('includes each named file in ordinary answers and keeps prewarm byte-identical', () => {
    const prefix = buildStablePrefix('简历', 'JD', 'auto', attachments);
    const real = buildAnswerMessages({
      mode: 'segment', question: 'How did you improve latency?', recentTranscript: [],
      resume: '简历', jd: 'JD', attachments, answerLang: 'auto',
    });
    expect(real[0].content).toBe(prefix);
    expect(buildPrewarmMessages(prefix)[0].content).toBe(prefix);
    expect(prefix).toContain('project-notes.md');
    expect(prefix).toContain('延迟下降 30%');
    expect(prefix).toContain('design.py');
    expect(prefix).toContain('def solve');
    expect(prefix).toContain('不要根据本提示、简历、岗位JD、参考文件');
  });

  it('bounds all extra files together and gives short files unused budget to long files', () => {
    const short = { id: 'short', name: 'short.txt', text: 'brief' };
    const long = { id: 'long', name: 'long.txt', text: 'X'.repeat(30_000) };
    const formatted = formatReferenceFiles([short, long]);
    expect(formatted.length).toBeLessThanOrEqual(MAX_REFERENCE_CHARS);
    expect(formatted).toContain('short.txt');
    expect(formatted).toContain('brief');
    expect(formatted).toContain('long.txt');
    expect((formatted.match(/X/g) ?? []).length).toBeGreaterThan(10_000);
    expect(formatReferenceFiles([short, long])).toBe(formatted);
  });

  it('uses the remaining budget when a reference has one oversized paragraph', () => {
    const formatted = formatReferenceFiles([
      { id: 'long', name: 'long.py', text: `Intro\n\n${'X'.repeat(30_000)}` },
    ]);
    expect(formatted.length).toBeLessThanOrEqual(MAX_REFERENCE_CHARS);
    expect(formatted).toContain('Intro');
    expect((formatted.match(/X/g) ?? []).length).toBeGreaterThan(10_000);
  });

  it('treats filenames as labels and does not let them forge prompt sections', () => {
    const formatted = formatReferenceFiles([
      { id: 'a', name: 'notes\n【岗位JD】.txt', text: 'A fact' },
    ]);
    expect(formatted).toContain('notes  岗位JD .txt');
    expect(formatted).not.toContain('\n【岗位JD】');
  });

  it('offers files to free questions without adopting meeting persona, and excludes them from translation', () => {
    const free = buildAnswerMessages({
      mode: 'free', freeQuestion: 'Summarize the design.', recentTranscript: [],
      attachments, answerLang: 'auto',
    });
    expect(JSON.stringify(free)).toContain('project-notes.md');
    expect(JSON.stringify(free)).not.toContain('实时面试提词器');
    expect(free[0].content).toContain('current user question');
    const translated = buildAnswerMessages({
      mode: 'translate', question: 'Hello', recentTranscript: [], attachments,
    });
    expect(JSON.stringify(translated)).not.toContain('project-notes.md');
  });

  it('uses the session material for both screenshot modes', () => {
    const general = buildVisionMessages(
      '', 'data:image/png;base64,AAA', 'Legacy notes', 'general', 'auto', attachments,
    );
    expect(JSON.stringify(general)).toContain('project-notes.md');
    expect(JSON.stringify(general)).toContain('Legacy notes');
    expect((general[0].content as string).length).toBeLessThan(MAX_SCREENSHOT_CONTEXT_CHARS + 1000);
    for (const lang of ['auto', 'chinese'] as const) {
      const coding = buildVisionMessages(
        '', 'data:image/png;base64,AAA', 'Legacy notes', 'coding-test', lang, attachments,
      );
      expect(JSON.stringify(coding)).toContain('project-notes.md');
      expect(JSON.stringify(coding)).toContain('Legacy notes');
    }
  });
});

describe('buildStablePrefix (prefix-cache friendliness)', () => {
  it('is byte-stable: identical inputs yield the identical string', () => {
    const a = buildStablePrefix('简历内容', 'JD内容', 'chinese');
    const b = buildStablePrefix('简历内容', 'JD内容', 'chinese');
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{13}/); // no dates / timestamps
  });
  it('is the entire system message of segment/continuous requests', () => {
    const prefix = buildStablePrefix('R', 'J', 'english');
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: 'q',
      recentTranscript: ['a'],
      resume: 'R',
      jd: 'J',
      answerLang: 'english',
    });
    expect(msgs[0].content).toBe(prefix);
  });
  it('keeps the auto-language prefix identical for prewarm and real answers', () => {
    const prefix = buildStablePrefix('简历', 'JD', 'auto');
    const warm = buildPrewarmMessages(prefix);
    const real = buildAnswerMessages({
      mode: 'segment', question: 'Explain your design.', recentTranscript: [],
      resume: '简历', jd: 'JD', answerLang: 'auto',
    });
    expect(warm[0].content).toBe(real[0].content);
    expect(prefix).toContain('自动匹配回答语言');
  });
  it('gives the full budget to a lone slot', () => {
    const huge = 'B'.repeat(20000);
    const p = buildStablePrefix('', huge, 'chinese');
    expect(p).toContain('B'.repeat(MAX_BACKGROUND_CHARS));
  });
});

describe('smartClip (priority-aware budget truncation)', () => {
  it('returns text unchanged when under budget', () => {
    expect(smartClip('短文本', 100, RESUME_PRIORITY)).toBe('短文本');
  });
  it('keeps priority paragraphs (project experience / JD requirements) over filler', () => {
    const filler = '自我评价：热爱学习。'.repeat(30); // ~300 chars, no keyword
    const proj = '项目经历：做了实时转录系统，负责 ASR 链路。';
    const text = `${filler}\n\n${proj}\n\n${filler}`;
    const out = smartClip(text, proj.length + 10, JD_PRIORITY.test(proj) ? JD_PRIORITY : RESUME_PRIORITY);
    expect(out).toContain('项目经历');
    expect(out.length).toBeLessThanOrEqual(proj.length + 10);
  });
  it('hard-slices a single oversized paragraph', () => {
    expect(smartClip('A'.repeat(500), 100, RESUME_PRIORITY)).toHaveLength(100);
  });
});

describe('classifyQuestion + questionHint', () => {
  it('classifies behavioral questions', () => {
    expect(classifyQuestion('先做个自我介绍吧')).toBe('behavioral');
    expect(classifyQuestion('你为什么从上一家公司离职？')).toBe('behavioral');
    expect(classifyQuestion('说说你印象最深的一个项目挑战')).toBe('behavioral');
    expect(classifyQuestion('Tell me about yourself')).toBe('behavioral');
  });
  it('classifies technical questions', () => {
    expect(classifyQuestion('讲讲 Redis 的持久化原理')).toBe('technical');
    expect(classifyQuestion('这个查询怎么优化性能？')).toBe('technical');
    expect(classifyQuestion('手写一个二叉树的层序遍历')).toBe('technical');
    expect(classifyQuestion('What is the difference between TCP and UDP?')).toBe('technical');
  });
  it('classifies smalltalk', () => {
    expect(classifyQuestion('你好，能听到我说话吗？')).toBe('smalltalk');
    expect(classifyQuestion('Hi, can you hear me?')).toBe('smalltalk');
  });
  it('falls back to other (no hint) when unsure', () => {
    expect(classifyQuestion('今天我们随便聊聊')).toBe('other');
    expect(questionHint('other')).toBe('');
  });
  it('appends the hint line to the user message', () => {
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: '讲讲 Redis 的持久化原理',
      recentTranscript: [],
    });
    expect(msgs[msgs.length - 1].content).toContain('题型：技术题');
  });
});

describe('buildMemoUpdateMessages / clampMemo (P1-5 pure logic)', () => {
  it('folds the old memo and the new Q&A into a bounded structured prompt', () => {
    const msgs = buildMemoUpdateMessages('【已问问题】自我介绍', '你的优势是什么？', '我的优势是后端高并发。');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toContain('800 字');
    expect(msgs[0].content).toContain('我已声称的事实');
    expect(msgs[1].content).toContain('【已问问题】自我介绍');
    expect(msgs[1].content).toContain('问：你的优势是什么？');
    expect(msgs[1].content).toContain('答：我的优势是后端高并发。');
  });
  it('shows （空） for a first-time memo', () => {
    const msgs = buildMemoUpdateMessages('', 'q', 'a');
    expect(msgs[1].content).toContain('（空）');
  });
  it('clampMemo hard-caps the stored memo', () => {
    expect(clampMemo('x'.repeat(5000))).toHaveLength(MAX_MEMO_CHARS);
    expect(clampMemo('  ok  ')).toBe('ok');
  });
});

describe('buildPrewarmMessages (P1-6 prefix-cache warm)', () => {
  it('system message is byte-identical to real answer requests', () => {
    const prefix = buildStablePrefix('简历', 'JD', 'chinese');
    const warm = buildPrewarmMessages(prefix);
    const real = buildAnswerMessages({
      mode: 'segment',
      question: 'q',
      recentTranscript: [],
      resume: '简历',
      jd: 'JD',
    });
    expect(warm[0].role).toBe('system');
    expect(warm[0].content).toBe(real[0].content);
    // the user turn is tiny and CONSTANT (no timestamps → deterministic)
    expect(warm[1]).toEqual({ role: 'user', content: 'ok' });
  });
});

describe('memo block (rolling interview memo, P1)', () => {
  it('sits between the stable prefix and the history', () => {
    const history: ChatMessage[] = [{ role: 'user', content: '旧问题' }];
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: '新问题',
      recentTranscript: [],
      memo: '已问：自我介绍。我已声称：三年经验。',
      history,
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain('【面试进行备忘】');
    expect(msgs[1].content).toContain('三年经验');
    expect(msgs[3]).toEqual(history[0]);
  });
  it('is omitted entirely when empty', () => {
    const msgs = buildAnswerMessages({ mode: 'segment', question: 'q', recentTranscript: [], memo: ' ' });
    expect(JSON.stringify(msgs)).not.toContain('面试进行备忘');
  });
});

describe('extractMessageText (non-stream reply)', () => {
  it('pulls choices[0].message.content', () => {
    expect(extractMessageText('{"choices":[{"message":{"content":"你好"}}]}')).toBe('你好');
    expect(extractMessageText('bad json')).toBe('');
    expect(extractMessageText('{"choices":[]}')).toBe('');
  });
});

describe('toProxyRules', () => {
  it('formats bare host:port for both schemes', () => {
    expect(toProxyRules('127.0.0.1:7897')).toBe('http=127.0.0.1:7897;https=127.0.0.1:7897');
    expect(toProxyRules('http://127.0.0.1:7897')).toBe('http=127.0.0.1:7897;https=127.0.0.1:7897');
    expect(toProxyRules('')).toBe('');
    expect(toProxyRules(undefined)).toBe('');
  });
});

describe('langDirective', () => {
  it('produces a distinct hook per language', () => {
    expect(langDirective('auto')).toContain('自动匹配回答语言');
    expect(langDirective('chinese')).toContain('中文');
    expect(langDirective('english')).toContain('英文');
    expect(langDirective('chinese')).not.toBe(langDirective('english'));
    expect(langDirective('auto')).not.toBe(langDirective('chinese'));
  });
});

describe('buildTranslateMessages / translate mode', () => {
  it('targets Chinese, output-only, no context', () => {
    const msgs = buildTranslateMessages('Could you introduce your company?');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toContain('简体中文');
    expect(msgs[0].content).toContain('只输出译文');
    expect(msgs[1].content).toBe('Could you introduce your company?');
  });

  it('translate mode routes through buildAnswerMessages ignoring answerLang', () => {
    const msgs = buildAnswerMessages({
      mode: 'translate',
      question: 'Hello world',
      recentTranscript: ['irrelevant context'],
      answerLang: 'english',
    });
    // no transcript context leaks into a translation request
    expect(JSON.stringify(msgs)).not.toContain('irrelevant context');
    expect(msgs[1].content).toBe('Hello world');
    expect(msgs[0].content).toContain('简体中文');
  });

  it('translate remains Chinese in auto answer-language mode', () => {
    const msgs = buildAnswerMessages({ mode: 'translate', question: 'Hello', recentTranscript: [], answerLang: 'auto' });
    expect(msgs[0].content).toContain('简体中文');
  });
});

describe('buildVisionMessages', () => {
  it('builds one multimodal user message: image first, question second', () => {
    const msgs = buildVisionMessages('这页 PPT 讲什么？', 'data:image/png;base64,AAA');
    expect(msgs).toHaveLength(2);
    const content = msgs[1].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
    expect(content[1]).toEqual({ type: 'text', text: '这页 PPT 讲什么？' });
  });

  it('falls back to a default question when empty', () => {
    const msgs = buildVisionMessages('  ', 'data:image/png;base64,AAA');
    const content = msgs[1].content as Array<{ type: string; text?: string }>;
    expect(content[1].text).toContain('要点');
  });

  it('keeps the existing screenshot prompt when the mode is general', () => {
    const image = 'data:image/png;base64,AAA';
    const background = 'My meeting notes';
    const implicit = buildVisionMessages('', image, background);
    const explicit = buildVisionMessages('', image, background, 'general');
    expect(explicit).toEqual(implicit);
    expect(JSON.stringify(explicit)).toContain(background);
    const content = explicit[1].content as Array<{ type: string; text?: string }>;
    expect(content[1].text).toBe('解读这页内容的要点，并给出我应该怎么回应的建议。');
  });

  it('asks for fully commented Python 3 code with a walkthrough for a coding-test screenshot', () => {
    const image = 'data:image/png;base64,AAA';
    const background = 'RESUME_MARKER';
    const msgs = buildVisionMessages('  ', image, background, 'coding-test');
    expect(msgs).toHaveLength(2);
    const system = msgs[0].content as string;
    const content = msgs[1].content as Array<{ type: string; image_url?: { url: string }; text?: string }>;
    expect(system).toMatch(/Python\s*3/i);
    expect(system).toMatch(/时间复杂度/);
    expect(system).toMatch(/空间复杂度/);
    expect(system).toContain('每一行都要有注释');
    expect(system).toContain('```python');
    expect(system).toContain('逐步讲解');
    expect(system).toContain('dry run');
    expect(system).not.toMatch(/会议助手|PPT/i);
    expect(system).toContain(background); // the session material rides along as data
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: image } });
    expect(content[1].type).toBe('text');
    expect(content[1].text).toMatch(/编程|算法|coding|problem/i);
    expect(content[1].text).not.toContain('这页内容');
  });

  it('retains an explicit screenshot question in coding-test mode', () => {
    const question = '  请用双指针解这道题，并解释边界条件。  ';
    const msgs = buildVisionMessages(question, 'data:image/png;base64,AAA', undefined, 'coding-test');
    const content = msgs[1].content as Array<{ type: string; text?: string }>;
    expect(content[1]).toEqual({ type: 'text', text: question.trim() });
  });

  it('auto screenshot language follows visible task text when the question is blank', () => {
    for (const mode of ['general', 'coding-test'] as const) {
      const msgs = buildVisionMessages('', 'data:image/png;base64,AAA', undefined, mode, 'auto');
      const system = msgs[0].content as string;
      expect(system).toContain('use the main natural language of the problem statement or body text visible in the image');
      expect(system).toContain('Ignore UI text, reference material, and the language of these instructions');
      const content = msgs[1].content as Array<{ type: string; text?: string }>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('image_url');
    }
  });

  it('auto screenshot language prioritizes the typed question over screenshot language', () => {
    const msgs = buildVisionMessages('Explain this in English.', 'data:image/png;base64,AAA', undefined, 'coding-test', 'auto');
    expect(msgs[0].content).toContain('Use the main natural language of the user\'s typed question');
    expect((msgs[1].content as Array<{ text?: string }>)[1].text).toBe('Explain this in English.');
  });

  it('auto screenshot language ignores a typed programming-language name as a language cue', () => {
    const msgs = buildVisionMessages('Python', 'data:image/png;base64,AAA', undefined, 'coding-test', 'auto');
    expect(msgs[0].content).toContain('A programming language name alone (such as Python or C++)');
    expect(msgs[0].content).toContain('use the main natural language of the problem statement or body text visible in the image');
  });

  it('explicit English still steers both screenshot modes', () => {
    for (const mode of ['general', 'coding-test'] as const) {
      const msgs = buildVisionMessages('', 'data:image/png;base64,AAA', undefined, mode, 'english');
      expect(msgs[0].content).toContain('Answer in English.');
    }
  });
});

describe('clampTranscript', () => {
  it('keeps the newest lines within budget', () => {
    const lines = ['老'.repeat(2000), '中'.repeat(1000), '新'.repeat(1000)];
    const out = clampTranscript(lines, MAX_CONTEXT_CHARS);
    expect(out).toHaveLength(2);
    expect(out[out.length - 1][0]).toBe('新');
  });
  it('returns all lines when under budget', () => {
    expect(clampTranscript(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('chatStream (mock OpenAI-compatible server)', () => {
  let server: Server;
  let baseUrl: string;
  let lastReq: { url?: string; auth?: string; body?: any } = {};
  let behavior: 'stream' | 'error401' | 'slow' | 'json' = 'stream';

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        lastReq = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || '{}') };
        if (behavior === 'error401') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end('{"error":{"message":"bad key"}}');
          return;
        }
        if (behavior === 'json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: '好' } }],
              usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 },
            }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunks = [
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"建议"}}]}\n\ndata: {"choices":[{"delta":{"content":"这样"}}]}\n\n',
          // split one event across two TCP writes
          'data: {"choices":[{"delta":{"content":"回',
          '答"}}]}\n\n',
          'data: [DONE]\n\n',
        ];
        if (behavior === 'slow') {
          let i = 0;
          const timer = setInterval(() => {
            if (i < chunks.length) res.write(chunks[i++]);
            else {
              clearInterval(timer);
              res.end();
            }
          }, 40);
          req.on('close', () => clearInterval(timer));
        } else {
          for (const c of chunks) res.write(c);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}/v1`;
  });

  afterAll(() => {
    server.close();
  });

  const cfg = () => ({ baseUrl, model: 'deepseek-v4-flash', apiKey: 'sk-test' });
  const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];

  it('sends the right request shape and assembles streamed deltas', async () => {
    behavior = 'stream';
    const deltas: string[] = [];
    const r = await chatStream(cfg(), msgs, { onDelta: (d) => deltas.push(d) });
    expect(r.text).toBe('建议这样回答');
    expect(deltas.join('')).toBe('建议这样回答');
    expect(lastReq.url).toBe('/v1/chat/completions');
    expect(lastReq.auth).toBe('Bearer sk-test');
    expect(lastReq.body.model).toBe('deepseek-v4-flash');
    expect(lastReq.body.stream).toBe(true);
    expect(lastReq.body.messages).toEqual(msgs);
  });

  it('passes multimodal content through unchanged (vision payloads)', async () => {
    behavior = 'stream';
    const vmsgs = buildVisionMessages('看图', 'data:image/png;base64,BBB');
    await chatStream(cfg(), vmsgs, { onDelta: () => {} });
    expect(lastReq.body.messages).toEqual(JSON.parse(JSON.stringify(vmsgs)));
  });

  it('throws a useful error on HTTP failure', async () => {
    behavior = 'error401';
    await expect(chatStream(cfg(), msgs, { onDelta: () => {} })).rejects.toThrow(/401/);
  });

  it('chatOnce: non-streaming, max_tokens for prewarm, returns cache usage', async () => {
    behavior = 'json';
    const r = await chatOnce(cfg(), buildPrewarmMessages('前缀'), { maxTokens: 1 });
    expect(r.text).toBe('好');
    expect(r.usage?.prompt_cache_hit_tokens).toBe(64);
    expect(r.usage?.prompt_cache_miss_tokens).toBe(36);
    expect(lastReq.body.stream).toBe(false);
    expect(lastReq.body.max_tokens).toBe(1);
    expect(lastReq.body.messages[0].content).toBe('前缀');
  });

  it('chatOnce: omits max_tokens by default and honors temperature (memo path)', async () => {
    behavior = 'json';
    await chatOnce(cfg(), [{ role: 'user', content: 'x' }], { temperature: 0.2 });
    expect(lastReq.body.max_tokens).toBeUndefined();
    expect(lastReq.body.temperature).toBe(0.2);
  });

  it('supports aborting mid-stream', async () => {
    behavior = 'slow';
    const ac = new AbortController();
    const deltas: string[] = [];
    const p = chatStream(cfg(), msgs, { onDelta: (d) => deltas.push(d) }, ac.signal);
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toThrow();
    expect(deltas.join('').length).toBeLessThan('建议这样回答'.length);
  });
});

describe('回答模式 = Coding Test (every answer, not only screenshots)', () => {
  const material = {
    resume: 'RESUME_MARKER',
    jd: 'JD_MARKER',
    attachments: [{ id: 'a1', name: 'problem.md', text: 'PROBLEM_FILE_MARKER', chars: 19 }],
  };

  it('answers a spoken interviewer problem with commented code instead of a teleprompter answer', () => {
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: 'Given an array of integers, return indices of the two numbers that add up to a target.',
      recentTranscript: ['Let us start with a coding question.'],
      answerLang: 'chinese',
      codingTest: true,
      ...material,
    });
    const system = msgs[0].content as string;
    expect(system).toContain('Coding Test 模式');
    expect(system).toContain('每一行都要有注释');
    expect(system).toContain('```python');
    expect(system).not.toContain('实时面试提词器');
    expect(system).not.toContain('150-350');
    for (const marker of ['RESUME_MARKER', 'JD_MARKER', 'PROBLEM_FILE_MARKER']) expect(system).toContain(marker);
    const last = msgs[msgs.length - 1].content as string;
    expect(last).toContain('two numbers that add up');
    expect(last).toContain('逐行注释');
  });

  it('treats a typed question as a coding question too, with the same cacheable prefix', () => {
    const free = buildAnswerMessages({
      mode: 'free',
      freeQuestion: '写一个 LRU cache',
      recentTranscript: ['interviewer: any questions?'],
      answerLang: 'auto',
      codingTest: true,
      ...material,
    });
    expect(free[0].content).toBe(buildStablePrefix('RESUME_MARKER', 'JD_MARKER', 'auto', material.attachments, 'coding'));
    const last = free[free.length - 1].content as string;
    expect(last).toContain('写一个 LRU cache');
    expect(last).toContain('interviewer: any questions?');
  });

  it('covers 持续答 and wins over OEAI; translation is untouched', () => {
    const continuous = buildAnswerMessages({
      mode: 'continuous', recentTranscript: ['Now implement binary search.'], codingTest: true, oeaiMode: true,
    });
    expect(continuous[0].content as string).toContain('Coding Test 模式');
    expect(JSON.stringify(continuous)).not.toContain('OEAI');
    const translated = buildAnswerMessages({ mode: 'translate', question: 'Hello', recentTranscript: [], codingTest: true });
    expect(JSON.stringify(translated)).not.toContain('Coding Test');
  });

  it('says to answer briefly, without code, when the line is not a programming problem', () => {
    const prefix = buildStablePrefix('', '', 'chinese', undefined, 'coding');
    expect(prefix).toContain('不是编程问题');
    expect(prefix).toContain('不要硬写代码');
    expect(prefix).toBe(buildStablePrefix('', '', 'chinese', undefined, 'coding')); // byte-stable
  });

  it('keeps the ordinary teleprompter when Coding Test is off', () => {
    const msgs = buildAnswerMessages({ mode: 'segment', question: 'Tell me about yourself', recentTranscript: [] });
    expect(msgs[0].content as string).toContain('实时面试提词器');
    expect(msgs[0].content as string).not.toContain('Coding Test');
  });
});

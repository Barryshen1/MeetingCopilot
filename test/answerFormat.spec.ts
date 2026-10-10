import { describe, expect, it } from 'vitest';
import { codeIndent, splitAnswer, splitInlineCode } from '../shared/answerFormat';

describe('splitAnswer', () => {
  it('returns plain prose as one text part', () => {
    expect(splitAnswer('我会先确认需求。\n再给方案。')).toEqual([{ kind: 'text', text: '我会先确认需求。\n再给方案。' }]);
  });

  it('separates labelled prose from a fenced, commented code block', () => {
    const answer = [
      '思路：用哈希表记录见过的数。',
      '',
      '代码：',
      '```python',
      'def two_sum(nums, target):  # 定义函数',
      '    seen = {}  # 值 -> 下标',
      '```',
      '',
      '复杂度：O(n) 时间，O(n) 空间。',
    ].join('\n');
    expect(splitAnswer(answer)).toEqual([
      { kind: 'text', text: '思路：用哈希表记录见过的数。\n\n代码：' },
      { kind: 'code', lang: 'python', code: 'def two_sum(nums, target):  # 定义函数\n    seen = {}  # 值 -> 下标', open: false },
      { kind: 'text', text: '复杂度：O(n) 时间，O(n) 空间。' },
    ]);
  });

  it('formats code that is still streaming (no closing fence yet)', () => {
    expect(splitAnswer('Code:\n```Python\nfor i in range(3):  # loop')).toEqual([
      { kind: 'text', text: 'Code:' },
      { kind: 'code', lang: 'python', code: 'for i in range(3):  # loop', open: true },
    ]);
    expect(splitAnswer('Code:\n```')).toEqual([
      { kind: 'text', text: 'Code:' },
      { kind: 'code', lang: '', code: '', open: true },
    ]);
  });

  it('keeps indentation and blank lines inside code, and handles several blocks and languages', () => {
    const parts = splitAnswer('```cpp\nint main() {\n\n    return 0;  // done\n}\n```\nthen\n```c++\nx++;\n```');
    expect(parts).toEqual([
      { kind: 'code', lang: 'cpp', code: 'int main() {\n\n    return 0;  // done\n}', open: false },
      { kind: 'text', text: 'then' },
      { kind: 'code', lang: 'c++', code: 'x++;', open: false },
    ]);
  });

  it('does not treat inline triple backticks inside a sentence as a fence', () => {
    expect(splitAnswer('Wrap code in ```python fences.')).toEqual([{ kind: 'text', text: 'Wrap code in ```python fences.' }]);
  });
});

describe('splitInlineCode', () => {
  it('marks `inline code` spans and leaves the rest as text', () => {
    expect(splitInlineCode('用 `seen[x]` 查找，再更新 `i`。')).toEqual([
      { code: false, text: '用 ' },
      { code: true, text: 'seen[x]' },
      { code: false, text: ' 查找，再更新 ' },
      { code: true, text: 'i' },
      { code: false, text: '。' },
    ]);
    expect(splitInlineCode('no code here')).toEqual([{ code: false, text: 'no code here' }]);
    expect(splitInlineCode('a ` lone backtick')).toEqual([{ code: false, text: 'a ` lone backtick' }]);
  });
});

describe('codeIndent', () => {
  it('counts leading spaces and expands tabs to the next multiple of 4', () => {
    expect(codeIndent('x = 1  # set x')).toBe(0);
    expect(codeIndent('    return x  # done')).toBe(4);
    expect(codeIndent('\tif x:')).toBe(4);
    expect(codeIndent('  \tif x:')).toBe(4);
    expect(codeIndent('\t\t  y')).toBe(10);
    expect(codeIndent('')).toBe(0);
    expect(codeIndent('      ')).toBe(6);
  });
});

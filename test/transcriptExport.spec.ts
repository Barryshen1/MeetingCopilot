import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatTranscriptMarkdown, transcriptFileName } from '../shared/transcriptExport';
import { writeMeetingRecord } from '../electron/meetingRecords';
import type { SessionsFile } from '../shared/protocol';
import type { TranscriptSegment } from '../shared/transcript';

const at = (h: number, m: number, s = 0) => new Date(2026, 9, 2, h, m, s).getTime();
const segments: TranscriptSegment[] = [
  { id: 2, text: 'Second line', speaker: 'me', startTs: at(15, 5), endTs: at(15, 5, 20), translation: '第二句（AI 翻译）' },
  { id: 1, text: '  Hello 老师。 ', speaker: 'them', startTs: at(15, 3, 43), endTs: at(15, 4, 10) },
  { id: 3, text: '   ', speaker: 'them', startTs: at(15, 6), endTs: at(15, 6, 1) },
  { id: 4, text: 'Last', startTs: at(15, 29, 59), endTs: at(15, 30, 44) },
];

describe('meeting record format', () => {
  it('lists spoken segments in time order with speaker and time, and nothing AI-generated', () => {
    const md = formatTranscriptMarkdown({ name: 'Oct 2 meeting', segments, lang: 'zh' });
    expect(md).toContain('# Oct 2 meeting');
    expect(md).toContain('- 日期：2026-10-02（星期五）');
    expect(md).toContain('- 时间：15:03 – 15:30（约 27 分钟）');
    expect(md).toContain('- 共 3 段转录');
    expect(md.indexOf('**15:03:43 · 对方**')).toBeLessThan(md.indexOf('**15:05:00 · 我**'));
    expect(md).toContain('\n\nHello 老师。\n');
    expect(md).toContain('**15:29:59 · 对方**'); // no speaker = the other party
    expect(md).not.toContain('AI 翻译');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('uses English labels for an English UI', () => {
    const md = formatTranscriptMarkdown({ name: '', segments, lang: 'en' });
    expect(md).toContain('# Untitled meeting');
    expect(md).toContain('**15:05:00 · Me**');
    expect(md).toContain('(Fri)');
  });

  it('names the file after the first spoken segment and strips unsafe characters', () => {
    expect(transcriptFileName('Oct 2 meeting', segments, 0)).toBe('2026-10-02 1503 Oct 2 meeting.md');
    expect(transcriptFileName('a/b:c*?"<>| ', segments, 0)).toBe('2026-10-02 1503 a b c.md');
    expect(transcriptFileName('', [], at(9, 7))).toBe('2026-10-02 0907.md');
  });
});

describe('writing a meeting record', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mc-records-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const file = (over: Partial<SessionsFile['sessions'][number]> = {}): SessionsFile => ({
    currentId: 's1',
    sessions: [{ id: 's1', name: 'Oct 2 meeting', createdAt: at(15, 0), turns: [{ id: 't', kind: 'free', label: 'q', text: 'AI answer text', status: 'done' } as never], segments, ...over }],
  });

  it('writes the current session into a new folder and overwrites on re-export', () => {
    const folder = join(dir, 'records');
    const first = writeMeetingRecord(folder, file(), null, 'zh');
    expect(first.ok).toBe(true);
    expect(first.path).toBe(join(folder, '2026-10-02 1503 Oct 2 meeting.md'));
    const again = writeMeetingRecord(folder, file(), 's1', 'zh');
    expect(again.path).toBe(first.path);
    expect(readdirSync(folder)).toEqual(['2026-10-02 1503 Oct 2 meeting.md']);
    expect(readFileSync(first.path!, 'utf8')).not.toContain('AI answer text');
  });

  it('reports EMPTY instead of writing a file when nothing was said', () => {
    expect(writeMeetingRecord(dir, file({ segments: [] }), null, 'zh')).toEqual({ ok: false, error: 'EMPTY' });
    expect(writeMeetingRecord(dir, file(), 'missing', 'zh')).toEqual({ ok: false, error: 'EMPTY' });
    expect(readdirSync(dir)).toEqual([]);
  });
});

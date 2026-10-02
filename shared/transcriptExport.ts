/**
 * Meeting-record export: the transcript only. AI answers, translations and
 * the rolling memo are model output, not what was said, so they never enter
 * the file. Pure (no fs / electron) so the format is unit-tested.
 */
import type { TranscriptSegment } from './transcript';
import type { UiLang } from './protocol';

export interface TranscriptExportInput {
  name: string;
  segments: readonly TranscriptSegment[];
  lang: UiLang;
}

const STRINGS = {
  zh: {
    them: '对方',
    me: '我',
    weekday: ['日', '一', '二', '三', '四', '五', '六'],
    date: (ymd: string, wd: string) => `- 日期：${ymd}（星期${wd}）`,
    time: (from: string, to: string, minutes: number) => `- 时间：${from} – ${to}（约 ${minutes} 分钟）`,
    count: (n: number) => `- 共 ${n} 段转录 · 由 MeetingCopilot 导出，不含 AI 回复和翻译`,
    untitled: '未命名会议',
  },
  en: {
    them: 'Them',
    me: 'Me',
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    date: (ymd: string, wd: string) => `- Date: ${ymd} (${wd})`,
    time: (from: string, to: string, minutes: number) => `- Time: ${from} – ${to} (about ${minutes} min)`,
    count: (n: number) => `- ${n} transcript segments · exported by MeetingCopilot, without AI answers or translations`,
    untitled: 'Untitled meeting',
  },
} as const;

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const hms = (d: Date) => `${hm(d)}:${pad(d.getSeconds())}`;

/** Spoken segments in time order; empty ones (VAD noise) are dropped. */
export function exportableSegments(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return segments
    .filter((s) => typeof s.text === 'string' && s.text.trim() && Number.isFinite(s.startTs))
    .slice()
    .sort((a, b) => a.startTs - b.startTs);
}

export function formatTranscriptMarkdown({ name, segments, lang }: TranscriptExportInput): string {
  const t = STRINGS[lang] ?? STRINGS.zh;
  const segs = exportableSegments(segments);
  const title = name.trim() || t.untitled;
  const lines = [`# ${title}`, ''];
  if (segs.length) {
    const start = new Date(segs[0].startTs);
    const endTs = Math.max(...segs.map((s) => (Number.isFinite(s.endTs) ? s.endTs : s.startTs)));
    const end = new Date(endTs);
    const minutes = Math.max(1, Math.round((endTs - segs[0].startTs) / 60_000));
    lines.push(
      t.date(ymd(start), t.weekday[start.getDay()]),
      t.time(hm(start), hm(end), minutes),
      t.count(segs.length),
      '',
      '---',
      '',
    );
  }
  for (const seg of segs) {
    const who = seg.speaker === 'me' ? t.me : t.them;
    lines.push(`**${hms(new Date(seg.startTs))} · ${who}**`, '', seg.text.trim(), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * "2026-10-02 1503 Oct 2 meeting.md": dated by the first spoken segment, so
 * re-exporting the same meeting (stop, resume, stop) overwrites one file.
 */
export function transcriptFileName(name: string, segments: readonly TranscriptSegment[], fallbackTs: number): string {
  const first = exportableSegments(segments)[0];
  const d = new Date(first ? first.startTs : fallbackTs);
  const safe = name
    .replace(/[\u0000-\u001f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return `${ymd(d)} ${pad(d.getHours())}${pad(d.getMinutes())}${safe ? ` ${safe}` : ''}.md`;
}

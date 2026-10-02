/**
 * Writes one session's meeting record (transcript only) as Markdown.
 * Kept free of Electron so it is unit-testable with a temp folder.
 */
import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { SessionsFile, TranscriptExportResult, UiLang } from '../shared/protocol';
import { exportableSegments, formatTranscriptMarkdown, transcriptFileName } from '../shared/transcriptExport';

export function writeMeetingRecord(
  folder: string,
  sessions: SessionsFile,
  sessionId: string | null | undefined,
  lang: UiLang,
  now = Date.now(),
): TranscriptExportResult {
  const id = sessionId ?? sessions.currentId;
  const session = sessions.sessions.find((s) => s.id === id);
  const segments = session?.segments ?? [];
  if (!session || exportableSegments(segments).length === 0) return { ok: false, error: 'EMPTY' };
  try {
    mkdirSync(folder, { recursive: true });
    const path = join(folder, transcriptFileName(session.name, segments, session.createdAt || now));
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, formatTranscriptMarkdown({ name: session.name, segments, lang }), 'utf8');
    renameSync(tmp, path);
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Deterministic document→text extraction for session reference material.
 * NO LLM / function calling — parsing is a pure I/O task and the main answer
 * path is latency-first (HANDOFF §5 P0-2). Scanned/image-only PDFs have no
 * text layer and yield '' — the renderer surfaces that as a warning.
 */
import { readFileSync, statSync } from 'fs';
import { basename, extname } from 'path';
import { MAX_SESSION_ATTACHMENTS, type PickedDocument } from '../shared/protocol';

/** extensions offered in the pick dialog (parse support below must match) */
export const DOC_EXTENSIONS = [
  'md', 'markdown', 'txt', 'docx', 'pdf',
  'csv', 'tsv', 'json', 'jsonl', 'log',
  'py', 'js', 'jsx', 'ts', 'tsx', 'java', 'cpp', 'c', 'h', 'go', 'rs', 'sql',
] as const;

/** Bound both parsing resources and what a session can persist as text. */
export const MAX_DOC_BYTES = 20 * 1024 * 1024;
export const MAX_DOC_TEXT_CHARS = 200_000;
export const MAX_DOCS_PER_PICK = MAX_SESSION_ATTACHMENTS;

export type DocParseErrorCode = 'UNSUPPORTED' | 'TOO_LARGE' | 'TEXT_TOO_LONG';

export class DocParseError extends Error {
  constructor(readonly code: DocParseErrorCode) {
    super(code);
    this.name = 'DocParseError';
  }
}

function boundedText(text: string): string {
  const normalized = normalizeDocText(text);
  if (normalized.length > MAX_DOC_TEXT_CHARS) throw new DocParseError('TEXT_TOO_LONG');
  return normalized;
}

/** collapse parser artifacts: CRLF, trailing spaces, 3+ consecutive newlines */
export function normalizeDocText(t: string): string {
  return t
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractDocText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase().slice(1);
  if (!DOC_EXTENSIONS.some((supported) => supported === ext)) {
    throw new DocParseError('UNSUPPORTED');
  }
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size > MAX_DOC_BYTES) {
    throw new DocParseError('TOO_LARGE');
  }
  if (ext === 'docx') {
    const mod: any = await import('mammoth');
    const mammoth = mod.default ?? mod;
    const r = await mammoth.extractRawText({ path: filePath });
    return boundedText(r.value ?? '');
  }
  if (ext === 'pdf') {
    const mod: any = await import('pdf-parse');
    const PDFParse = mod.PDFParse ?? mod.default?.PDFParse;
    const parser = new PDFParse({ data: new Uint8Array(readFileSync(filePath)) });
    try {
      const r = await parser.getText({ pageJoiner: '' });
      return boundedText(r.text ?? '');
    } finally {
      await parser.destroy();
    }
  }
  // Fatal decoding prevents silently importing binary files renamed as text.
  return boundedText(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(filePath)));
}

/** Import valid files in selection order even when another selected file fails. */
export async function extractDocBatch(filePaths: readonly string[]): Promise<{
  files: PickedDocument[];
  skipped: number;
}> {
  const files: PickedDocument[] = [];
  let skipped = Math.max(0, filePaths.length - MAX_DOCS_PER_PICK);
  for (const filePath of filePaths.slice(0, MAX_DOCS_PER_PICK)) {
    try {
      const text = await extractDocText(filePath);
      if (text) files.push({ name: basename(filePath), text, chars: text.length });
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { files, skipped };
}

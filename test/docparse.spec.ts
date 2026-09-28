import { describe, expect, it } from 'vitest';
import { mkdtempSync, truncateSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DOC_EXTENSIONS,
  MAX_DOC_BYTES,
  MAX_DOC_TEXT_CHARS,
  extractDocBatch,
  extractDocText,
  normalizeDocText,
} from '../electron/docparse';

const FIX = join(__dirname, 'fixtures');

describe('extractDocText (deterministic resume/JD parsing)', () => {
  // mammoth/pdf-parse cold-load can exceed vitest default; observed 43 s+ on slow GitHub Windows runners
  it('reads a .docx via mammoth (zh + en)', { timeout: 120_000 }, async () => {
    const text = await extractDocText(join(FIX, 'sample.docx'));
    expect(text).toContain('Docx fixture resume');
    expect(text).toContain('项目经历：实时转录 whisper DirectML');
  });

  it('reads a .pdf via pdf-parse without page-number artifacts', { timeout: 120_000 }, async () => {
    const text = await extractDocText(join(FIX, 'sample.pdf'));
    expect(text).toContain('Resume PDF fixture: Python and SQL');
    expect(text).not.toContain('-- 1 of 1 --');
  });

  it('reads plain .md/.txt as utf8', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-doc-'));
    const p = join(dir, 'kb.md');
    writeFileSync(p, '# 简历\n\n项目：MeetingCopilot', 'utf8');
    expect(await extractDocText(p)).toBe('# 简历\n\n项目：MeetingCopilot');
  });

  it('reads additional reference text and source files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-context-'));
    for (const ext of ['csv', 'tsv', 'json', 'jsonl', 'log', 'py', 'js', 'jsx', 'ts', 'tsx', 'java', 'cpp', 'c', 'h', 'go', 'rs', 'sql']) {
      const p = join(dir, `reference.${ext}`);
      writeFileSync(p, '项目,说明\n检索,引用上下文', 'utf8');
      expect(await extractDocText(p)).toContain('检索,引用上下文');
    }
  });

  it('advertises every supported format in the picker', () => {
    expect(DOC_EXTENSIONS).toEqual([
      'md', 'markdown', 'txt', 'docx', 'pdf',
      'csv', 'tsv', 'json', 'jsonl', 'log',
      'py', 'js', 'jsx', 'ts', 'tsx', 'java', 'cpp', 'c', 'h', 'go', 'rs', 'sql',
    ]);
  });

  it('rejects unsupported, oversized, and binary-disguised files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-doc-limit-'));
    const badExtension = join(dir, 'reference.exe');
    writeFileSync(badExtension, 'hello');
    await expect(extractDocText(badExtension)).rejects.toMatchObject({ code: 'UNSUPPORTED' });

    const tooLarge = join(dir, 'reference.txt');
    writeFileSync(tooLarge, '');
    truncateSync(tooLarge, MAX_DOC_BYTES + 1);
    await expect(extractDocText(tooLarge)).rejects.toMatchObject({ code: 'TOO_LARGE' });

    const binary = join(dir, 'renamed.md');
    writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x00]));
    await expect(extractDocText(binary)).rejects.toThrow();
  });

  it('rejects text that exceeds the session material limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-doc-chars-'));
    const p = join(dir, 'long.txt');
    writeFileSync(p, 'x'.repeat(MAX_DOC_TEXT_CHARS + 1));
    await expect(extractDocText(p)).rejects.toMatchObject({ code: 'TEXT_TOO_LONG' });
  });

  it('imports valid files when other selected files fail or have no text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-doc-batch-'));
    const good = join(dir, 'notes.md');
    const bad = join(dir, 'binary.txt');
    const empty = join(dir, 'empty.log');
    writeFileSync(good, '# Notes\nProject context');
    writeFileSync(bad, Buffer.from([0xff]));
    writeFileSync(empty, '  \n  ');
    await expect(extractDocBatch([bad, good, empty])).resolves.toEqual({
      files: [{ name: 'notes.md', text: '# Notes\nProject context', chars: 23 }],
      skipped: 2,
    });
  });
});

describe('normalizeDocText', () => {
  it('collapses CRLF, trailing spaces and 3+ newlines', () => {
    expect(normalizeDocText('a  \r\n\r\n\r\n\r\nb\t\n')).toBe('a\n\nb');
  });
  it('empty input (scanned pdf) stays empty', () => {
    expect(normalizeDocText('  \n \n')).toBe('');
  });
});

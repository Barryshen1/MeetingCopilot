/**
 * Split an AI answer into prose and fenced code blocks so the answer pane can
 * show code in a monospace block (indentation kept, horizontal scroll, its
 * own copy button). Coding Test answers are mostly code; other answers rarely
 * contain a fence and come back as a single text part.
 *
 * Streaming-safe: an opening ``` without its closing fence yet becomes an
 * `open` code block, so code is formatted while it is still arriving.
 * Pure (no DOM) so it is unit-tested.
 */

export type AnswerPart =
  | { kind: 'text'; text: string }
  | { kind: 'code'; lang: string; code: string; open: boolean };

const FENCE_OPEN = /^\s*```\s*([\w+#.-]*)\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;

/** drop the blank lines a fence leaves around prose (pre-wrap would show them) */
function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
}

export function splitAnswer(text: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let prose: string[] = [];
  let code: string[] | null = null;
  let lang = '';

  const flushProse = () => {
    const t = trimBlankLines(prose.join('\n'));
    if (t.trim()) parts.push({ kind: 'text', text: t });
    prose = [];
  };

  for (const line of text.split('\n')) {
    if (code === null) {
      const open = FENCE_OPEN.exec(line);
      if (open) {
        flushProse();
        code = [];
        lang = open[1].toLowerCase();
      } else {
        prose.push(line);
      }
    } else if (FENCE_CLOSE.test(line)) {
      parts.push({ kind: 'code', lang, code: code.join('\n'), open: false });
      code = null;
    } else {
      code.push(line);
    }
  }
  if (code !== null) parts.push({ kind: 'code', lang, code: code.join('\n'), open: true });
  flushProse();
  return parts;
}

/**
 * Columns of leading indentation (a tab = 4). The answer pane wraps long code
 * lines — every line carries a comment, and a narrow pane would otherwise
 * hide the comments behind a sideways scroll — and continues a wrapped line
 * just past its own indentation, so the code's structure stays readable.
 */
export function codeIndent(line: string): number {
  let columns = 0;
  for (const ch of line) {
    if (ch === ' ') columns += 1;
    else if (ch === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/** `inline code` spans inside prose (never across lines) */
export function splitInlineCode(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
    out.push({ code: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

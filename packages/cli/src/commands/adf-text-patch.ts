/**
 * Byte-preserving application of populate's patch operations (#354).
 *
 * `applyPatches` + `formatAdf` re-renders the whole file, which drops CRLF,
 * reorders sections and normalizes whitespace. Here each operation edits only
 * the lines it is about, in place: line endings and the trailing-newline state
 * are kept, and every other byte is untouched. The result is re-parsed and must
 * equal `applyPatches(parseAdf(text), ops)` exactly, or nothing is written.
 *
 * Supported: ADD_BULLET, REPLACE_SECTION (list or map content), ADD_SECTION
 * (list content). Like the patcher, each targets the FIRST section with its key.
 * An ADD_SECTION may carry an `anchor` (TextPatchOperation): the section is then
 * placed after/before the first anchor section present, and the guard expects it
 * at that same position; without one (or when no anchor is present) it is appended.
 */

import { applyPatches, parseAdf } from '@stackbilt/adf';
import type { AdfContent, PatchOperation } from '@stackbilt/adf';
import { sectionHeaders } from './adf-manifest-register';

/** Where an added section goes: after the first `after` key present, else before the first `before` key present, else at the end. */
export interface SectionAnchor { after?: readonly string[]; before?: readonly string[] }

export type TextPatchOperation = PatchOperation | (Extract<PatchOperation, { op: 'ADD_SECTION' }> & { anchor?: SectionAnchor });

export type TextPatchResult =
  | { status: 'applied'; next: string }
  | { status: 'refused'; reason: 'unparseable' | 'unsupported' | 'guard'; detail: string };

const LIST_ITEM_PREFIX_RE = /^(\s*-\s+)\S/;
const clean = (line: string): string => line.replace(/\r$/, '').trimEnd();

function bodyLines(content: AdfContent, indent: string): string[] | null {
  if (content.type === 'list') return content.items.map(i => `${indent}- ${i}`);
  if (content.type === 'map') return content.entries.map(e => `${indent}${e.key}: ${e.value}`);
  return null;
}

/** First `key` section: header line, and the last non-blank line of its body (header when empty). */
function locate(lines: string[], key: string): { header: number; last: number; end: number } | null {
  const { headers, own } = sectionHeaders(lines, key);
  if (own.length === 0) return null;
  const header = own[0];
  const end = headers.find(i => i > header) ?? lines.length;
  let last = header;
  for (let i = header + 1; i < end; i++) if (clean(lines[i]) !== '') last = i;
  return { header, last, end };
}

/** The file's dominant line ending: CRLF only when most of its line breaks are CRLF. */
function dominantCr(text: string): boolean {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  return crlf > (text.match(/\n/g) ?? []).length - crlf;
}

/** The ending of line `i` (`'\r'` for CRLF), or the dominant one when that line has no newline of its own. */
function endingOf(lines: string[], i: number, fallbackCr: boolean): boolean {
  if (i < 0 || i >= lines.length - 1) return fallbackCr;
  return lines[i].endsWith('\r');
}

/**
 * Insert or replace lines [from, to] (inclusive; to = from - 1 inserts). New lines
 * take the ending of the line they sit next to (`crlf`); no existing line's ending
 * changes, and the final-newline state is kept.
 */
function splice(lines: string[], from: number, to: number, add: string[], crlf: boolean): void {
  const cr = crlf ? '\r' : '';
  const atEof = to === lines.length - 1; // the last element has no newline after it
  const out = add.map(l => l + cr);
  if (atEof && out.length > 0) out[out.length - 1] = out[out.length - 1].replace(/\r$/, '');
  if (to < from && from === lines.length) {
    // Inserting after a final line that has no trailing newline.
    lines[lines.length - 1] += cr;
  }
  lines.splice(from, to - from + 1, ...out);
}

/** The resolved anchor against the keys present: `{ key, side }`, or null for "append". */
function resolveAnchor(keys: readonly string[], anchor: SectionAnchor | undefined): { key: string; side: 'after' | 'before' } | null {
  const after = anchor?.after?.find(k => keys.includes(k));
  if (after) return { key: after, side: 'after' };
  const before = anchor?.before?.find(k => keys.includes(k));
  return before ? { key: before, side: 'before' } : null;
}

function applyOne(text: string, op: TextPatchOperation): string | null {
  const dominant = dominantCr(text);
  const eol = dominant ? '\r\n' : '\n';
  const lines = text.split('\n');

  if (op.op === 'ADD_BULLET') {
    const loc = locate(lines, op.section);
    if (!loc) return null;
    let after = -1;
    let prefix = '  - ';
    for (let i = loc.header + 1; i < loc.end; i++) {
      const m = clean(lines[i]).match(LIST_ITEM_PREFIX_RE);
      if (m) { after = i; prefix = m[1]; }
    }
    if (after === -1) return null;
    splice(lines, after + 1, after, [prefix + op.value], endingOf(lines, after, dominant));
    return lines.join('\n');
  }

  if (op.op === 'REPLACE_SECTION') {
    const loc = locate(lines, op.key);
    if (!loc) return null;
    const firstBody = lines.slice(loc.header + 1, loc.last + 1).find(l => clean(l) !== '');
    const indent = firstBody?.match(/^\s*/)?.[0] ?? '  ';
    const add = bodyLines(op.content, indent || '  ');
    if (!add) return null;
    // Replaced lines take the ending of the body's first line (or the header's, for an empty body).
    const ref = loc.last > loc.header ? loc.header + 1 : loc.header;
    splice(lines, loc.header + 1, loc.last, add, endingOf(lines, ref, dominant));
    return lines.join('\n');
  }

  if (op.op === 'ADD_SECTION') {
    const add = bodyLines(op.content, '  ');
    if (!add) return null;
    // The parser drops U+FE0F after a decoration, so the AST holds a bare text-style
    // symbol such as U+26A0; write it back with the selector, as the scaffolds do (#371).
    const deco = op.decoration && !/\p{Emoji_Presentation}/u.test(op.decoration) && !op.decoration.endsWith('\uFE0F')
      ? `${op.decoration}\uFE0F`
      : op.decoration;
    const head = `${deco ? `${deco} ` : ''}${op.key}${op.weight ? ` [${op.weight}]` : ''}:`;
    const anchor = 'anchor' in op ? resolveAnchor(parseAdf(text).sections.map(s => s.key), op.anchor) : null;
    const loc = anchor ? locate(lines, anchor.key) : null;
    if (anchor && loc && anchor.side === 'after') {
      // After the anchor's last body line, separated by one blank line.
      splice(lines, loc.last + 1, loc.last, ['', head, ...add], endingOf(lines, loc.last, dominant));
      return lines.join('\n');
    }
    if (anchor && loc) {
      splice(lines, loc.header, loc.header - 1, [head, ...add, ''], endingOf(lines, loc.header, dominant));
      return lines.join('\n');
    }
    const block = [head, ...add].join(eol);
    if (text.length === 0) return block + eol;
    return text.endsWith('\n') ? `${text}${eol}${block}${eol}` : `${text}${eol}${eol}${block}`;
  }

  return null;
}

export function applyOpsAsText(text: string, ops: readonly TextPatchOperation[]): TextPatchResult {
  let expected;
  try {
    // One op at a time, so an anchored ADD_SECTION is placed against the document
    // as the earlier ops left it, exactly as the text edit below resolves it.
    expected = parseAdf(text);
    for (const op of ops) {
      const keys = expected.sections.map(s => s.key);
      expected = applyPatches(expected, [op]);
      const anchor = op.op === 'ADD_SECTION' && 'anchor' in op ? resolveAnchor(keys, op.anchor) : null;
      if (anchor) {
        const added = expected.sections.pop()!;
        const at = expected.sections.findIndex(s => s.key === anchor.key);
        expected.sections.splice(anchor.side === 'after' ? at + 1 : at, 0, added);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'refused', reason: 'unparseable', detail: `the file or the edit could not be parsed (${msg})` };
  }
  let next = text;
  for (const op of ops) {
    const edited = applyOne(next, op);
    if (edited === null) return { status: 'refused', reason: 'unsupported', detail: `${op.op} cannot be applied as a text edit here` };
    next = edited;
  }
  let actual;
  try {
    actual = parseAdf(next);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'refused', reason: 'guard', detail: `the edited file does not parse (${msg})` };
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const n = Math.max(actual.sections.length, expected.sections.length);
    let at = 'the section list';
    for (let i = 0; i < n; i++) {
      if (JSON.stringify(actual.sections[i]) !== JSON.stringify(expected.sections[i])) {
        at = `section ${expected.sections[i]?.key ?? actual.sections[i]?.key}`;
        break;
      }
    }
    return { status: 'refused', reason: 'guard', detail: `after the edit, ${at} would not re-parse as the intended content` };
  }
  return { status: 'applied', next };
}

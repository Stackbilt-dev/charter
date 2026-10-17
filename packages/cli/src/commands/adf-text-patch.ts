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
 */

import { applyPatches, parseAdf } from '@stackbilt/adf';
import type { AdfContent, PatchOperation } from '@stackbilt/adf';
import { sectionHeaders } from './adf-manifest-register';

export type TextPatchResult =
  | { status: 'applied'; next: string }
  | { status: 'refused'; reason: 'unparseable' | 'unsupported' | 'guard' };

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

/** Insert or replace lines [from, to] (inclusive; to = from - 1 inserts) keeping CRLF and the final-newline state. */
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

function applyOne(text: string, op: PatchOperation): string | null {
  const crlf = text.includes('\r\n');
  const eol = crlf ? '\r\n' : '\n';
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
    splice(lines, after + 1, after, [prefix + op.value], crlf);
    return lines.join('\n');
  }

  if (op.op === 'REPLACE_SECTION') {
    const loc = locate(lines, op.key);
    if (!loc) return null;
    const firstBody = lines.slice(loc.header + 1, loc.last + 1).find(l => clean(l) !== '');
    const indent = firstBody?.match(/^\s*/)?.[0] ?? '  ';
    const add = bodyLines(op.content, indent || '  ');
    if (!add) return null;
    splice(lines, loc.header + 1, loc.last, add, crlf);
    return lines.join('\n');
  }

  if (op.op === 'ADD_SECTION') {
    const add = bodyLines(op.content, '  ');
    if (!add) return null;
    const head = `${op.decoration ? `${op.decoration} ` : ''}${op.key}${op.weight ? ` [${op.weight}]` : ''}:`;
    const block = [head, ...add].join(eol);
    if (text.length === 0) return block + eol;
    return text.endsWith('\n') ? `${text}${eol}${block}${eol}` : `${text}${eol}${eol}${block}`;
  }

  return null;
}

export function applyOpsAsText(text: string, ops: readonly PatchOperation[]): TextPatchResult {
  let expected;
  try {
    expected = applyPatches(parseAdf(text), [...ops]);
  } catch {
    return { status: 'refused', reason: 'unparseable' };
  }
  let next = text;
  for (const op of ops) {
    const edited = applyOne(next, op);
    if (edited === null) return { status: 'refused', reason: 'unsupported' };
    next = edited;
  }
  try {
    if (JSON.stringify(parseAdf(next)) !== JSON.stringify(expected)) return { status: 'refused', reason: 'guard' };
  } catch {
    return { status: 'refused', reason: 'guard' };
  }
  return { status: 'applied', next };
}

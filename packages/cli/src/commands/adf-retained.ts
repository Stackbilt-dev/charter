/**
 * Retained sections in compiled output (#303).
 *
 * `adf compile --write` used to delete a user's `## Environment` (or protocol)
 * section from a compiled file, and refused to convert a pointer carrying one.
 * Compiled output now keeps those sections in a fenced block at the end of the
 * file:
 *
 *   <!-- charter:retained:start -->
 *   <!-- Kept verbatim by charter adf compile. Edit freely between the retained markers. -->
 *
 *   ## Environment
 *   - ...
 *   <!-- charter:retained:end -->
 *
 * composeCompiled is the ONE function that says what "freshly compiled" means
 * for an existing file. compile --write, compile --check and vendor restore all
 * use it, so they cannot disagree. score deliberately does not: it asks whether
 * .ai/ alone is substantive, so it keeps the pure compileAdf output.
 *
 * Nothing here imports adf.ts: pointer templates and markers are reached at
 * call time through adf-compile and adf-vendor, so the #355 circular-import
 * class cannot recur here.
 */

import { readRetainedSections } from './adf-tidy';
import { inferVendorMode, linesRestoreWouldDrop } from './adf-vendor';
import type { VendorFile } from './adf-vendor';
import { divergentRetainedHeadings } from './adf-compile';

export const RETAINED_START = '<!-- charter:retained:start -->';
export const RETAINED_END = '<!-- charter:retained:end -->';
/** First line inside a new block. The reader drops it. */
export const RETAINED_NOTE = '<!-- Kept verbatim by charter adf compile. Edit freely between the retained markers. -->';

/**
 * A heading the renderer could have produced: all caps, with an optional weight
 * suffix. Never treated as user content in a compiled file without a block, so
 * a section since removed from .ai/ cannot be resurrected (#296 class).
 */
export const GENERATED_HEADING_RE = /^## [A-Z][A-Z0-9_]*( _\((load-bearing|advisory)\)_)?$/;

/** The on-demand module index fence lines the compiler emits (html and hash forms). */
const MODULE_INDEX_FENCE_LINES = new Set(['<!-- agents-modules -->', '<!-- /agents-modules -->', '# agents-modules', '# /agents-modules']);

/**
 * Where retained content was read from:
 * block     the existing file has a retained block
 * legacy    a compiled file (banner) with retained sections outside any block
 * pointer   a pointer being converted: the retained sections that differ from its template
 * unmanaged a hand-authored file being converted under --force: every retained section
 * none      no file, or nothing qualifies
 */
export type RetainedSource = 'block' | 'legacy' | 'pointer' | 'unmanaged' | 'none';

export interface ComposedCompiled {
  /** What the file should hold: the fresh render, plus the retained block when there is content. */
  output: string;
  /** Headings carried, in order. */
  retainedSections: string[];
  retainedSource: RetainedSource;
  /** The carried text (no markers, no note). '' when nothing is carried. */
  body: string;
  /** Headings of retained sections that sat outside a block (they move into it). */
  unfenced: string[];
  /** Carried headings that equal a heading the fresh render emits (both are kept). */
  collisions: string[];
  /** The existing file without its retained block and carried sections ('' when no file). */
  generated: string;
}

interface Section {
  heading: string;
  start: number;
  /** Exclusive. */
  end: number;
}

const isH2 = (line: string): boolean => line.trim().startsWith('## ');

/** tidy's own retained-heading rule (isRetainedHeading, minus `## Session Start`), reused unchanged. */
const isRetained = (heading: string): boolean => readRetainedSections(heading) !== '';

/** H2 sections of `lines`. A section runs to the next H2, module index fence, retained marker, or the end. */
function sectionsOf(lines: string[], from = 0, to = lines.length): Section[] {
  const out: Section[] = [];
  let current: Section | null = null;
  for (let i = from; i < to; i++) {
    const t = lines[i].trim();
    const boundary = isH2(lines[i]) || MODULE_INDEX_FENCE_LINES.has(t) || t === RETAINED_START || t === RETAINED_END;
    if (boundary && current) {
      current.end = i;
      out.push(current);
      current = null;
    }
    if (isH2(lines[i])) current = { heading: t, start: i, end: to };
  }
  if (current) out.push(current);
  return out;
}

function trimBlankEdges(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === '') a++;
  while (b > a && lines[b - 1].trim() === '') b--;
  return lines.slice(a, b);
}

/** Join sections verbatim, with a blank line between two that would otherwise touch. */
function joinSections(parts: string[][]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    const lines = trimBlankEdges(part);
    if (lines.length === 0) continue;
    if (out.length > 0) out.push('');
    out.push(...lines);
  }
  return out;
}

const withoutWeight = (heading: string): string => heading.replace(/ _\((load-bearing|advisory)\)_$/, '');

/**
 * User sections in compiled text with no block (or outside one): retained headings
 * that the renderer could not have produced, other than `## Module Index`, and
 * whose text the fresh render does not already hold (a .ai/ text value may embed
 * a `## ` line; carrying it would duplicate it on every run).
 */
function legacySections(lines: string[], from: number, to: number, fresh: string): Section[] {
  return sectionsOf(lines, from, to).filter(s => {
    if (!isRetained(s.heading) || GENERATED_HEADING_RE.test(s.heading) || s.heading === '## Module Index') return false;
    const text = trimBlankEdges(lines.slice(s.start, s.end)).join('\n');
    return !fresh.includes(text);
  });
}

const sectionLines = (lines: string[], s: Section): string[] =>
  lines.slice(s.start, s.end).filter(l => l.trim() !== RETAINED_END && l.trim() !== RETAINED_NOTE);

function newBlock(body: string[]): string {
  return [RETAINED_START, RETAINED_NOTE, '', ...body, RETAINED_END].join('\n') + '\n';
}

/**
 * Compose compiled output for `file` from the fresh render and the file on disk.
 * Pure. With nothing to carry, the output is `fresh` byte for byte (P3).
 */
export function composeCompiled(fresh: string, existing: string | null, file: string): ComposedCompiled {
  const none: ComposedCompiled = {
    output: fresh, retainedSections: [], retainedSource: 'none', body: '', unfenced: [], collisions: [], generated: existing ?? '',
  };
  if (existing === null) return none;

  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  const removed = new Set<number>();
  const take = (s: Section): string[] => {
    for (let i = s.start; i < s.end; i++) removed.add(i);
    return sectionLines(lines, s);
  };

  let source: RetainedSource;
  let body: string[];
  let unfenced: string[] = [];
  let block: string | null = null;

  const start = lines.findIndex(l => l.trim() === RETAINED_START);
  if (start >= 0) {
    // A start with no end runs to EOF, matching stripCharterSentinels.
    let end = lines.findIndex((l, i) => i > start && l.trim() === RETAINED_END);
    const closed = end >= 0;
    if (!closed) end = lines.length;
    for (let i = start; i < Math.min(end + 1, lines.length); i++) removed.add(i);
    const inner = lines.slice(start + 1, end);
    const blockBody = trimBlankEdges(inner.filter(l => l.trim() !== RETAINED_NOTE));
    const before = legacySections(lines, 0, start, fresh);
    const after = closed ? legacySections(lines, end + 1, lines.length, fresh) : [];
    unfenced = [...before, ...after].map(s => s.heading);
    const beforeLines = before.map(take);
    const afterLines = after.map(take);
    body = joinSections([...beforeLines, blockBody, ...afterLines]);
    source = 'block';
    // The block is copied from disk as it stands, so an edit inside it can never
    // make --check stale (C1). It is rebuilt only to take in unfenced sections.
    if (unfenced.length === 0) {
      const raw = lines.slice(start, closed ? end + 1 : end);
      while (!closed && raw.length > 1 && raw[raw.length - 1].trim() === '') raw.pop();
      block = (closed ? raw : [...raw, RETAINED_END]).join('\n') + '\n';
    }
  } else {
    const mode = inferVendorMode(file as VendorFile, lines.join('\n')).inferredMode;
    if (mode === 'compiled') {
      const found = legacySections(lines, 0, lines.length, fresh);
      unfenced = found.map(s => s.heading);
      body = joinSections(found.map(take));
      source = 'legacy';
    } else if (mode === 'pointer') {
      const divergent = new Set(divergentRetainedHeadings(lines.join('\n'), file).filter(h => h !== '## Module Index'));
      body = joinSections(sectionsOf(lines).filter(s => divergent.has(s.heading)).map(take));
      source = 'pointer';
    } else {
      body = joinSections(sectionsOf(lines).filter(s => isRetained(s.heading) && s.heading !== '## Module Index').map(take));
      source = 'unmanaged';
    }
  }

  const generated = lines.filter((_, i) => !removed.has(i)).join('\n');
  if (body.length === 0 && block === null) return { ...none, generated };

  const retainedSections = body.filter(isH2).map(l => l.trim());
  const freshHeadings = new Set(fresh.split('\n').filter(isH2).map(l => withoutWeight(l.trim())));
  const collisions = retainedSections.filter(h => freshHeadings.has(withoutWeight(h)));
  const output = fresh.trimEnd() + '\n\n' + (block ?? newBlock(body));
  return {
    output, retainedSections, retainedSource: source, body: body.join('\n'), unfenced, collisions, generated,
  };
}

/**
 * Non-blank lines of `existing` that the composed compiled output would not keep,
 * ignoring Charter pointer-template lines and the generated module index
 * (linesRestoreWouldDrop semantics).
 */
export function linesConvertWouldDrop(existing: string, composed: string): string[] {
  return linesRestoreWouldDrop(existing, composed);
}

/**
 * True when `current` (a compiled file) holds nothing beyond `fresh` but its
 * retained content: the block, or retained sections outside one. Compared with
 * CRLF and trailing whitespace normalised, as restore always has.
 */
export function compiledMatchesFresh(fresh: string, current: string, file: string): boolean {
  const norm = (t: string): string => t.replace(/\r\n/g, '\n').trimEnd();
  return norm(composeCompiled(fresh, current, file).generated) === norm(fresh);
}

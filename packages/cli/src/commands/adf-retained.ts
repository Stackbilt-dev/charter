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
 * Section parsing is code-fence aware: a `## ` line or a marker inside a ``` or
 * ~~~ fence is text, and only /^ {0,3}## / is a heading (CommonMark).
 *
 * Nothing here imports adf.ts: pointer templates and markers are reached at
 * call time through adf-compile and adf-vendor, so the #355 circular-import
 * class cannot recur here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRetainedSections } from './adf-tidy';
import { inferVendorMode, linesRestoreWouldDrop } from './adf-vendor';
import type { VendorFile } from './adf-vendor';
import { divergentRetainedHeadings } from './adf-compile';

export const RETAINED_START = '<!-- charter:retained:start -->';
export const RETAINED_END = '<!-- charter:retained:end -->';
/** First line inside a new block. The reader drops it. */
export const RETAINED_NOTE = '<!-- Kept verbatim by charter adf compile. Edit freely between the retained markers. -->';

/**
 * Marker matchers. They mirror stripCharterSentinels' SENTINEL_START/END
 * (packages/adf/src/sentinels.ts) for the `retained` name exactly, so compile
 * and tidy/doctor/migrate agree on what a marker is (parity pinned by test).
 */
const START_RE = /^<!--\s*charter:retained:start\s*-->$/;
const END_RE = /^<!--\s*charter:retained:end\s*-->$/;
export const isRetainedStart = (line: string): boolean => START_RE.test(line.trim());
export const isRetainedEnd = (line: string): boolean => END_RE.test(line.trim());
const isNote = (line: string): boolean => line.trim() === RETAINED_NOTE;

/**
 * A heading the renderer could have produced: all caps, with an optional weight
 * suffix. Never treated as user content in a compiled file without a block, so
 * a section since removed from .ai/ cannot be resurrected (#296 class).
 */
export const GENERATED_HEADING_RE = /^## [A-Z][A-Z0-9_]*( _\((load-bearing|advisory)\)_)?$/;

/** The on-demand module index fence lines the compiler emits (html and hash forms). */
const MODULE_INDEX_FENCE_LINES = new Set(['<!-- agents-modules -->', '<!-- /agents-modules -->', '# agents-modules', '# /agents-modules']);

export const RETAINED_MSG = {
  skipped: '{file}: {heading} was not carried: it looks like compiler output from .ai/. If it is yours, move it into the retained block.',
} as const;

/**
 * Where retained content was read from:
 * block     the existing file has a retained block
 * legacy    a compiled file (banner) with retained sections outside any block
 * pointer   a pointer being converted: the retained sections that differ from its template
 * unmanaged a hand-authored file being converted under --force: every retained section
 * none      no file, or nothing qualifies
 */
export type RetainedSource = 'block' | 'legacy' | 'pointer' | 'unmanaged' | 'none';

export interface ComposeOptions {
  /** Trimmed lines of every current .ai/ module (readAiModuleLines). A legacy heading found there is not carried. */
  aiLines?: ReadonlySet<string>;
}

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
  /** Legacy retained-heading sections NOT carried because they look like rendered .ai/ text. */
  skipped: string[];
  /** Block content a pointer could not keep as retained: non-retained headings, or text before the first heading. */
  blockOther: string[];
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

const OPEN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const H2_RE = /^ {0,3}## /;

interface CodeMask {
  /** mask[i]: line i is inside a code fence (fence lines included). */
  mask: boolean[];
  /** A fence was still open at the end of the scanned range. */
  open: boolean;
}

/** Mark the lines of [from, to) that are inside ``` or ~~~ fences. */
function codeMask(lines: readonly string[], from = 0, to = lines.length): CodeMask {
  const mask = new Array<boolean>(lines.length).fill(false);
  let fence: string | null = null;
  for (let i = from; i < to; i++) {
    const line = lines[i];
    if (fence === null) {
      const m = OPEN_FENCE_RE.exec(line);
      // A backtick fence's info string may not contain a backtick (CommonMark).
      if (m && !(m[1][0] === '`' && line.slice(line.indexOf(m[1]) + m[1].length).includes('`'))) {
        fence = m[1];
        mask[i] = true;
      }
      continue;
    }
    mask[i] = true;
    const c = CLOSE_FENCE_RE.exec(line);
    if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
  }
  return { mask, open: fence !== null };
}

const isH2Line = (line: string): boolean => H2_RE.test(line);

/** tidy's own retained-heading rule (isRetainedHeading, minus `## Session Start`), reused unchanged. */
const isRetained = (heading: string): boolean => readRetainedSections(heading) !== '';

/**
 * H2 sections of [from, to). A section runs to the next heading, module index
 * fence, retained marker, or the end. Nothing inside a code fence is a boundary.
 */
function sectionsOf(lines: string[], code: CodeMask, from = 0, to = lines.length): Section[] {
  const out: Section[] = [];
  let current: Section | null = null;
  for (let i = from; i < to; i++) {
    if (code.mask[i]) continue;
    const t = lines[i].trim();
    const h2 = isH2Line(lines[i]);
    const boundary = h2 || MODULE_INDEX_FENCE_LINES.has(t) || isRetainedStart(t) || isRetainedEnd(t);
    if (boundary && current) {
      current.end = i;
      out.push(current);
      current = null;
    }
    if (h2) current = { heading: t, start: i, end: to };
  }
  if (current) out.push(current);
  return out;
}

/** Headings of `lines`, ignoring code fences. */
function headingsOf(lines: string[]): string[] {
  const code = codeMask(lines);
  return lines.filter((l, i) => !code.mask[i] && isH2Line(l)).map(l => l.trim());
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

/** The compiler's own structure in `lines`: where each generated section's body ends. */
interface RenderedSpan { start: number; end: number; matched: boolean }

/**
 * Generated sections of [from, to): each runs from its `## KEY` heading to the
 * next generated heading or module index fence. When the fresh render has the
 * same heading and the file holds exactly its body, the span is that body only
 * (`matched`), so a section the user appended after it stays outside.
 */
function renderedSpans(lines: string[], code: CodeMask, from: number, to: number, freshLines: string[], freshCode: CodeMask): RenderedSpan[] {
  const stopsOf = (ls: string[], c: CodeMask, a: number, b: number): number[] => {
    const s: number[] = [];
    for (let i = a; i < b; i++) {
      if (c.mask[i]) continue;
      const t = ls[i].trim();
      if ((isH2Line(ls[i]) && GENERATED_HEADING_RE.test(t)) || MODULE_INDEX_FENCE_LINES.has(t)) s.push(i);
    }
    return s;
  };
  const freshStops = stopsOf(freshLines, freshCode, 0, freshLines.length);
  const freshBody = (heading: string): string[] | null => {
    const at = freshStops.find(i => freshLines[i].trim() === heading);
    if (at === undefined) return null;
    const next = freshStops.find(i => i > at) ?? freshLines.length;
    return trimBlankEdges(['x', ...freshLines.slice(at + 1, next)]).slice(1);
  };
  const stops = stopsOf(lines, code, from, to);
  const spans: RenderedSpan[] = [];
  for (const g of stops) {
    const heading = lines[g].trim();
    if (!GENERATED_HEADING_RE.test(heading)) continue;
    const end = stops.find(i => i > g) ?? to;
    const body = freshBody(heading);
    const matched = body !== null && g + 1 + body.length <= end && body.every((l, k) => lines[g + 1 + k] === l);
    spans.push({ start: g, end: matched ? g + 1 + (body as string[]).length : end, matched });
  }
  return spans;
}

interface FreshContext {
  fresh: string;
  lines: string[];
  code: CodeMask;
  aiLines: ReadonlySet<string>;
}

/**
 * User sections in compiled text with no block (or outside one): retained headings
 * the renderer could not have produced, other than `## Module Index`. A section the
 * render accounts for is ignored. One that sits inside a generated section the
 * render no longer matches, or whose heading is in a current .ai/ module, is
 * rendered .ai/ text gone stale: it is not carried, and is reported (`skipped`).
 */
function legacySections(lines: string[], code: CodeMask, from: number, to: number, ctx: FreshContext): { carry: Section[]; skipped: string[] } {
  const spans = renderedSpans(lines, code, from, to, ctx.lines, ctx.code);
  const carry: Section[] = [];
  const skipped: string[] = [];
  for (const s of sectionsOf(lines, code, from, to)) {
    if (!isRetained(s.heading) || GENERATED_HEADING_RE.test(s.heading) || s.heading === '## Module Index') continue;
    const span = spans.find(sp => s.start > sp.start && s.start < sp.end);
    const text = trimBlankEdges(lines.slice(s.start, s.end)).join('\n');
    if (ctx.fresh.includes(text)) continue;
    if (span || ctx.aiLines.has(s.heading)) {
      skipped.push(s.heading);
      continue;
    }
    carry.push(s);
  }
  return { carry, skipped };
}

const sectionLines = (lines: string[], s: Section): string[] =>
  lines.slice(s.start, s.end).filter(l => !isRetainedEnd(l) && !isNote(l));

function newBlock(body: string[]): string {
  return [RETAINED_START, RETAINED_NOTE, '', ...body, RETAINED_END].join('\n') + '\n';
}

/** First index in [from, lines.length) matching `is` outside code fences (all matches when fences are unbalanced). */
function findMarker(lines: string[], from: number, is: (l: string) => boolean, skip = 0): number {
  const code = codeMask(lines, from);
  let seen = 0;
  for (let i = from; i < lines.length; i++) {
    if (!code.open && code.mask[i]) continue;
    if (!is(lines[i])) continue;
    if (seen++ < skip) continue;
    return i;
  }
  return -1;
}

/** Retained-block content a pointer cannot hold as retained sections (restore, K3). */
function blockOtherOf(body: string[]): string[] {
  const code = codeMask(body);
  const other: string[] = [];
  let sawHeading = false;
  for (let i = 0; i < body.length; i++) {
    if (code.mask[i] && !sawHeading) {
      if (!other.includes('(text before the first heading)')) other.push('(text before the first heading)');
      continue;
    }
    if (code.mask[i]) continue;
    if (isH2Line(body[i])) {
      sawHeading = true;
      const h = body[i].trim();
      if (!isRetained(h) || h === '## Module Index') other.push(h);
    } else if (!sawHeading && body[i].trim() !== '' && !other.includes('(text before the first heading)')) {
      other.push('(text before the first heading)');
    }
  }
  return other;
}

/** Trimmed non-blank lines of every .adf module under `aiDir` (for ComposeOptions.aiLines). */
export function readAiModuleLines(aiDir: string): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) walk(p);
      } else if (e.name.endsWith('.adf')) {
        try {
          for (const l of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) if (l.trim()) out.add(l.trim());
        } catch {
          // unreadable module: nothing to match
        }
      }
    }
  };
  walk(aiDir);
  return out;
}

/**
 * Compose compiled output for `file` from the fresh render and the file on disk.
 * Pure apart from `opts`. With nothing to carry, the output is `fresh` byte for byte (P3).
 */
export function composeCompiled(fresh: string, existing: string | null, file: string, opts: ComposeOptions = {}): ComposedCompiled {
  const none: ComposedCompiled = {
    output: fresh, retainedSections: [], retainedSource: 'none', body: '', unfenced: [], skipped: [], blockOther: [], collisions: [], generated: existing ?? '',
  };
  if (existing === null) return none;

  const normalized = existing.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const freshLines = fresh.split('\n');
  const ctx: FreshContext = { fresh, lines: freshLines, code: codeMask(freshLines), aiLines: opts.aiLines ?? new Set() };
  const removed = new Set<number>();
  const take = (s: Section): string[] => {
    for (let i = s.start; i < s.end; i++) removed.add(i);
    return sectionLines(lines, s);
  };

  let source: RetainedSource;
  let body: string[];
  let unfenced: string[] = [];
  let skipped: string[] = [];
  let blockOther: string[] = [];
  let block: string | null = null;

  // The block follows the rendered content. A marker line the render itself
  // contains (a .ai/ text value) is never the block's start.
  const freshTrim = fresh.trimEnd();
  let start: number;
  if (normalized.startsWith(`${freshTrim}\n`)) {
    start = findMarker(lines, freshTrim.split('\n').length, isRetainedStart);
  } else {
    const inFresh = findAll(freshLines, isRetainedStart);
    start = findMarker(lines, 0, isRetainedStart, inFresh);
  }

  const fullCode = codeMask(lines);
  if (start >= 0) {
    // A start with no end runs to EOF, matching stripCharterSentinels.
    let end = findMarker(lines, start + 1, isRetainedEnd);
    const closed = end >= 0;
    if (!closed) end = lines.length;
    for (let i = start; i < Math.min(end + 1, lines.length); i++) removed.add(i);
    const inner = lines.slice(start + 1, end);
    const blockBody = trimBlankEdges(inner.filter(l => !isNote(l)));
    const before = legacySections(lines, fullCode, 0, start, ctx);
    const after = closed ? legacySections(lines, codeMask(lines, end + 1), end + 1, lines.length, ctx) : { carry: [], skipped: [] };
    unfenced = [...before.carry, ...after.carry].map(s => s.heading);
    skipped = [...before.skipped, ...after.skipped];
    const beforeLines = before.carry.map(take);
    const afterLines = after.carry.map(take);
    body = joinSections([...beforeLines, blockBody, ...afterLines]);
    blockOther = blockOtherOf(blockBody);
    source = 'block';
    // The block is copied from disk as it stands, so an edit inside it can never
    // make --check stale (C1). It is rebuilt only to take in unfenced sections.
    if (unfenced.length === 0) {
      const raw = lines.slice(start, closed ? end + 1 : end);
      while (!closed && raw.length > 1 && raw[raw.length - 1].trim() === '') raw.pop();
      block = (closed ? raw : [...raw, RETAINED_END]).join('\n') + '\n';
    }
  } else {
    const mode = inferVendorMode(file as VendorFile, normalized).inferredMode;
    if (mode === 'compiled') {
      const found = legacySections(lines, fullCode, 0, lines.length, ctx);
      unfenced = found.carry.map(s => s.heading);
      skipped = found.skipped;
      body = joinSections(found.carry.map(take));
      source = 'legacy';
    } else if (mode === 'pointer') {
      const divergent = new Set(divergentRetainedHeadings(normalized, file).filter(h => h !== '## Module Index'));
      body = joinSections(sectionsOf(lines, fullCode).filter(s => divergent.has(s.heading)).map(take));
      source = 'pointer';
    } else {
      body = joinSections(sectionsOf(lines, fullCode).filter(s => isRetained(s.heading) && s.heading !== '## Module Index').map(take));
      source = 'unmanaged';
    }
  }

  const generated = lines.filter((_, i) => !removed.has(i)).join('\n');
  if (body.length === 0 && block === null) return { ...none, skipped, generated };

  const retainedSections = headingsOf(body);
  const freshHeadings = new Set(headingsOf(freshLines).map(withoutWeight));
  const collisions = retainedSections.filter(h => freshHeadings.has(withoutWeight(h)));
  const output = fresh.trimEnd() + '\n\n' + (block ?? newBlock(body));
  return {
    output, retainedSections, retainedSource: source, body: body.join('\n'), unfenced, skipped, blockOther, collisions, generated,
  };
}

/** How many lines of `lines` match `is` outside code fences (all matches when fences are unbalanced). */
function findAll(lines: string[], is: (l: string) => boolean): number {
  const code = codeMask(lines);
  return lines.filter((l, i) => (code.open || !code.mask[i]) && is(l)).length;
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
export function compiledMatchesFresh(fresh: string, current: string, file: string, opts: ComposeOptions = {}): boolean {
  const norm = (t: string): string => t.replace(/\r\n/g, '\n').trimEnd();
  return norm(composeCompiled(fresh, current, file, opts).generated) === norm(fresh);
}

/**
 * charter adf vendor (#318)
 *
 * Records whether each vendor agent-config file (CLAUDE.md, AGENTS.md, ...) is a
 * thin `pointer` to .ai/, `compiled` output of `charter adf compile`, or
 * `unmanaged`. The record is a VENDORS list in <aiDir>/manifest.adf:
 *
 *   🏷 VENDORS:
 *     - CLAUDE.md: pointer
 *     - AGENTS.md: compiled
 *
 * The record is intent; the markers in the file are evidence. With no valid
 * entry, a file's mode is inferred from its markers exactly as `adf tidy` sniffs
 * them today. `adf compile` and `adf tidy` act on the record; this module reads
 * and writes it (`adf vendor status|set|init`, plus the implicit writers that
 * record the mode of a vendor file they just wrote).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileAdf, parseAdf, parseManifest, COMPILE_BANNER_MARKER, TARGET_FILENAMES } from '@stackbilt/adf';
import type { AdfDocument, CompileTarget, ManifestVendorEntry } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import {
  MODULE_INDEX_END,
  MODULE_INDEX_START,
  POINTER_AGENTS_MD,
  POINTER_CLAUDE_MD,
  POINTER_CLAUDE_MD_HYBRID,
  POINTER_COPILOT_MD,
  POINTER_CURSORRULES,
  POINTER_GEMINI_MD,
  POINTER_MARKERS,
} from './adf';
import { fileIdentity, generateModuleIndex } from './adf-migrate';
import { divergentRetainedHeadings } from './adf-compile';
import { composeCompiled, compiledMatchesFresh } from './adf-retained';
import { countExtractable, readRetainedSections } from './adf-tidy';
import { insertManifestBullet, lastSectionIndex, replaceManifestBullet, sectionHeaders } from './adf-manifest-register';

// ============================================================================
// Entities
// ============================================================================

/** Compile targets, the only names that may be `compiled` (TARGET_FILENAMES order). */
export const COMPILABLE_VENDOR_FILES = ['CLAUDE.md', 'AGENTS.md', '.cursorrules', 'GEMINI.md'] as const;

/** Pointer-only names: no compile target renders them. agents.md is the legacy spelling (#302). */
export const POINTER_ONLY_VENDOR_FILES = ['agents.md', 'copilot-instructions.md'] as const;

/** Every name the record may hold, in the order `adf vendor status` prints. */
export const VENDOR_FILES = [...COMPILABLE_VENDOR_FILES, ...POINTER_ONLY_VENDOR_FILES] as const;
export type VendorFile = typeof VENDOR_FILES[number];

export const VENDOR_MODES = ['pointer', 'compiled', 'unmanaged'] as const;
export type VendorMode = typeof VENDOR_MODES[number];

/** Modes each file may hold. A pointer-only name may never be `compiled`. */
export const ALLOWED_MODES: Record<VendorFile, readonly VendorMode[]> = {
  'CLAUDE.md': ['pointer', 'compiled', 'unmanaged'],
  'AGENTS.md': ['pointer', 'compiled', 'unmanaged'],
  '.cursorrules': ['pointer', 'compiled', 'unmanaged'],
  'GEMINI.md': ['pointer', 'compiled', 'unmanaged'],
  'agents.md': ['pointer', 'unmanaged'],
  'copilot-instructions.md': ['pointer', 'unmanaged'],
};

export type ModeSource = 'recorded' | 'inferred';

/** What was seen on disk. Always computed, even when the mode is recorded. */
export interface VendorEvidence {
  exists: boolean;
  /** The file contains COMPILE_BANNER_MARKER. */
  banner: boolean;
  /** The POINTER_MARKERS found, in POINTER_MARKERS order. */
  pointerMarkers: string[];
  /** The inferred mode for this content (null iff !exists). */
  inferredMode: VendorMode | null;
}

export interface ResolvedVendorMode {
  file: VendorFile;
  /** The recorded mode when source is 'recorded', else the inferred one. */
  mode: VendorMode;
  source: ModeSource;
  evidence: VendorEvidence;
  /** Recorded, the file exists, and its inferred mode differs. Reported only. */
  disagrees: boolean;
}

export type VendorEntryProblem = 'malformed' | 'unknown-file' | 'mode-not-allowed' | 'duplicate';

export type VendorWriteSkipReason =
  | 'manifest-missing'
  | 'manifest-unparseable'
  | 'section-not-list'
  | 'entry-malformed'
  | 'mode-not-allowed'
  | 'already-recorded'
  | 'reparse-guard'
  | 'file-absent';

export type VendorWriteResult =
  | { status: 'planned'; file: VendorFile; mode: VendorMode; previous: VendorMode | null }
  | { status: 'added'; file: VendorFile; mode: VendorMode }
  | { status: 'updated'; file: VendorFile; mode: VendorMode; previous: VendorMode }
  | { status: 'unchanged'; file: VendorFile; mode: VendorMode }
  | { status: 'skipped'; file: VendorFile; mode: VendorMode; skipReason: VendorWriteSkipReason };

/**
 * add-if-absent: implicit writers (bootstrap, adf init --emit-pointers, adf migrate,
 *                adf compile --write) and `adf vendor init`. Never change an entry.
 * upsert:        `adf vendor set` only. Replaces the one bullet line in place.
 */
export type VendorWritePolicy = 'add-if-absent' | 'upsert';

export const VENDORS_SECTION_KEY = 'VENDORS';
/** Bare U+1F3F7: parseAdf drops U+FE0F, so only this form survives `adf fmt` unchanged. */
export const VENDORS_DECORATION = '\u{1F3F7}';

export const MSG = {
  unknownFile: "Unknown vendor file '{file}'. Expected one of: CLAUDE.md, AGENTS.md, .cursorrules, GEMINI.md, agents.md, copilot-instructions.md",
  unknownMode: "Unknown mode '{mode}'. Expected one of: pointer, compiled, unmanaged",
  modeNotAllowed: "{file} cannot be 'compiled': no compile target writes it. Allowed: pointer, unmanaged",
  usageSet: 'Usage: charter adf vendor set <file> <pointer|compiled|unmanaged> [--dry-run]',
  manifestMissing: '{manifestPath} not found; vendor modes cannot be recorded. Run: charter adf init',
  manifestMissingStatus: '{manifestPath} not found; showing inferred modes only.',
  manifestUnparseable: '{manifestPath} could not be parsed; vendor modes were not recorded. Fix the manifest or run: charter doctor',
  manifestUnparseableStatus: '{manifestPath} could not be parsed; showing inferred modes only. Fix the manifest or run: charter doctor',
  sectionNotList: 'VENDORS in {manifestPath} does not read as a list: every line under it must be an item like "  - CLAUDE.md: pointer" (ADF has no comment lines). {file} was not recorded.',
  sectionNotListStatus: 'VENDORS in {manifestPath} does not read as a list: every line under it must be an item like "  - CLAUDE.md: pointer" (ADF has no comment lines). Showing inferred modes only.',
  sameFile: '{file} is the same file as {recorded} on disk; recorded under {recorded}.',
  aliasRecorded: 'VENDORS in {manifestPath} records both {file} and {other}, which are the same file on disk; {file} is used.',
  entryProblem: "Ignoring VENDORS entry '{raw}' in {manifestPath}: {problem}. {file} falls back to its inferred mode.",
  entryProblemNoFile: "Ignoring VENDORS entry '{raw}' in {manifestPath}: {problem}.",
  entryDuplicate: "Ignoring VENDORS entry '{raw}' in {manifestPath}: duplicate. The last entry for {file} wins.",
  entryMalformedWrite: "VENDORS in {manifestPath} has an unreadable entry for {file} ('{raw}'); not rewritten. Fix that line by hand.",
  reparseGuard: '{manifestPath} could not be updated without changing its other entries; {file} was not recorded. Fix the manifest or run: charter doctor',
  alreadyRecorded: '{file} is recorded as {recorded} but {writer} wrote it as {mode}; record kept. To change it: charter adf vendor set {file} {mode}',
  initDisagrees: '{file} is recorded as {recorded} but looks {mode} on disk; record kept. To change it: charter adf vendor set {file} {mode}',
  fileAbsentSet: "{file} does not exist yet; recording '{mode}' as its intended mode.",
  setOk: '  [ok] {file}: {previous} -> {mode}',
  setUnchanged: '  [ok] {file} already recorded as {mode}',
  initOk: '  [ok] Recorded {n} vendor mode(s) in {manifestPath}',
  initNothing: '  [ok] All vendor files on disk already have a recorded mode.',
  usageRestore: 'Usage: charter adf vendor restore <file> [--dry-run] [--ai-dir <dir>] [--format json]',
  restoreOk: '  [ok] Restored {file} as a thin pointer{kept}',
  restorePlanned: '  [dry-run] Would restore {file} as a thin pointer{kept}',
  restoreUnchanged: '  [ok] {file} is already the thin pointer template',
  restoreModeNotPointer: '  [warn] {file} is {mode} ({source}); restore writes a pointer. Record that intent first: charter adf vendor set {file} pointer',
  restoreHandAuthored: '  [warn] {file} has hand-authored content that .ai/ does not hold. Move it first: charter adf migrate --source {file}',
  restoreBloated: '  [warn] {file} carries {n} item(s) beyond the pointer. Fold them into .ai/ first: charter adf tidy --source {file}',
  restoreLost: '  [warn] {file} has {n} line(s) the pointer template would drop: {lines}. Move them into a .ai/ module (or under ## Environment), or delete them, first.',
  restoreCompiledDiffers: '  [warn] {file} differs from what .ai/ compiles to (a hand edit, or .ai/ changed since), and restoring the pointer would lose that difference. Check it with: charter adf compile --target {target} --check. To keep the file as it is: charter adf vendor set {file} compiled',
  restoreRecord: '  [warn] {file} was not restored: its mode could not be recorded as pointer in {manifestPath}. Fix the manifest or run: charter adf vendor status',
  restoreWriteFailed: '  [warn] Could not write {file}: {error}.{note}',
  restoreReverted: ' Its new mode record was removed again.',
  restoreNotReverted: ' Its new mode record (pointer) was kept; delete that VENDORS line by hand if you do not want it.',
} as const;

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

export function isVendorFile(name: string): name is VendorFile {
  return (VENDOR_FILES as readonly string[]).includes(name);
}

export function isVendorMode(name: string): name is VendorMode {
  return (VENDOR_MODES as readonly string[]).includes(name);
}

export function isModeAllowed(file: VendorFile, mode: VendorMode): boolean {
  return ALLOWED_MODES[file].includes(mode);
}

// ============================================================================
// Inference
// ============================================================================

/**
 * Infer a file's mode from its content (null when the file is absent). Matches
 * adf-tidy's analyzeVendorFile: the compile banner first (compiled output can
 * quote a pointer-marker sentence, #296), then POINTER_MARKERS, else unmanaged.
 * A banner on a pointer-only name cannot come from compile, so it is unmanaged.
 */
export function inferVendorMode(file: VendorFile, content: string | null): VendorEvidence {
  if (content === null) return { exists: false, banner: false, pointerMarkers: [], inferredMode: null };
  const banner = content.includes(COMPILE_BANNER_MARKER);
  const pointerMarkers = POINTER_MARKERS.filter(marker => content.includes(marker));
  let inferredMode: VendorMode = banner ? 'compiled' : pointerMarkers.length > 0 ? 'pointer' : 'unmanaged';
  if (!isModeAllowed(file, inferredMode)) inferredMode = 'unmanaged';
  return { exists: true, banner, pointerMarkers, inferredMode };
}

// ============================================================================
// Reading the record
// ============================================================================

export interface ClassifiedVendorEntries {
  /** The winning valid entry per file: its mode and its index among the section's items. */
  recorded: Map<VendorFile, { mode: VendorMode; index: number }>;
  problems: Array<{ raw: string; problem: VendorEntryProblem; file: VendorFile | null }>;
  /** Files with a malformed entry whose first token names them, with that entry's raw text. */
  malformedFor: Map<VendorFile, string>;
}

/** First token of a raw item, up to whitespace or a colon. */
function leadingName(raw: string): string {
  return raw.split(/[\s:]/, 1)[0] ?? '';
}

/**
 * Validate raw VENDORS entries. Malformed, unknown-file and mode-not-allowed
 * entries are ignored for resolution. Among valid entries for one file the last
 * wins; the earlier ones are reported as duplicates.
 */
export function classifyVendorEntries(entries: readonly ManifestVendorEntry[]): ClassifiedVendorEntries {
  const recorded = new Map<VendorFile, { mode: VendorMode; index: number }>();
  const problems: ClassifiedVendorEntries['problems'] = [];
  const malformedFor = new Map<VendorFile, string>();
  const valid: Array<{ raw: string; file: VendorFile; mode: VendorMode; index: number }> = [];

  entries.forEach((entry, index) => {
    if (entry.file === null || entry.mode === null || !isVendorMode(entry.mode)) {
      const name = leadingName(entry.raw);
      problems.push({ raw: entry.raw, problem: 'malformed', file: isVendorFile(name) ? name : null });
      if (isVendorFile(name) && !malformedFor.has(name)) malformedFor.set(name, entry.raw);
      return;
    }
    if (!isVendorFile(entry.file)) {
      problems.push({ raw: entry.raw, problem: 'unknown-file', file: null });
      return;
    }
    if (!isModeAllowed(entry.file, entry.mode)) {
      problems.push({ raw: entry.raw, problem: 'mode-not-allowed', file: entry.file });
      return;
    }
    valid.push({ raw: entry.raw, file: entry.file, mode: entry.mode, index });
  });

  for (const entry of valid) recorded.set(entry.file, { mode: entry.mode, index: entry.index });
  for (const entry of valid) {
    if (recorded.get(entry.file)?.index !== entry.index) {
      problems.push({ raw: entry.raw, problem: 'duplicate', file: entry.file });
    }
  }
  return { recorded, problems, malformedFor };
}

export interface VendorRecord extends ClassifiedVendorEntries {
  manifestPath: string;
  manifestFound: boolean;
  /** Set when the record could not be read; every file then falls back to inference. */
  readProblem?: 'manifest-unparseable' | 'section-not-list';
}

/** Read the VENDORS record from a manifest. Never throws; never writes. */
export function readVendorRecord(manifestPath: string): VendorRecord {
  const empty = classifyVendorEntries([]);
  if (!fs.existsSync(manifestPath)) return { manifestPath, manifestFound: false, ...empty };
  let doc: AdfDocument;
  try {
    doc = parseAdf(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return { manifestPath, manifestFound: true, ...empty, readProblem: 'manifest-unparseable' };
  }
  const idx = lastSectionIndex(doc, VENDORS_SECTION_KEY);
  const content = idx === -1 ? undefined : doc.sections[idx].content;
  if (content && content.type !== 'list' && !(content.type === 'text' && content.value === '')) {
    return { manifestPath, manifestFound: true, ...empty, readProblem: 'section-not-list' };
  }
  // parseManifest reads the last VENDORS section; an empty one means no entries.
  return { manifestPath, manifestFound: true, ...classifyVendorEntries(parseManifest(doc).vendors) };
}

/**
 * Vendor names present at the repo root, grouped by physical file (device and
 * inode, as discoverAgentConfigFiles dedupes). On a case-insensitive filesystem
 * AGENTS.md and agents.md are one group; so are two hard-linked names. Each
 * group is in VENDOR_FILES order, so AGENTS.md comes before agents.md.
 */
export function vendorFileGroups(): VendorFile[][] {
  const groups = new Map<string, VendorFile[]>();
  for (const name of VENDOR_FILES) {
    const full = path.resolve(name);
    if (!fs.existsSync(full)) continue;
    const id = fileIdentity(full);
    groups.set(id, [...(groups.get(id) ?? []), name]);
  }
  return [...groups.values()];
}

/**
 * The spelling under which `file` is (or should be) recorded: a recorded name
 * for the same physical file wins, so one file never gets two entries.
 */
export function recordedSpelling(
  file: VendorFile,
  recorded: ReadonlyMap<VendorFile, unknown>,
  groups: readonly VendorFile[][] = vendorFileGroups(),
): VendorFile {
  if (recorded.has(file)) return file;
  return groups.find(g => g.includes(file))?.find(n => recorded.has(n)) ?? file;
}

/**
 * The mode of the valid VENDORS entry for `file`'s physical file (under any of
 * its spellings), or null when there is none. Never writes.
 */
export function recordedModeOf(aiDir: string, file: VendorFile): VendorMode | null {
  const { recorded } = readVendorRecord(path.join(aiDir, 'manifest.adf'));
  return recorded.get(recordedSpelling(file, recorded))?.mode ?? null;
}

function readVendorFile(file: VendorFile): string | null {
  try {
    return fs.readFileSync(path.resolve(file), 'utf-8');
  } catch {
    return null;
  }
}

function resolveOne(file: VendorFile, record: VendorRecord, exists: boolean): ResolvedVendorMode {
  const evidence = inferVendorMode(file, exists ? readVendorFile(file) : null);
  const recorded = record.recorded.get(file);
  if (recorded) {
    const disagrees = evidence.exists && evidence.inferredMode !== recorded.mode;
    return { file, mode: recorded.mode, source: 'recorded', evidence, disagrees };
  }
  return { file, mode: evidence.inferredMode ?? 'unmanaged', source: 'inferred', evidence, disagrees: false };
}

/**
 * One row per physical file: each on-disk group is shown under its recorded
 * spelling (else its first name), then recorded names with no file on disk,
 * then (with `all`) the remaining absent names. `aliases` lists the extra
 * recorded spellings of a file already shown.
 */
function resolveAll(record: VendorRecord, all: boolean): { files: ResolvedVendorMode[]; aliases: Array<{ file: VendorFile; other: VendorFile }> } {
  const groups = vendorFileGroups();
  const shown = new Map<VendorFile, boolean>();
  const aliases: Array<{ file: VendorFile; other: VendorFile }> = [];
  for (const group of groups) {
    const file = group.find(n => record.recorded.has(n)) ?? group[0];
    shown.set(file, true);
    for (const other of group) if (other !== file && record.recorded.has(other)) aliases.push({ file, other });
  }
  const onDisk = new Set(groups.flat());
  for (const name of VENDOR_FILES) {
    if (!onDisk.has(name) && (all || record.recorded.has(name))) shown.set(name, false);
  }
  const files = VENDOR_FILES.filter(n => shown.has(n)).map(n => resolveOne(n, record, shown.get(n) === true));
  return { files, aliases };
}

/**
 * Resolve every vendor file's mode: the recorded mode when a valid entry exists,
 * else the inferred one. Vendor paths are repo-root (cwd) relative; the record
 * is <aiDir>/manifest.adf. `all` also lists absent, unrecorded names.
 */
export function resolveVendorModes(aiDir: string, options: { all?: boolean } = {}): ResolvedVendorMode[] {
  return resolveAll(readVendorRecord(path.join(aiDir, 'manifest.adf')), options.all === true).files;
}

/** Resolve one vendor file's mode, under the spelling its physical file is shown as. */
export function resolveVendorMode(aiDir: string, file: VendorFile): ResolvedVendorMode {
  const record = readVendorRecord(path.join(aiDir, 'manifest.adf'));
  const { files } = resolveAll(record, true);
  const group = vendorFileGroups().find(g => g.includes(file)) ?? [file];
  return files.find(r => group.includes(r.file)) ?? resolveOne(file, record, false);
}

/**
 * The manifest text with every VENDORS section removed, for consumers that scan
 * the manifest as text (score's path grounding). Sections are found with the
 * parser's header grammar, and the result must re-parse to the same sections
 * minus VENDORS; otherwise, or with no VENDORS section, the text is returned as is.
 */
export function withoutVendorsSection(text: string): string {
  let doc: AdfDocument;
  try {
    doc = parseAdf(text);
  } catch {
    return text;
  }
  if (lastSectionIndex(doc, VENDORS_SECTION_KEY) === -1) return text;
  const lines = text.split('\n');
  const { headers, own } = sectionHeaders(lines, VENDORS_SECTION_KEY);
  const drop = new Set<number>();
  for (const header of own) {
    const next = headers.find(i => i > header) ?? lines.length;
    for (let i = header; i < next; i++) drop.add(i);
  }
  const stripped = lines.filter((_, i) => !drop.has(i)).join('\n');
  try {
    const rest = JSON.stringify(doc.sections.filter(s => s.key !== VENDORS_SECTION_KEY));
    return JSON.stringify(parseAdf(stripped).sections) === rest ? stripped : text;
  } catch {
    return text;
  }
}

// ============================================================================
// Writing the record
// ============================================================================

export interface RecordVendorModesOptions {
  dryRun?: boolean;
  onWarning?: (message: string) => void;
  /** Command named in the already-recorded warning. Omitted: no warning for it. */
  writer?: string;
}

export interface RecordVendorModesResult {
  manifestPath: string;
  /** True iff manifest.adf was rewritten (never under dryRun). */
  written: boolean;
  results: VendorWriteResult[];
}

/**
 * Record vendor modes in manifest.adf. The manifest is parsed only to decide;
 * the edit is text-level (one inserted bullet, a new VENDORS block at EOF, or
 * one replaced bullet line), so every other byte survives. Before writing, the
 * edited text is re-parsed and must equal the old document plus exactly these
 * entries; otherwise nothing is written (skipReason 'reparse-guard').
 */
export function recordVendorModes(
  manifestPath: string,
  entries: ReadonlyArray<{ file: VendorFile; mode: VendorMode }>,
  policy: VendorWritePolicy,
  options: RecordVendorModesOptions = {},
): RecordVendorModesResult {
  const warn = options.onWarning ?? (() => undefined);
  const results: VendorWriteResult[] = [];
  const pending: number[] = [];
  const skip = (file: VendorFile, mode: VendorMode, skipReason: VendorWriteSkipReason): VendorWriteResult =>
    ({ status: 'skipped', file, mode, skipReason });

  // ALLOWED_MODES first, so it is enforced whatever state the manifest is in (INV-7).
  const allowed = entries.filter(e => {
    if (isModeAllowed(e.file, e.mode)) return true;
    warn(fill(MSG.modeNotAllowed, { file: e.file }));
    results.push(skip(e.file, e.mode, 'mode-not-allowed'));
    return false;
  });
  const skipAll = (reason: VendorWriteSkipReason, message: string): RecordVendorModesResult => {
    if (allowed.length > 0) warn(message);
    return { manifestPath, written: false, results: [...results, ...allowed.map(e => skip(e.file, e.mode, reason))] };
  };

  if (!fs.existsSync(manifestPath)) return skipAll('manifest-missing', fill(MSG.manifestMissing, { manifestPath }));
  let text: string;
  let doc: AdfDocument;
  try {
    text = fs.readFileSync(manifestPath, 'utf-8');
    doc = parseAdf(text);
  } catch {
    return skipAll('manifest-unparseable', fill(MSG.manifestUnparseable, { manifestPath }));
  }

  const expected: AdfDocument = JSON.parse(JSON.stringify(doc));
  const groups = vendorFileGroups();
  let next = text;

  for (const entry of allowed) {
    const { mode } = entry;
    const idx = lastSectionIndex(expected, VENDORS_SECTION_KEY);
    const section = idx === -1 ? undefined : expected.sections[idx];
    const emptyText = section?.content.type === 'text' && section.content.value === '';
    if (section && section.content.type !== 'list' && !emptyText) {
      warn(fill(MSG.sectionNotList, { manifestPath, file: entry.file }));
      results.push(skip(entry.file, mode, 'section-not-list'));
      continue;
    }
    const items = section?.content.type === 'list' ? section.content.items : [];
    const { recorded, malformedFor } = classifyVendorEntries(parseManifest(expected).vendors);
    // One physical file, one entry: record under the spelling already recorded for it.
    const file = recordedSpelling(entry.file, recorded, groups);
    if (!isModeAllowed(file, mode)) {
      warn(fill(MSG.modeNotAllowed, { file }));
      results.push(skip(file, mode, 'mode-not-allowed'));
      continue;
    }
    const current = recorded.get(file);
    const bullet = `${file}: ${mode}`;

    if (current?.mode === mode) {
      results.push({ status: 'unchanged', file, mode });
      continue;
    }
    if (current && policy === 'add-if-absent') {
      if (options.writer) warn(fill(MSG.alreadyRecorded, { file, recorded: current.mode, writer: options.writer, mode }));
      results.push(skip(file, mode, 'already-recorded'));
      continue;
    }
    if (!current && malformedFor.has(file)) {
      warn(fill(MSG.entryMalformedWrite, { manifestPath, file, raw: malformedFor.get(file) ?? '' }));
      results.push(skip(file, mode, 'entry-malformed'));
      continue;
    }

    if (current) {
      const replaced = replaceManifestBullet(next, VENDORS_SECTION_KEY, current.index, bullet);
      if (replaced === null) {
        warn(fill(MSG.reparseGuard, { manifestPath, file }));
        results.push(skip(file, mode, 'reparse-guard'));
        continue;
      }
      next = replaced;
      items[current.index] = bullet;
      pending.push(results.length);
      results.push(options.dryRun
        ? { status: 'planned', file, mode, previous: current.mode }
        : { status: 'updated', file, mode, previous: current.mode });
      continue;
    }

    next = insertManifestBullet(next, VENDORS_SECTION_KEY, bullet, VENDORS_DECORATION);
    if (!section) {
      expected.sections.push({ key: VENDORS_SECTION_KEY, decoration: VENDORS_DECORATION, content: { type: 'list', items: [bullet] } });
    } else if (section.content.type === 'list') {
      section.content.items.push(bullet);
    } else {
      section.content = { type: 'list', items: [bullet] };
    }
    pending.push(results.length);
    results.push(options.dryRun ? { status: 'planned', file, mode, previous: null } : { status: 'added', file, mode });
  }

  if (pending.length === 0) return { manifestPath, written: false, results };

  // Guard: the edit must change nothing but these entries (INV-2).
  let safe = false;
  try {
    safe = JSON.stringify(parseAdf(next)) === JSON.stringify(expected);
  } catch {
    safe = false;
  }
  if (!safe) {
    for (const i of pending) {
      const r = results[i];
      warn(fill(MSG.reparseGuard, { manifestPath, file: r.file }));
      results[i] = skip(r.file, r.mode, 'reparse-guard');
    }
    return { manifestPath, written: false, results };
  }

  const written = !options.dryRun;
  if (written) fs.writeFileSync(manifestPath, next);
  return { manifestPath, written, results };
}

/**
 * Implicit writers (bootstrap, adf init --emit-pointers, adf migrate, adf compile
 * --write): record `mode` add-if-absent for the vendor files just written.
 * Paths that are not a repo-root vendor name are ignored. Never throws and never
 * affects the caller's exit code; problems reach `onWarning` only (INV-8, INV-9).
 */
export function recordWrittenVendorModes(
  aiDir: string,
  written: readonly string[],
  mode: VendorMode,
  writer: string,
  onWarning: (message: string) => void,
): void {
  const entries: Array<{ file: VendorFile; mode: VendorMode }> = [];
  for (const p of written) {
    const name = path.relative(process.cwd(), path.resolve(p)).split(path.sep).join('/');
    if (isVendorFile(name) && !entries.some(e => e.file === name)) entries.push({ file: name, mode });
  }
  if (entries.length === 0) return;
  try {
    recordVendorModes(path.join(aiDir, 'manifest.adf'), entries, 'add-if-absent', { writer, onWarning });
  } catch (err: unknown) {
    onWarning(`Vendor modes were not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================================
// Command
// ============================================================================

const VALUE_FLAGS = new Set(['--ai-dir', '--format', '--config']);

function positionals(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) {
      i++;
      continue;
    }
    if (!args[i].startsWith('--')) out.push(args[i]);
  }
  return out;
}

export function adfVendorCommand(options: CLIOptions, args: string[]): number {
  const [sub, ...rest] = positionals(args);
  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const manifestPath = path.join(aiDir, 'manifest.adf');
  const dryRun = args.includes('--dry-run');
  switch (sub) {
    case 'status':
      return vendorStatus(options, manifestPath, args.includes('--all'));
    case 'set':
      return vendorSet(options, manifestPath, rest, dryRun);
    case 'init':
      return vendorInit(options, manifestPath, dryRun);
    case 'restore':
      return vendorRestore(options, aiDir, rest, dryRun);
    default:
      throw new CLIError(
        `${sub ? `Unknown adf vendor subcommand: ${sub}. ` : ''}Usage: charter adf vendor <status|set|init|restore> [--ai-dir <dir>] [--format json]`,
      );
  }
}

const INFERRED_REASON: Record<VendorMode, string> = {
  compiled: 'compile banner',
  pointer: 'pointer marker',
  unmanaged: 'no charter markers',
};

function sourceNote(r: ResolvedVendorMode): string {
  if (r.source === 'inferred') {
    return `inferred: ${r.evidence.inferredMode ? INFERRED_REASON[r.evidence.inferredMode] : 'file absent'}`;
  }
  if (!r.evidence.exists) return 'recorded; file absent';
  return r.disagrees ? `recorded; file looks ${r.evidence.inferredMode}` : 'recorded';
}

function vendorStatus(options: CLIOptions, manifestPath: string, all: boolean): number {
  const record = readVendorRecord(manifestPath);
  const { files, aliases } = resolveAll(record, all);
  const unrecorded = files.filter(f => f.source === 'inferred' && f.evidence.exists).map(f => f.file);
  const entryProblems = record.problems.map(p => ({ raw: p.raw, problem: p.problem }));

  const warnings: string[] = [];
  if (!record.manifestFound) warnings.push(fill(MSG.manifestMissingStatus, { manifestPath }));
  if (record.readProblem === 'manifest-unparseable') warnings.push(fill(MSG.manifestUnparseableStatus, { manifestPath }));
  if (record.readProblem === 'section-not-list') warnings.push(fill(MSG.sectionNotListStatus, { manifestPath }));
  for (const p of record.problems) {
    const template = p.problem === 'duplicate' ? MSG.entryDuplicate : p.file ? MSG.entryProblem : MSG.entryProblemNoFile;
    warnings.push(fill(template, { raw: p.raw, manifestPath, problem: p.problem, file: p.file ?? '' }));
  }
  for (const a of aliases) warnings.push(fill(MSG.aliasRecorded, { manifestPath, file: a.file, other: a.other }));

  const nextActions: string[] = [];
  if (!record.manifestFound) nextActions.push('charter adf init');
  else if (unrecorded.length > 0 && !record.readProblem) nextActions.push('charter adf vendor init');

  if (options.format === 'json') {
    for (const w of warnings) console.warn(`Warning: ${w}`);
    console.log(JSON.stringify({ manifestPath, manifestFound: record.manifestFound, files, entryProblems, unrecorded, nextActions }, null, 2));
    return EXIT_CODE.SUCCESS;
  }

  console.log(`  Vendor file modes (${manifestPath}):`);
  if (files.length === 0) console.log('  No vendor files found.');
  for (const r of files) console.log(`  ${r.file}  ${r.mode}  (${sourceNote(r)})`);
  for (const w of warnings) console.log(`  Warning: ${w}`);
  if (unrecorded.length > 0 && record.manifestFound && !record.readProblem) {
    console.log(`  ${unrecorded.length} file(s) have no recorded mode. Record the inferred modes with: charter adf vendor init`);
  }
  return EXIT_CODE.SUCCESS;
}

function vendorSet(options: CLIOptions, manifestPath: string, rest: string[], dryRun: boolean): number {
  if (rest.length !== 2) throw new CLIError(MSG.usageSet);
  const [file, mode] = rest;
  if (!isVendorFile(file)) throw new CLIError(fill(MSG.unknownFile, { file }));
  if (!isVendorMode(mode)) throw new CLIError(fill(MSG.unknownMode, { mode }));

  const json = options.format === 'json';
  const warnings: string[] = [];
  const outcome = recordVendorModes(manifestPath, [{ file, mode }], 'upsert', { dryRun, onWarning: w => warnings.push(w) });
  const result = outcome.results[0];

  if (result.status === 'skipped' && result.skipReason === 'manifest-missing') {
    throw new CLIError(fill(MSG.manifestMissing, { manifestPath }));
  }
  if (json) {
    for (const w of warnings) console.warn(`Warning: ${w}`);
    console.log(JSON.stringify({ manifestPath, written: outcome.written, result }, null, 2));
  } else {
    for (const w of warnings) console.error(`  Warning: ${w}`);
    const target = result.file;
    if (target !== file) console.log(`  ${fill(MSG.sameFile, { file, recorded: target })}`);
    if (result.status !== 'skipped' && !fs.existsSync(path.resolve(target))) {
      console.log(`  ${fill(MSG.fileAbsentSet, { file: target, mode })}`);
    }
    if (result.status === 'unchanged') console.log(fill(MSG.setUnchanged, { file: target, mode }));
    if (result.status === 'updated') console.log(fill(MSG.setOk, { file: target, previous: result.previous, mode }));
    if (result.status === 'added') console.log(fill(MSG.setOk, { file: target, previous: 'unrecorded', mode }));
    if (result.status === 'planned') {
      console.log(`  [dry-run] Would record ${target}: ${result.previous ?? 'unrecorded'} -> ${mode} in ${manifestPath}`);
    }
  }
  return result.status === 'skipped' ? EXIT_CODE.POLICY_VIOLATION : EXIT_CODE.SUCCESS;
}

function vendorInit(options: CLIOptions, manifestPath: string, dryRun: boolean): number {
  const json = options.format === 'json';
  if (!fs.existsSync(manifestPath)) throw new CLIError(fill(MSG.manifestMissing, { manifestPath }));

  const record = readVendorRecord(manifestPath);
  const warnings: string[] = [];
  const entries: Array<{ file: VendorFile; mode: VendorMode }> = [];
  const absent: VendorWriteResult[] = [];
  // One entry per physical file, under its recorded spelling (else its first name).
  for (const r of resolveAll(record, false).files) {
    if (r.evidence.inferredMode) {
      entries.push({ file: r.file, mode: r.evidence.inferredMode });
    } else if (r.source === 'recorded') {
      absent.push({ status: 'skipped', file: r.file, mode: r.mode, skipReason: 'file-absent' });
    }
  }

  const outcome = recordVendorModes(manifestPath, entries, 'add-if-absent', { dryRun, onWarning: w => warnings.push(w) });
  for (const r of outcome.results) {
    if (r.status === 'skipped' && r.skipReason === 'already-recorded') {
      warnings.push(fill(MSG.initDisagrees, { file: r.file, recorded: record.recorded.get(r.file)?.mode ?? '', mode: r.mode }));
    }
  }
  const results = [...outcome.results, ...absent];

  if (json) {
    for (const w of warnings) console.warn(`Warning: ${w}`);
    console.log(JSON.stringify({ manifestPath, written: outcome.written, results }, null, 2));
  } else {
    for (const w of warnings) console.log(`  Warning: ${w}`);
    const recorded = results.filter(r => r.status === 'added' || r.status === 'planned');
    for (const r of recorded) console.log(`  ${dryRun ? '[dry-run] Would record' : 'Recorded'} ${r.file}: ${r.mode}`);
    if (dryRun) {
      if (recorded.length === 0) console.log(MSG.initNothing);
    } else {
      console.log(recorded.length > 0 ? fill(MSG.initOk, { n: recorded.length, manifestPath }) : MSG.initNothing);
    }
  }

  const failed = results.some(r => r.status === 'skipped' && r.skipReason !== 'already-recorded' && r.skipReason !== 'file-absent');
  return failed ? EXIT_CODE.POLICY_VIOLATION : EXIT_CODE.SUCCESS;
}

// ============================================================================
// adf vendor restore (#318)
// ============================================================================

export type RestoreRefusal =
  | 'mode-not-pointer'
  | 'hand-authored'
  | 'pointer-bloated'
  | 'compiled-differs'
  | 'record-write'
  | 'write-failed';

export interface RestoreResult {
  file: VendorFile;
  status: 'restored' | 'planned' | 'unchanged' | 'refused';
  refusal: RestoreRefusal | null;
  /** Retained headings carrying the user's own content, carried over verbatim. */
  keptSections: string[];
  remedy: string | null;
  /** Set iff refusal is write-failed: the file write itself failed (as compile --write's writeError). */
  writeError: string | null;
}

/** The template each vendor name is restored to (CLAUDE.md: the hybrid one bootstrap writes). */
function restoreTemplate(file: VendorFile): string {
  switch (file) {
    case 'CLAUDE.md': return POINTER_CLAUDE_MD_HYBRID;
    case 'AGENTS.md':
    case 'agents.md': return POINTER_AGENTS_MD;
    case '.cursorrules': return POINTER_CURSORRULES;
    case 'GEMINI.md': return POINTER_GEMINI_MD;
    default: return POINTER_COPILOT_MD;
  }
}

/** A retained-sections block without its `## Module Index` section (the template carries its own). */
function withoutModuleIndexSection(block: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of block.split('\n')) {
    if (line.trim().startsWith('## ')) skipping = line.trim() === '## Module Index';
    if (!skipping) out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  while (out.length > 0 && out[0].trim() === '') out.shift();
  return out.length > 0 ? `\n\n${out.join('\n')}\n` : '';
}

/**
 * The pointer `restore` writes: the template, with the current file's retained
 * sections re-appended verbatim (as tidy's restorePointer does) and, for
 * CLAUDE.md, the module index filled in (as bootstrap's updateModuleIndex does).
 * A clean bootstrap pointer therefore comes back byte-equal. Pure: never writes.
 * `carried` is a compiled file's retained text (composeCompiled's body), appended
 * as plain sections in place of reading `current` (#303).
 */
export function restoredPointer(file: VendorFile, current: string | null, aiDir: string, carried = ''): string {
  let pointer = restoreTemplate(file);
  const hasIndex = pointer.includes(MODULE_INDEX_START);
  let retained = carried ? `\n\n${carried}\n` : current === null ? '' : readRetainedSections(current);
  if (hasIndex) retained = withoutModuleIndexSection(retained);
  if (retained) pointer = pointer.replace(/\n## Environment[\s\S]*$/, '').trimEnd() + retained;
  const index = hasIndex ? generateModuleIndex(aiDir) : '';
  return index
    ? pointer.replace(`${MODULE_INDEX_START}\n${MODULE_INDEX_END}`, `${MODULE_INDEX_START}\n${index}${MODULE_INDEX_END}`)
    : pointer;
}

/**
 * Lines of earlier Charter pointer templates (before #25 strengthened the
 * wording, and the old lowercase agents.md title), plus the generic pointers
 * `adf migrate` and `adf tidy` write for a name with no template. A pointer
 * made of these lines holds nothing of the user's, so restore may drop them.
 */
const LEGACY_POINTER_LINES = [
  '# Project Context',
  '> This project uses [ADF](https://github.com/Stackbilt-dev/charter) for AI agent context management.',
  '> All stack rules, constraints, and architectural guidance live in `.ai/`.',
  '> **Do not duplicate ADF rules here.** Only pre-ADF bootstrap content belongs in this file.',
  '> **Do not duplicate ADF rules here.**',
  'See `.ai/manifest.adf` for the module routing manifest.',
  '# Cursor Rules',
  'All rules and constraints are in .ai/ — see .ai/manifest.adf for routing.',
  'Do not add stack rules here. This file exists only as a pointer.',
  'See: .ai/core.adf for universal constraints.',
  '# Agent Guidelines',
  'All architectural rules, constraints, and guidance live in `.ai/`.',
  'Module manifest: .ai/manifest.adf',
  'Universal rules: .ai/core.adf',
  'Current state: .ai/state.adf',
  'Do not duplicate rules from .ai/ modules into this file or other agent config files.',
  '> All project rules are managed in `.ai/` by Charter.',
];

/** Every line some Charter pointer template has ever held (trimmed, non-blank). */
function charterTemplateLines(): Set<string> {
  const templates = [
    POINTER_CLAUDE_MD, POINTER_CLAUDE_MD_HYBRID, POINTER_AGENTS_MD, POINTER_CURSORRULES, POINTER_GEMINI_MD, POINTER_COPILOT_MD,
    ...LEGACY_POINTER_LINES, ...VENDOR_FILES.map(name => `# ${name}`),
  ];
  return new Set(templates.flatMap(t => t.split('\n')).map(l => l.trim()).filter(Boolean));
}

/** The generated module index (between its markers, inclusive) is Charter's, not the user's. */
function withoutModuleIndexBlock(content: string): string[] {
  const out: string[] = [];
  let inIndex = false;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t === MODULE_INDEX_START) inIndex = true;
    if (!inIndex) out.push(t);
    if (t === MODULE_INDEX_END) inIndex = false;
  }
  return out;
}

/**
 * The non-blank lines of `current` that `next` would not keep: not in `next`,
 * not from any Charter pointer template, and not the generated module index.
 */
export function linesRestoreWouldDrop(current: string, next: string): string[] {
  const kept = new Set(next.split('\n').map(l => l.trim()));
  const template = charterTemplateLines();
  return withoutModuleIndexBlock(current.replace(/\r\n/g, '\n')).filter(l => l && !kept.has(l) && !template.has(l));
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

export interface RestoreOptions {
  dryRun?: boolean;
  /** Receives each result line; isWarning marks a refusal or failure. */
  print?: (line: string, isWarning: boolean) => void;
  onWarning?: (message: string) => void;
}

/**
 * Rewrite one vendor file as its pointer template, refusing whenever content
 * would be lost (INV-P3-9). Allowed iff the resolved mode is pointer, or the
 * file is absent with no valid entry. A file with no valid entry gets `pointer`
 * recorded (add-if-absent, through recordVendorModes) BEFORE the file is
 * written: a skipped record means no file write, and a failed file write puts
 * the manifest's previous bytes back.
 */
export function restoreVendorFile(aiDir: string, file: VendorFile, options: RestoreOptions = {}): RestoreResult {
  const print = options.print ?? (() => undefined);
  const manifestPath = path.join(aiDir, 'manifest.adf');
  const r = resolveVendorMode(aiDir, file);
  const ev = r.evidence;
  const current = ev.exists ? readText(path.resolve(file)) : null;
  const handAuthored = ev.inferredMode === 'unmanaged' && (current ?? '').trim() !== '';
  const refuse = (refusal: RestoreRefusal, remedy: string | null, line: string): RestoreResult => {
    print(line, true);
    return { file, status: 'refused', refusal, keptSections: [], remedy, writeError: null };
  };
  const migrateRemedy = `charter adf migrate --source ${file}`;

  if (r.mode !== 'pointer' && !(!ev.exists && r.source === 'inferred')) {
    if (r.source === 'inferred' && handAuthored) return refuse('hand-authored', migrateRemedy, fill(MSG.restoreHandAuthored, { file }));
    return refuse('mode-not-pointer', `charter adf vendor set ${file} pointer`,
      fill(MSG.restoreModeNotPointer, { file, mode: r.mode, source: r.source }));
  }
  if (handAuthored) return refuse('hand-authored', migrateRemedy, fill(MSG.restoreHandAuthored, { file }));
  if (ev.inferredMode === 'pointer') {
    const n = countExtractable(file, aiDir);
    if (n > 0) return refuse('pointer-bloated', `charter adf tidy --source ${file}`, fill(MSG.restoreBloated, { file, n }));
  }
  let carried = '';
  let carriedSections: string[] = [];
  if (ev.inferredMode === 'compiled' && current !== null) {
    // Compiled output that .ai/ no longer reproduces holds something .ai/ does not
    // (a hand edit, or rules since removed from .ai/). Compiled in memory; nothing is written.
    // Its retained block (or retained sections outside one) is the user's: it is
    // carried into the pointer, so it never counts as a difference (#303).
    const target = (Object.keys(TARGET_FILENAMES) as CompileTarget[]).find(t => TARGET_FILENAMES[t] === file);
    let fresh: string | null = null;
    try {
      fresh = target ? compileAdf({ target, aiDir, readFile: (f: string) => fs.readFileSync(f, 'utf-8') }).output : null;
    } catch {
      fresh = null;
    }
    if (fresh === null || !compiledMatchesFresh(fresh, current, file)) {
      return refuse('compiled-differs', `charter adf vendor set ${file} compiled`,
        fill(MSG.restoreCompiledDiffers, { file, target: target ?? 'all' }));
    }
    const composed = composeCompiled(fresh, current, file);
    carried = composed.body;
    carriedSections = composed.retainedSections;
  }

  // A pointer's retained sections that differ from its template are the user's;
  // a compiled file's are the ones composeCompiled carries. The template brings
  // its own Module Index, so that heading is never "kept".
  const keptSections = ev.inferredMode === 'pointer' && current !== null
    ? divergentRetainedHeadings(current, file).filter(h => h !== '## Module Index')
    : carriedSections;
  const kept = keptSections.length > 0 ? ` (kept ${keptSections.join(', ')})` : '';
  const next = restoredPointer(file, ev.inferredMode === 'pointer' ? current : null, aiDir, carried);
  // Any line of the user's that the new pointer would not carry is a loss: refuse.
  if (ev.inferredMode === 'pointer' && current !== null) {
    const lost = linesRestoreWouldDrop(current, next);
    if (lost.length > 0) {
      const shown = lost.slice(0, 3).map(l => `'${l}'`).join(', ') + (lost.length > 3 ? `, and ${lost.length - 3} more` : '');
      return refuse('hand-authored', null, fill(MSG.restoreLost, { file, n: lost.length, lines: shown }));
    }
  }
  if (next === current) {
    print(fill(MSG.restoreUnchanged, { file }), false);
    return { file, status: 'unchanged', refusal: null, keptSections, remedy: null, writeError: null };
  }
  if (options.dryRun) {
    print(fill(MSG.restorePlanned, { file, kept }), false);
    return { file, status: 'planned', refusal: null, keptSections, remedy: null, writeError: null };
  }

  // Record before write (PR2 pattern). A recorded pointer needs no record write.
  const before = readText(manifestPath);
  let after: string | null = null;
  if (r.source === 'inferred') {
    let recorded = false;
    try {
      const outcome = recordVendorModes(manifestPath, [{ file, mode: 'pointer' }], 'add-if-absent', { onWarning: options.onWarning });
      recorded = outcome.results.every(x => x.status !== 'skipped');
      if (outcome.written) after = readText(manifestPath);
    } catch (err: unknown) {
      options.onWarning?.(`Vendor modes were not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!recorded) return refuse('record-write', 'charter adf vendor status', fill(MSG.restoreRecord, { file, manifestPath }));
  }
  try {
    fs.writeFileSync(path.resolve(file), next);
  } catch (err: unknown) {
    // Revert the entry just added by putting the manifest's previous bytes back,
    // only if nothing else has touched it since.
    let note = '';
    if (after !== null && before !== null) {
      let reverted = false;
      try {
        if (readText(manifestPath) === after) {
          fs.writeFileSync(manifestPath, before);
          reverted = true;
        }
      } catch {
        reverted = false;
      }
      note = reverted ? MSG.restoreReverted : MSG.restoreNotReverted;
    }
    const error = err instanceof Error ? err.message : String(err);
    return { ...refuse('write-failed', `charter adf vendor restore ${file}`, fill(MSG.restoreWriteFailed, { file, error, note })), writeError: error };
  }
  print(fill(MSG.restoreOk, { file, kept }), false);
  return { file, status: 'restored', refusal: null, keptSections, remedy: null, writeError: null };
}

function vendorRestore(options: CLIOptions, aiDir: string, rest: string[], dryRun: boolean): number {
  if (rest.length !== 1) throw new CLIError(MSG.usageRestore);
  const [file] = rest;
  if (!isVendorFile(file)) throw new CLIError(fill(MSG.unknownFile, { file }));
  const json = options.format === 'json';
  const warnings: string[] = [];
  const result = restoreVendorFile(aiDir, file, {
    dryRun,
    onWarning: w => warnings.push(w),
    // JSON stdout stays one document: text lines go to stderr there.
    print: (line, isWarning) => (json || isWarning ? console.error(line) : console.log(line)),
  });
  for (const w of warnings) console.error(json ? `Warning: ${w}` : `  Warning: ${w}`);
  if (json) console.log(JSON.stringify(result, null, 2));
  return result.status === 'refused' ? EXIT_CODE.POLICY_VIOLATION : EXIT_CODE.SUCCESS;
}

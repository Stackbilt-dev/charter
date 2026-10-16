/**
 * charter adf vendor (#318)
 *
 * Records whether each vendor agent-config file (CLAUDE.md, AGENTS.md, ...) is a
 * thin `pointer` to .ai/, `compiled` output of `charter adf compile`, or
 * `unmanaged`. The record is a VENDORS list in <aiDir>/manifest.adf:
 *
 *   🏷️ VENDORS:
 *     - CLAUDE.md: pointer
 *     - AGENTS.md: compiled
 *
 * The record is intent; the markers in the file are evidence. With no valid
 * entry, a file's mode is inferred from its markers exactly as `adf tidy` sniffs
 * them today. No command acts on the record yet: this module only reads and
 * writes it (`adf vendor status|set|init`, plus the implicit writers that record
 * the mode of a vendor file they just wrote).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAdf, parseManifest, COMPILE_BANNER_MARKER } from '@stackbilt/adf';
import type { AdfDocument, ManifestVendorEntry } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { POINTER_MARKERS } from './adf';
import { discoverAgentConfigFiles } from './adf-migrate';
import { insertManifestBullet, lastSectionIndex, replaceManifestBullet } from './adf-manifest-register';

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
export const VENDORS_DECORATION = '\u{1F3F7}\u{FE0F}';

export const MSG = {
  unknownFile: "Unknown vendor file '{file}'. Expected one of: CLAUDE.md, AGENTS.md, .cursorrules, GEMINI.md, agents.md, copilot-instructions.md",
  unknownMode: "Unknown mode '{mode}'. Expected one of: pointer, compiled, unmanaged",
  modeNotAllowed: "{file} cannot be 'compiled': no compile target writes it. Allowed: pointer, unmanaged",
  usageSet: 'Usage: charter adf vendor set <file> <pointer|compiled|unmanaged> [--dry-run]',
  manifestMissing: '{manifestPath} not found; vendor modes cannot be recorded. Run: charter adf init',
  manifestMissingStatus: '{manifestPath} not found; showing inferred modes only.',
  manifestUnparseable: '{manifestPath} could not be parsed; vendor modes were not recorded. Fix the manifest or run: charter doctor',
  manifestUnparseableStatus: '{manifestPath} could not be parsed; showing inferred modes only. Fix the manifest or run: charter doctor',
  sectionNotList: 'VENDORS in {manifestPath} is not a list; {file} was not recorded. Expected lines like: "  - CLAUDE.md: pointer"',
  sectionNotListStatus: 'VENDORS in {manifestPath} is not a list; showing inferred modes only. Expected lines like: "  - CLAUDE.md: pointer"',
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
  // parseManifest reads the last VENDORS list; an empty last header means no entries.
  const vendors = content?.type === 'list' ? parseManifest(doc).vendors : [];
  return { manifestPath, manifestFound: true, ...classifyVendorEntries(vendors) };
}

function readVendorFile(file: VendorFile, onDisk: ReadonlySet<string>): string | null {
  if (!onDisk.has(file)) return null;
  try {
    return fs.readFileSync(path.resolve(file), 'utf-8');
  } catch {
    return null;
  }
}

/** The vendor names present at the repo root, deduped by inode (AGENTS.md wins over agents.md). */
export function vendorFilesOnDisk(): Set<VendorFile> {
  return new Set(discoverAgentConfigFiles().filter(isVendorFile));
}

function resolveOne(file: VendorFile, record: VendorRecord, onDisk: ReadonlySet<string>): ResolvedVendorMode {
  const evidence = inferVendorMode(file, readVendorFile(file, onDisk));
  const recorded = record.recorded.get(file);
  if (recorded) {
    const disagrees = evidence.exists && evidence.inferredMode !== recorded.mode;
    return { file, mode: recorded.mode, source: 'recorded', evidence, disagrees };
  }
  return { file, mode: evidence.inferredMode ?? 'unmanaged', source: 'inferred', evidence, disagrees: false };
}

/**
 * Resolve every vendor file's mode: the recorded mode when a valid entry exists,
 * else the inferred one. Vendor paths are repo-root (cwd) relative; the record
 * is <aiDir>/manifest.adf. `all` also lists absent, unrecorded names.
 */
export function resolveVendorModes(aiDir: string, options: { all?: boolean } = {}): ResolvedVendorMode[] {
  const record = readVendorRecord(path.join(aiDir, 'manifest.adf'));
  const onDisk = vendorFilesOnDisk();
  return VENDOR_FILES
    .filter(file => options.all || onDisk.has(file) || record.recorded.has(file))
    .map(file => resolveOne(file, record, onDisk));
}

/** Resolve one vendor file's mode (see resolveVendorModes). */
export function resolveVendorMode(aiDir: string, file: VendorFile): ResolvedVendorMode {
  return resolveOne(file, readVendorRecord(path.join(aiDir, 'manifest.adf')), vendorFilesOnDisk());
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
  let next = text;

  for (const { file, mode } of allowed) {
    const idx = lastSectionIndex(expected, VENDORS_SECTION_KEY);
    const section = idx === -1 ? undefined : expected.sections[idx];
    const emptyText = section?.content.type === 'text' && section.content.value === '';
    if (section && section.content.type !== 'list' && !emptyText) {
      warn(fill(MSG.sectionNotList, { manifestPath, file }));
      results.push(skip(file, mode, 'section-not-list'));
      continue;
    }
    const items = section?.content.type === 'list' ? section.content.items : [];
    const { recorded, malformedFor } = classifyVendorEntries(items.length > 0 ? parseManifest(expected).vendors : []);
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
      // parseAdf keeps the base emoji and drops the variation selector.
      expected.sections.push({ key: VENDORS_SECTION_KEY, decoration: '\u{1F3F7}', content: { type: 'list', items: [bullet] } });
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
    default:
      throw new CLIError(
        `${sub ? `Unknown adf vendor subcommand: ${sub}. ` : ''}Usage: charter adf vendor <status|set|init> [--ai-dir <dir>] [--format json]`,
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
  const onDisk = vendorFilesOnDisk();
  const files = VENDOR_FILES
    .filter(file => all || onDisk.has(file) || record.recorded.has(file))
    .map(file => resolveOne(file, record, onDisk));
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
    if (result.status !== 'skipped' && !vendorFilesOnDisk().has(file)) {
      console.log(`  ${fill(MSG.fileAbsentSet, { file, mode })}`);
    }
    if (result.status === 'unchanged') console.log(fill(MSG.setUnchanged, { file, mode }));
    if (result.status === 'updated') console.log(fill(MSG.setOk, { file, previous: result.previous, mode }));
    if (result.status === 'added') console.log(fill(MSG.setOk, { file, previous: 'unrecorded', mode }));
    if (result.status === 'planned') {
      console.log(`  [dry-run] Would record ${file}: ${result.previous ?? 'unrecorded'} -> ${mode} in ${manifestPath}`);
    }
  }
  return result.status === 'skipped' ? EXIT_CODE.POLICY_VIOLATION : EXIT_CODE.SUCCESS;
}

function vendorInit(options: CLIOptions, manifestPath: string, dryRun: boolean): number {
  const json = options.format === 'json';
  if (!fs.existsSync(manifestPath)) throw new CLIError(fill(MSG.manifestMissing, { manifestPath }));

  const record = readVendorRecord(manifestPath);
  const onDisk = vendorFilesOnDisk();
  const warnings: string[] = [];
  const entries: Array<{ file: VendorFile; mode: VendorMode }> = [];
  const absent: VendorWriteResult[] = [];
  for (const file of VENDOR_FILES) {
    const evidence = inferVendorMode(file, readVendorFile(file, onDisk));
    if (evidence.inferredMode) {
      entries.push({ file, mode: evidence.inferredMode });
    } else {
      const recorded = record.recorded.get(file);
      if (recorded) absent.push({ status: 'skipped', file, mode: recorded.mode, skipReason: 'file-absent' });
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

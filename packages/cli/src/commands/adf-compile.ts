/**
 * charter adf compile
 *
 * Outbound compiler: renders the modular .ai/*.adf source tree to flat vendor
 * agent-config files (CLAUDE.md, AGENTS.md, .cursorrules, GEMINI.md).
 *
 * "Babel for agent configs" — ADF is the source of truth, vendor files are build
 * artifacts. This is the reverse of `charter adf migrate`.
 *
 * Usage:
 *   charter adf compile --target <claude|agents|cursor|gemini>
 *   charter adf compile --target all --write [--mode compiled]
 *   charter adf compile --target claude --check
 *
 * Each target's mode comes from the VENDORS record in manifest.adf, else from its
 * markers (#318). --write compiles only targets in compiled mode (or absent);
 * converting a pointer or unmanaged file needs --mode compiled, which records the
 * switch first. --check verifies each target by its mode.
 *
 * Compiled output keeps the user's retained sections (## Environment and the other
 * headings adf tidy retains) in a block at the end of the file (#303); see
 * adf-retained.ts. --write, --check and vendor restore all compose through it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  compileAdf,
  COMPILE_TARGETS,
  TARGET_FILENAMES,
  stripCharterSentinels,
} from '@stackbilt/adf';
import type { CompileTarget } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import {
  CHARTER_OWNED_MARKERS,
  POINTER_CLAUDE_MD,
  POINTER_CLAUDE_MD_HYBRID,
  POINTER_AGENTS_MD,
  POINTER_CURSORRULES,
  POINTER_GEMINI_MD,
} from './adf';
import { countExtractable, readRetainedSections } from './adf-tidy';
import { inferVendorMode, readVendorRecord, recordedSpelling, recordVendorModes, resolveVendorMode } from './adf-vendor';
import type { ModeSource, VendorFile, VendorMode } from './adf-vendor';
import { composeCompiled, linesConvertWouldDrop, readAiModuleLines, RETAINED_MSG } from './adf-retained';
import type { RetainedSource } from './adf-retained';

// ============================================================================
// Zod validation — at the CLI boundary per Zod-core-out architecture
// ============================================================================

const CompileTargetOrAllSchema = z.enum(['claude', 'agents', 'cursor', 'gemini', 'all']);
type CompileTargetOrAll = z.infer<typeof CompileTargetOrAllSchema>;

export const COMPILE_MODE_FLAG_ERRORS = {
  notWithWrite: '--mode requires --write.',
  badValue: "--mode accepts only 'compiled'. To make a file a pointer: charter adf vendor set <file> pointer",
} as const;

export const MSG = {
  skippedMode: '  [skip] {file} is {mode} ({source}); not compiled. To switch it to compiled output: charter adf compile --target {target} --write --mode compiled{force}',
  refusedModeChange: '  [warn] Refused to compile {file}: it is {mode} ({source}), and writing compiled output would change its mode.\n         Run: charter adf compile --target {target} --write --mode compiled{force}',
  refusedRecord: '  [warn] Refused to compile {file}: its mode could not be recorded as compiled in {manifestPath}. Nothing was written. Fix the manifest or run: charter adf vendor status',
  writeFailed: '  [warn] Could not write {file}: {error}.{note}',
  writeFailedReverted: ' Its mode record was restored to {previous}.',
  writeFailedNotReverted: ' Its mode record still says compiled; restore it with: charter adf vendor set {file} {previous}',
  writtenSwitched: '  [ok] Written {file} (mode: {previous} -> compiled)',
  writtenOk: '  [ok] Written {file}',
  writtenKept: '  [ok] Written {file} (kept {headings})',
  writtenSwitchedKept: '  [ok] Written {file} (mode: {previous} -> compiled; kept {headings})',
  refusedBloated: '  [warn] Refused to compile {file}: it carries {n} item(s) beyond the pointer that .ai/ does not hold yet.\n         Move them into .ai/ first: charter adf tidy --source {file}\n         Or discard them: charter adf compile --target {target} --write --mode compiled --force  (discards {n} item(s))',
  refusedWouldDrop: "  [warn] Refused to compile {file}: {n} line(s) of yours would be lost ({lines}).\n         Move them under ## Environment or into a .ai/ module, or discard them: charter adf compile --target {target} --write --mode compiled --force  (discards {n} line(s))",
  collision: '{file}: your retained section {heading} has the same heading as a compiled section; both are kept.',
  checkStaleUnfenced: '  [stale] {file} — your {headings} section(s) sit outside the retained block.\n          Run: charter adf compile --target {target} --write  (keeps them)',
  nothingCompiled: '  No target is in compiled mode, so nothing was written. Pointer files stay pointers.\n  To switch them: charter adf compile --target all --write --mode compiled. To see modes: charter adf vendor status',
  checkFresh: '  [ok] {file} is up-to-date',
  checkPointerOk: '  [ok] {file} is a thin pointer to {aiDir}/ ({source})',
  checkSkippedUnmanaged: '  [skip] {file} is unmanaged ({source}); not checked',
  checkStale: '  [stale] {file} — out of date with {aiDir}/ source.\n          Run: charter adf compile --target {target} --write',
  checkMissingCompiled: '  [missing] {file} — not found on disk.\n          Run: charter adf compile --target {target} --write',
  checkMissingPointer: '  [missing] {file} — recorded as a pointer but not found on disk.\n          Restore it (charter adf vendor restore {file}), or stop tracking it: charter adf vendor set {file} unmanaged',
  checkPointerBloated: '  [bloated] {file} — thin pointer carries {n} item(s) that belong in {aiDir}/.\n          Run: charter adf tidy --source {file}',
  checkModeDrift: '  [drift] {file} — recorded as {recorded} but looks {inferred} on disk.\n          Keep the file as it is: {keep}\n          Or make it match the record: {restore}',
} as const;

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

/** A target's state before this run: its recorded mode, else its inferred one, else absent. */
export type CompileTargetState = VendorMode | 'absent-unrecorded';

interface TargetState {
  state: CompileTargetState;
  source: ModeSource | null;
  exists: boolean;
  disagrees: boolean;
  inferredMode: VendorMode | null;
}

/**
 * Derive a target's state (COMPILE_STATE_RULES). The resolver's 'unmanaged'
 * fallback for an absent, unrecorded file is NOT reused: compile must still
 * write a fresh target in a repo that has no vendor files yet.
 */
function targetState(aiDir: string, filename: string): TargetState {
  const r = resolveVendorMode(aiDir, filename as VendorFile);
  const { exists, inferredMode } = r.evidence;
  if (r.source === 'recorded') return { state: r.mode, source: 'recorded', exists, disagrees: r.disagrees, inferredMode };
  if (exists && inferredMode) return { state: inferredMode, source: 'inferred', exists, disagrees: false, inferredMode };
  return { state: 'absent-unrecorded', source: null, exists: false, disagrees: false, inferredMode: null };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

// ============================================================================
// Entry point
// ============================================================================

export function adfCompileCommand(options: CLIOptions, args: string[]): number {
  const rawTarget = getFlag(args, '--target');
  if (!rawTarget) {
    throw new CLIError(
      'adf compile requires --target. Usage: charter adf compile --target <claude|agents|cursor|gemini|all>',
    );
  }

  // Zod boundary validation
  const targetParsed = CompileTargetOrAllSchema.safeParse(rawTarget);
  if (!targetParsed.success) {
    throw new CLIError(
      `Invalid --target: "${rawTarget}". Must be one of: claude, agents, cursor, gemini, all`,
    );
  }
  const targetOrAll: CompileTargetOrAll = targetParsed.data;

  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const displayAiDir = path.relative(process.cwd(), path.resolve(aiDir)) || aiDir;
  const writeMode = args.includes('--write');
  const checkMode = args.includes('--check');
  const forceWrite = args.includes('--force');

  if (writeMode && checkMode) {
    throw new CLIError('--write and --check are mutually exclusive.');
  }
  if (args.includes('--mode')) {
    if (!writeMode) throw new CLIError(COMPILE_MODE_FLAG_ERRORS.notWithWrite);
    if (getFlag(args, '--mode') !== 'compiled') throw new CLIError(COMPILE_MODE_FLAG_ERRORS.badValue);
  }
  const modeCompiled = args.includes('--mode');

  const manifestPath = path.join(aiDir, 'manifest.adf');
  if (!fs.existsSync(manifestPath)) {
    throw new CLIError(
      `manifest.adf not found at ${manifestPath}. Run: charter adf init`,
    );
  }

  // Resolve the list of targets to compile
  const targets: CompileTarget[] = targetOrAll === 'all'
    ? [...COMPILE_TARGETS]
    : [targetOrAll as CompileTarget];

  // File reader (real FS)
  const readFile = (p: string): string => fs.readFileSync(p, 'utf-8');

  if (checkMode) {
    return runCheckMode(options, targets, aiDir, displayAiDir, readFile);
  }

  if (writeMode) {
    return runWriteMode(options, targets, aiDir, displayAiDir, readFile, {
      force: forceWrite,
      modeCompiled,
      all: targetOrAll === 'all',
    });
  }

  // Default: stdout (single target only in non-write/check mode)
  if (targets.length > 1) {
    throw new CLIError(
      '--target all requires --write or --check. Use a single target to print to stdout.',
    );
  }
  return runStdoutMode(options, targets[0], aiDir, displayAiDir, readFile);
}

// ============================================================================
// Modes
// ============================================================================

function runStdoutMode(
  options: CLIOptions,
  target: CompileTarget,
  aiDir: string,
  displayAiDir: string,
  readFile: (p: string) => string,
): number {
  const result = compileAdf({ target, aiDir, displayAiDir, readFile });

  if (options.format === 'json') {
    // A pointer or unmanaged target is written only with --mode compiled (#318).
    const { state } = targetState(aiDir, TARGET_FILENAMES[target]);
    const writeActions = state === 'pointer' || state === 'unmanaged'
      ? [`charter adf compile --target ${target} --write --mode compiled`]
      : [`charter adf compile --target ${target} --write`, 'charter adf compile --target all --write'];
    console.log(JSON.stringify({
      target,
      defaultModules: result.defaultModules,
      onDemandModules: result.onDemandModules.map(m => ({
        path: m.path,
        triggers: m.triggers,
      })),
      output: result.output,
      nextActions: [...writeActions, `charter adf compile --target ${target} --check`],
    }, null, 2));
  } else {
    process.stdout.write(result.output);
  }

  return EXIT_CODE.SUCCESS;
}

// ============================================================================
// Retained-section detection (#295, #303)
// ============================================================================

/**
 * Pointer templates that may legitimately occupy each compile target's file.
 * CLAUDE.md has two shapes — `adf init --emit-pointers` writes the plain one,
 * `bootstrap` the hybrid one with a module index.
 *
 * Lazy-init to avoid the circular dependency with adf.ts at module load time,
 * mirroring getPointerTemplates() in adf-tidy.ts.
 */
function pointerTemplatesFor(filename: string): string[] {
  const byFilename: Record<string, string[]> = {
    'CLAUDE.md': [POINTER_CLAUDE_MD, POINTER_CLAUDE_MD_HYBRID],
    'AGENTS.md': [POINTER_AGENTS_MD],
    '.cursorrules': [POINTER_CURSORRULES],
    'GEMINI.md': [POINTER_GEMINI_MD],
  };
  return byFilename[filename] ?? [];
}

/**
 * Split a retained-sections block (from readRetainedSections) into heading → body.
 * Charter-managed sentinel blocks are stripped first, so a populated
 * `## Module Index` compares equal to the empty one in the template.
 */
function retainedSectionMap(content: string): Map<string, string> {
  const block = readRetainedSections(stripCharterSentinels(content));
  const sections = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];

  for (const line of block.split('\n')) {
    if (line.trim().startsWith('## ')) {
      if (heading) sections.set(heading, body.join('\n').trim());
      heading = line.trim();
      body = [];
      continue;
    }
    if (heading) body.push(line);
  }
  if (heading) sections.set(heading, body.join('\n').trim());

  return sections;
}

/**
 * Headings whose retained content differs from every pointer template for this
 * file — i.e. notes a user wrote into the `## Environment` slot the templates
 * invite them to use, or an operational `## ... Protocol` block that `adf tidy`
 * deliberately keeps in the vendor file (#198).
 *
 * No `.ai/` module holds these sections, so converting a pointer to compiled
 * output carries them into its retained block (adf-retained.ts, #303).
 */
export function divergentRetainedHeadings(existing: string, filename: string): string[] {
  const templates = pointerTemplatesFor(filename);
  const pristine = new Set<string>();
  for (const template of templates) {
    for (const [heading, body] of retainedSectionMap(template)) {
      pristine.add(`${heading}\n${body}`);
    }
  }

  const divergent: string[] = [];
  for (const [heading, body] of retainedSectionMap(existing)) {
    if (!pristine.has(`${heading}\n${body}`)) divergent.push(heading);
  }
  return divergent;
}

interface WriteFlags {
  force: boolean;
  /** --mode compiled: convert pointer and unmanaged targets, recording the switch first. */
  modeCompiled: boolean;
  /** --target all: a target in another mode is skipped, not refused. */
  all: boolean;
}

type WriteStatus =
  | 'written'
  | 'skipped-mode'
  | 'refused-mode-change'
  | 'refused-hand-authored'
  | 'refused-bloated'
  | 'refused-would-drop'
  | 'refused-record';
// 'refused-retained' is retired (#303): retained sections are carried, not refused over.

interface WriteTargetOutcome {
  target: CompileTarget;
  file: string;
  state: CompileTargetState;
  source: ModeSource | null;
  status: WriteStatus;
  recordedMode: VendorMode | null;
  previousMode: VendorMode | null;
  remedy: string | null;
  /** Set when the file write itself failed (status refused-record). */
  writeError: string | null;
  /** Retained headings carried into the written file, in order (#303). */
  retainedSections: string[];
  retainedSource: RetainedSource;
  /** Legacy retained-heading sections not carried because they look like rendered .ai/ text. */
  retainedSkipped: string[];
}

function runWriteMode(
  options: CLIOptions,
  targets: CompileTarget[],
  aiDir: string,
  displayAiDir: string,
  readFile: (p: string) => string,
  flags: WriteFlags,
): number {
  const json = options.format === 'json';
  const manifestPath = path.join(aiDir, 'manifest.adf');
  const warn = (w: string): void => (json ? console.warn(`Warning: ${w}`) : console.error(`  [warn] ${w}`));
  const rows: WriteTargetOutcome[] = [];
  const addIfAbsent: Array<{ file: VendorFile; mode: VendorMode }> = [];
  const modeSuffix = flags.modeCompiled ? ' --mode compiled' : '';
  /** A refusal's second remedy (the discarding one), listed after its first in nextActions. */
  const extraActions = new Map<string, string>();

  for (const target of targets) {
    const filename = TARGET_FILENAMES[target];
    const { state, source } = targetState(aiDir, filename);
    const row: WriteTargetOutcome = {
      target, file: filename, state, source, status: 'written', recordedMode: null, previousMode: null, remedy: null, writeError: null,
      retainedSections: [], retainedSource: 'none', retainedSkipped: [],
    };
    rows.push(row);

    // A pointer or unmanaged file changes mode only under --mode compiled (#318).
    // --force alone never converts one: it means "overwrite hand-authored content".
    if ((state === 'pointer' || state === 'unmanaged') && !flags.modeCompiled) {
      // An existing unmanaged file would then hit the hand-authored guard: name --force too.
      const handAuthored = state === 'unmanaged' && fs.existsSync(filename)
        && !CHARTER_OWNED_MARKERS.some(marker => fs.readFileSync(filename, 'utf-8').includes(marker));
      const force = handAuthored ? ' --force' : '';
      row.remedy = `charter adf compile --target ${target} --write --mode compiled${force}`;
      const values = { file: filename, mode: state, source: source ?? 'inferred', target, force };
      if (flags.all) {
        row.status = 'skipped-mode';
        if (!json) console.log(fill(MSG.skippedMode, values));
      } else {
        row.status = 'refused-mode-change';
        if (!json) console.error(fill(MSG.refusedModeChange, values));
      }
      continue;
    }

    // Overwrite protection: refuse to clobber a hand-written file.
    //
    // Charter-owned files are safe to replace: compile artifacts (which carry the
    // banner) and the thin pointer stubs written by `bootstrap` and
    // `adf init --emit-pointers`. CHARTER_OWNED_MARKERS covers both — it is the
    // banner plus every pointer marker. The pointer half is what lets
    // `--mode compiled` convert a clean bootstrap pointer without --force (#295);
    // the banner half keeps re-compiles working.
    //
    // This is the OWNERSHIP question, not the pointer-shape question — see the
    // note on the two marker lists in adf.ts. Do not narrow it to
    // POINTER_MARKERS: that drops the banner, and every re-compile over an
    // existing artifact would then refuse without --force (pinned by
    // adf-compile.test.ts, 'overwrites a previous compile artifact').
    if (fs.existsSync(filename) && !flags.force) {
      const existing = fs.readFileSync(filename, 'utf-8');
      if (!CHARTER_OWNED_MARKERS.some(marker => existing.includes(marker))) {
        row.status = 'refused-hand-authored';
        row.remedy = `charter adf compile --target ${target} --write${modeSuffix} --force`;
        if (!json) {
          console.error(
            `  [warn] Refused to overwrite ${filename} — hand-authored content found.\n` +
            `         Pass --force to overwrite. This protects hand-authored CLAUDE.md files.`,
          );
        }
        continue;
      }
    }

    // Render first: a compile error then leaves both record and file untouched.
    const result = compileAdf({ target, aiDir, displayAiDir, readFile });

    // Retained sections (#303) are carried into the output, never deleted, even
    // under --force (W4). Converting a pointer refuses only over content the
    // output would NOT carry: bloat tidy can fold into .ai/, or other stray lines.
    const existing = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf-8') : null;
    const composed = composeCompiled(result.output, existing, filename, { aiLines: readAiModuleLines(aiDir) });
    // Decided by the file's markers, not by whether anything is carried: a
    // pointer with no retained sections can still hold bloat or stray lines.
    if (existing !== null && inferVendorMode(filename as VendorFile, existing).inferredMode === 'pointer' && !flags.force) {
      const forceRemedy = `charter adf compile --target ${target} --write --mode compiled --force`;
      const n = countExtractable(filename, aiDir);
      if (n > 0) {
        row.status = 'refused-bloated';
        row.remedy = `charter adf tidy --source ${filename}`;
        extraActions.set(filename, forceRemedy);
        if (!json) console.error(fill(MSG.refusedBloated, { file: filename, n, target }));
        continue;
      }
      const lost = linesConvertWouldDrop(existing, composed.output);
      if (lost.length > 0) {
        const shown = lost.slice(0, 3).map(l => `'${l}'`).join(', ') + (lost.length > 3 ? `, and ${lost.length - 3} more` : '');
        row.status = 'refused-would-drop';
        row.remedy = forceRemedy;
        if (!json) console.error(fill(MSG.refusedWouldDrop, { file: filename, n: lost.length, lines: shown, target }));
        continue;
      }
    }

    // --mode compiled: record the mode BEFORE writing, so a half-done switch can
    // never leave record and file disagreeing. A skipped upsert writes nothing.
    if (flags.modeCompiled && state !== 'absent-unrecorded') {
      let recorded = false;
      try {
        const outcome = recordVendorModes(manifestPath, [{ file: filename as VendorFile, mode: 'compiled' }], 'upsert', { onWarning: warn });
        recorded = outcome.results.every(r => r.status !== 'skipped');
      } catch (err: unknown) {
        warn(`Vendor modes were not recorded: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!recorded) {
        row.status = 'refused-record';
        row.remedy = 'charter adf vendor status';
        if (!json) console.error(fill(MSG.refusedRecord, { file: filename, manifestPath }));
        continue;
      }
    }
    const upserted = flags.modeCompiled && state !== 'absent-unrecorded';

    // A failed write is reported per target, and the run goes on. A switch that
    // was already recorded is reverted, so record and file still agree.
    try {
      fs.writeFileSync(filename, composed.output, 'utf-8');
    } catch (err: unknown) {
      row.status = 'refused-record';
      row.writeError = err instanceof Error ? err.message : String(err);
      row.remedy = `charter adf compile --target ${target} --write${modeSuffix}`;
      let note = '';
      if (upserted) {
        const previous = state as VendorMode;
        let reverted = false;
        try {
          reverted = recordVendorModes(manifestPath, [{ file: filename as VendorFile, mode: previous }], 'upsert', { onWarning: warn })
            .results.every(r => r.status !== 'skipped');
        } catch {
          reverted = false;
        }
        note = reverted
          ? fill(MSG.writeFailedReverted, { previous })
          : fill(MSG.writeFailedNotReverted, { file: filename, previous });
      }
      if (!json) console.error(fill(MSG.writeFailed, { file: filename, error: row.writeError, note }));
      continue;
    }
    if (!upserted) addIfAbsent.push({ file: filename as VendorFile, mode: 'compiled' });
    if (state === 'pointer' || state === 'unmanaged') row.previousMode = state;
    row.retainedSections = composed.retainedSections;
    row.retainedSource = composed.retainedSource;
    row.retainedSkipped = composed.skipped;
    for (const heading of composed.skipped) warn(fill(RETAINED_MSG.skipped, { file: filename, heading }));
    for (const heading of composed.collisions) warn(fill(MSG.collision, { file: filename, heading }));
    if (!json) {
      const headings = composed.retainedSections.join(', ');
      const values = { file: filename, previous: row.previousMode ?? '', headings };
      console.log(row.previousMode
        ? fill(headings ? MSG.writtenSwitchedKept : MSG.writtenSwitched, values)
        : fill(headings ? MSG.writtenKept : MSG.writtenOk, values));
    }
  }

  // Record each target written without --mode as compiled, add-if-absent. Its
  // state was compiled or absent, so this never contradicts an entry. Warnings only.
  if (addIfAbsent.length > 0) {
    try {
      recordVendorModes(manifestPath, addIfAbsent, 'add-if-absent', { onWarning: warn });
    } catch (err: unknown) {
      warn(`Vendor modes were not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const record = readVendorRecord(manifestPath);
  for (const row of rows) {
    row.recordedMode = record.recorded.get(recordedSpelling(row.file as VendorFile, record.recorded))?.mode ?? null;
  }

  const refused = rows.filter(r => r.status.startsWith('refused-'));
  const skipped = rows.filter(r => r.status === 'skipped-mode');
  if (!json && skipped.length === rows.length) console.log(MSG.nothingCompiled);

  if (json) {
    const remedies = dedupe([...refused, ...skipped].flatMap(r => [r.remedy, extraActions.get(r.file) ?? null]).filter((r): r is string => r !== null));
    console.log(JSON.stringify({
      written: rows.filter(r => r.status === 'written').map(r => r.file),
      refused: refused.map(r => r.file),
      skipped: skipped.map(r => r.file),
      targets: rows,
      nextActions: remedies.length > 0
        ? remedies
        : ['charter adf compile --target all --check  # to verify files are up-to-date'],
    }, null, 2));
  }

  // Any refusal is a policy violation so CI can catch it; skips are a respected choice.
  return refused.length > 0 ? EXIT_CODE.POLICY_VIOLATION : EXIT_CODE.SUCCESS;
}

type CheckStatus =
  | 'fresh'
  | 'stale'
  | 'missing'
  | 'pointer-ok'
  | 'pointer-bloated'
  | 'mode-drift'
  | 'skipped-unmanaged';

const FAILING_CHECK_STATUSES: readonly CheckStatus[] = ['stale', 'missing', 'pointer-bloated', 'mode-drift'];

interface CheckTargetResult {
  target: CompileTarget;
  file: string;
  mode: VendorMode | null;
  source: ModeSource | null;
  status: CheckStatus;
  extractable: number | null;
  remedy: string | null;
  /** Set iff status is stale: 'retained-unfenced' when retained sections sit outside the retained block, else 'content'. */
  staleReason: 'content' | 'retained-unfenced' | null;
}

/**
 * Under --target all, when every failing target is a stale or missing compiled
 * (or absent) file, the one legacy remedy covers them all: it never changes a mode.
 */
function collapseCompileRemedies(rows: CheckTargetResult[], nextActions: string[]): string[] {
  const failing = rows.filter(r => FAILING_CHECK_STATUSES.includes(r.status));
  const plain = failing.every(r => (r.status === 'stale' || r.status === 'missing') && r.mode !== 'pointer');
  return rows.length > 1 && failing.length > 0 && plain ? ['charter adf compile --target all --write'] : nextActions;
}

function runCheckMode(
  options: CLIOptions,
  targets: CompileTarget[],
  aiDir: string,
  displayAiDir: string,
  readFile: (p: string) => string,
): number {
  const json = options.format === 'json';
  const rows: CheckTargetResult[] = [];
  const nextActions: string[] = [];
  const print = (line: string): void => {
    if (!json) console.log(line);
  };

  for (const target of targets) {
    const file = TARGET_FILENAMES[target];
    const ts = targetState(aiDir, file);
    const mode = ts.state === 'absent-unrecorded' ? null : ts.state;
    const row: CheckTargetResult = { target, file, mode, source: ts.source, status: 'fresh', extractable: null, remedy: null, staleReason: null };
    rows.push(row);
    const source = ts.source ?? 'inferred';
    const compileRemedy = `charter adf compile --target ${target} --write`;

    if (ts.state === 'absent-unrecorded' || (!ts.exists && ts.state === 'compiled')) {
      row.status = 'missing';
      row.remedy = compileRemedy;
      print(fill(MSG.checkMissingCompiled, { file, target }));
    } else if (!ts.exists && ts.state === 'pointer') {
      row.status = 'missing';
      row.remedy = `charter adf vendor restore ${file}`;
      nextActions.push(row.remedy, `charter adf vendor set ${file} unmanaged`);
      print(fill(MSG.checkMissingPointer, { file }));
    } else if (ts.disagrees && ts.state !== 'unmanaged' && ts.inferredMode) {
      // Recorded compiled|pointer, but the file looks like another mode: checking
      // it as either mode would give a misleading remedy.
      row.status = 'mode-drift';
      // The content-preserving fix comes first. Regenerating a recorded-compiled
      // file that now looks like a pointer would discard what tidy could extract.
      const n = ts.state === 'compiled' && ts.inferredMode === 'pointer' ? countExtractable(file, aiDir) : 0;
      const keep = [`charter adf vendor set ${file} ${ts.inferredMode}`, ...(n > 0 ? [`charter adf tidy --source ${file}`] : [])];
      const restore = ts.state === 'compiled'
        ? `${compileRemedy}${ts.inferredMode === 'unmanaged' ? ' --force' : ''}`
        : `charter adf vendor restore ${file}`;
      const discards = ts.state !== 'compiled' ? ''
        : ts.inferredMode === 'unmanaged' ? '  (discards its hand-authored content)'
          : n > 0 ? `  (discards ${n} item(s) not in ${displayAiDir}/)` : '';
      row.remedy = keep[0];
      nextActions.push(...keep, restore);
      print(fill(MSG.checkModeDrift, {
        file, recorded: ts.state, inferred: ts.inferredMode, keep: keep.join(', then '), restore: `${restore}${discards}`,
      }));
    } else if (ts.state === 'compiled') {
      // Expected bytes are what --write would write: the fresh render plus the
      // file's own retained block, so an edit inside the block is never stale (#303).
      const onDisk = fs.readFileSync(file, 'utf-8');
      const result = compileAdf({ target, aiDir, displayAiDir, readFile });
      const composed = composeCompiled(result.output, onDisk, file, { aiLines: readAiModuleLines(aiDir) });
      if (onDisk === composed.output) {
        print(fill(MSG.checkFresh, { file }));
      } else {
        row.status = 'stale';
        row.remedy = compileRemedy;
        row.staleReason = composed.unfenced.length > 0 ? 'retained-unfenced' : 'content';
        print(row.staleReason === 'retained-unfenced'
          ? fill(MSG.checkStaleUnfenced, { file, headings: composed.unfenced.join(', '), target })
          : fill(MSG.checkStale, { file, aiDir: displayAiDir, target }));
      }
    } else if (ts.state === 'pointer') {
      // A pointer is checked for being intact, never against compiled output.
      const n = countExtractable(file, aiDir);
      if (n === 0) {
        row.status = 'pointer-ok';
        print(fill(MSG.checkPointerOk, { file, aiDir: displayAiDir, source }));
      } else {
        row.status = 'pointer-bloated';
        row.extractable = n;
        row.remedy = `charter adf tidy --source ${file}`;
        print(fill(MSG.checkPointerBloated, { file, n, aiDir: displayAiDir }));
      }
    } else {
      row.status = 'skipped-unmanaged';
      print(fill(MSG.checkSkippedUnmanaged, { file, source }));
    }
    if (row.remedy) nextActions.push(row.remedy);
  }

  const failing = rows.some(r => FAILING_CHECK_STATUSES.includes(r.status));
  if (json) {
    const files = (...statuses: CheckStatus[]): string[] => rows.filter(r => statuses.includes(r.status)).map(r => r.file);
    console.log(JSON.stringify({
      stale: files('stale', 'pointer-bloated', 'mode-drift'),
      current: files('fresh', 'pointer-ok'),
      missing: files('missing'),
      skipped: files('skipped-unmanaged'),
      upToDate: !failing,
      targets: rows,
      nextActions: collapseCompileRemedies(rows, dedupe(nextActions)),
    }, null, 2));
  }

  // Exit 1 if any target fails its mode's check (CI drift gate)
  return failing ? EXIT_CODE.POLICY_VIOLATION : EXIT_CODE.SUCCESS;
}

/**
 * charter doctor
 *
 * Prints environment and configuration diagnostics for humans and agents.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { loadPatterns, loadConfig } from '../config';
import { parseAdf, parseManifest, stripCharterSentinels, evaluateLocBudgets, matchPath } from '@stackbilt/adf';
import type { LocBudgetRule } from '@stackbilt/adf';
import { isGitRepo, runGit } from '../git-helpers';
import { CHARTER_OWNED_MARKERS } from './adf';
import { TARGET_FILENAMES } from '@stackbilt/adf';
import type { CompileTarget } from '@stackbilt/adf';
import { countExtractable } from './adf-tidy';
import { legacyIndexEntries, legacyIndexKind, readVendorRecord, resolveVendorMode, resolveVendorModes, VENDOR_FILES, vendorFileGroups } from './adf-vendor';
import type { ModeSource, VendorEntryProblem, VendorFile, VendorMode } from './adf-vendor';
import { checkGateEnforcement, checkPreCommitScope } from './doctor-gate-enforcement';
import { HOOK_SCOPED_DOCTOR_ENV, HOOK_SCOPED_DOCTOR_FILE } from './hook-scope';
import { findMissingDefaultLoad, formatMissingDefaultLoad, REQUIRED_DEFAULT_LOAD_MODULES } from './adf-wiring';

interface DoctorResult {
  status: 'PASS' | 'WARN';
  checks: Array<{
    name: string;
    status: 'PASS' | 'WARN' | 'INFO';
    details: string;
    /** Only on the `adf vendor mode` check (#318). */
    rows?: VendorModeRow[];
  }>;
}

// Known MCP client config file paths (relative to repo root) and the key they look up under.
const MCP_CLIENT_CONFIGS: Array<{ label: string; configPath: string }> = [
  { label: 'Claude Code', configPath: '.claude/settings.json' },
  { label: 'Claude Code (local)', configPath: '.claude/settings.local.json' },
  { label: 'Generic MCP (.mcp.json)', configPath: '.mcp.json' },
  { label: 'Cursor', configPath: '.cursor/mcp.json' },
];

function checkMcpWiring(): DoctorResult['checks'][number] {
  const wired: string[] = [];
  const missing: string[] = [];

  for (const { label, configPath } of MCP_CLIENT_CONFIGS) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const hasCharter = parsed?.mcpServers?.charter !== undefined;
      if (hasCharter) {
        wired.push(`${label} (${configPath})`);
      } else {
        missing.push(`${label} (${configPath}) — no mcpServers.charter entry`);
      }
    } catch {
      missing.push(`${label} (${configPath}) — invalid JSON`);
    }
  }

  if (wired.length === 0 && missing.length === 0) {
    return {
      name: 'mcp wiring',
      status: 'WARN',
      details: 'No MCP client config files found. Run: charter hook print --mcp-config --client claude',
    };
  }

  if (wired.length > 0) {
    const details = `charter serve wired in: ${wired.join('; ')}` +
      (missing.length > 0 ? `\n    Not wired: ${missing.join('; ')}` : '');
    return { name: 'mcp wiring', status: 'PASS', details };
  }

  return {
    name: 'mcp wiring',
    status: 'WARN',
    details: `MCP config file(s) found but charter not wired: ${missing.join('; ')}\n    Run: charter hook print --mcp-config --client claude`,
  };
}

/**
 * Check whether the local telemetry log is tracked by git (#306).
 *
 * `charter bootstrap`/`init` write `telemetry/` into the generated
 * `<configPath>/.gitignore`, but a gitignore entry never untracks a file that
 * is already in the index. Repos bootstrapped before that entry existed keep
 * staging every new telemetry line on each `git add -A`, silently. Only the
 * git index is consulted — never the filesystem — so the answer is identical
 * on case-sensitive and case-insensitive checkouts.
 */
function checkTelemetryTracking(configPath: string): DoctorResult['checks'][number] | undefined {
  const telemetryDir = path.join(configPath, 'telemetry').replace(/\\/g, '/');
  const gitignorePath = path.join(configPath, '.gitignore').replace(/\\/g, '/');

  let tracked: string[];
  try {
    tracked = runGit(['ls-files', '--', telemetryDir])
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    // Unreadable index, or a --config directory outside this work tree. We
    // established nothing either way, so report nothing rather than claim a
    // PASS this check did not earn.
    return undefined;
  }

  if (tracked.length === 0) {
    return {
      name: 'telemetry tracking',
      status: 'PASS',
      details: `${telemetryDir} is not tracked by git.`,
    };
  }

  // Intentionally INFO, not WARN: doctor fails CI on any WARN, and this is
  // state Charter's own pre-#298 bootstrap created rather than anything the
  // user opted into — warning would break an existing repo's CI purely on
  // upgrade. Same ruling as the source LOC budget nudge (#186).
  //
  // The ignore entry comes first deliberately: after `git rm -r --cached` the
  // file is untracked but still on disk, so the reflexive `git add -A` that
  // caused this in the first place would re-stage it before the user finished.
  return {
    name: 'telemetry tracking',
    status: 'INFO',
    details: `${tracked.length} telemetry file(s) tracked by git: ${tracked.slice(0, 5).join(', ')}`
      + `\n    Every charter run appends to this log, so each "git add -A" stages it again.`
      + `\n    1. Make sure "telemetry/" is ignored — by ${gitignorePath}, or any .gitignore`
      + `\n       already covering it — or step 2 is undone by the next "git add -A".`
      + `\n    2. Run: git rm -r --cached "${telemetryDir}"`
      + `\n    The file stays on disk, so "charter telemetry report" keeps working.`,
  };
}

// ============================================================================
// adf vendor mode (#318)
// ============================================================================

export const DOCTOR_MSG = {
  allRecorded: 'All {n} vendor file(s) have a recorded mode that matches the file on disk.',
  inferred: '{n} vendor file(s) have no recorded mode ({files}); modes are inferred from file content. Record them with: charter adf vendor init',
  // The content-preserving fix comes first, as in `adf compile --check`: regenerating
  // a recorded-compiled file that now looks like a pointer or hand-authored file
  // discards what it holds, and an unmanaged one also needs --force.
  driftCompiled: '{file} is recorded as compiled but looks {inferred} on disk. Accept the file: charter adf vendor set {file} {inferred}  (or regenerate it: charter adf compile --target {target} --write{force}{discards})',
  driftPointer: '{file} is recorded as a pointer but looks {inferred} on disk. Accept the file: charter adf vendor set {file} {inferred}  (or rewrite the pointer: charter adf vendor restore {file})',
  recordedAbsent: '{file} is recorded as {recorded} but is not on disk. Recreate it: {recreate}  (or stop tracking it: charter adf vendor set {file} unmanaged)',
  entryProblem: "VENDORS entry '{raw}' in {manifestPath} is ignored ({problem}). Fix or delete that line in {manifestPath}.",
  entryDuplicate: "VENDORS lists {file} more than once in {manifestPath}; '{raw}' is ignored because a later entry wins. Delete that line.",
  alias: 'VENDORS records both {file} and {other}, which are the same file on disk; {file} is used. Delete the {other} line.',
  legacySpelling: "VENDORS records the legacy name agents.md for the file AGENTS.md, so `adf compile --target agents --mode compiled` cannot switch it. Run: charter adf vendor rename-legacy",
  // Legacy lowercase agents.md in the git index (#302). All INFO: Charter's own pre-#297 bootstrap created it.
  legacyTracked: 'git tracks agents.md under its pre-#297 lowercase name. Rename it (case-safe, keeps its VENDORS entry): charter adf vendor rename-legacy',
  legacyBothDistinct: 'git tracks both agents.md and AGENTS.md as separate files. Move anything you need from agents.md into AGENTS.md, then: git rm agents.md',
  legacyBothOneFile: 'git has two index entries (agents.md and AGENTS.md) for one file on this case-insensitive checkout. Drop the stale entry: git rm --cached agents.md',
  sectionNotList: 'VENDORS in {manifestPath} does not read as a list, so every vendor mode is inferred. Every line under it must look like "  - CLAUDE.md: pointer".',
  agentConfigPass: '{pointers} thin pointer(s) and {compiled} compiled file(s) route to .ai/{unmanagedNote}.',
  unmanagedNote: '; {n} file(s) recorded unmanaged are left alone',
} as const;

/** The order `adf agent config` has always listed vendor files in. */
const AGENT_CONFIG_ORDER: readonly string[] = ['CLAUDE.md', '.cursorrules', 'agents.md', 'AGENTS.md', 'GEMINI.md', 'copilot-instructions.md'];

export type VendorModeRowKind =
  | 'recorded-ok'
  | 'recorded-drift'
  | 'recorded-absent'
  | 'recorded-unmanaged-absent'
  | 'inferred'
  | 'entry-problem'
  | 'alias-recorded'
  | 'legacy-spelling'
  | 'legacy-tracked'
  | 'legacy-both-distinct'
  | 'legacy-both-one-file'
  | 'section-not-list';

type CheckStatus = 'PASS' | 'WARN' | 'INFO';

export const ROW_STATUS: Record<VendorModeRowKind, CheckStatus> = {
  'recorded-ok': 'PASS',
  'recorded-drift': 'WARN',
  'recorded-absent': 'WARN',
  'recorded-unmanaged-absent': 'PASS',
  inferred: 'INFO',
  'entry-problem': 'WARN',
  'alias-recorded': 'INFO',
  'legacy-spelling': 'INFO',
  'legacy-tracked': 'INFO',
  'legacy-both-distinct': 'INFO',
  'legacy-both-one-file': 'INFO',
  'section-not-list': 'WARN',
};

/** An explicit entry being ignored WARNs; a duplicate resolves deterministically (last wins). */
const ENTRY_PROBLEM_STATUS: Record<VendorEntryProblem, CheckStatus> = {
  malformed: 'WARN',
  'unknown-file': 'WARN',
  'mode-not-allowed': 'WARN',
  duplicate: 'INFO',
};

export interface VendorModeRow {
  kind: VendorModeRowKind;
  status: CheckStatus;
  file: VendorFile | null;
  recordedMode: VendorMode | null;
  /** null iff the file is absent. */
  inferredMode: VendorMode | null;
  source: ModeSource | null;
  /** The VENDORS item text, for entry problems. */
  raw: string | null;
  remedy: string | null;
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

const WORST: CheckStatus[] = ['WARN', 'INFO', 'PASS'];

function compileTargetOf(file: VendorFile): string {
  return (Object.keys(TARGET_FILENAMES) as CompileTarget[]).find(t => TARGET_FILENAMES[t] === file) ?? 'all';
}

/**
 * One row per vendor file (per physical file) plus one per record problem.
 * Read-only: doctor never writes the record or a vendor file (INV-P3-1). WARN
 * only where an explicit record is contradicted or ignored (INV-P3-3).
 */
export function vendorModeRows(aiDir: string, manifestPath: string): Array<{ row: VendorModeRow; detail: string | null }> {
  const record = readVendorRecord(manifestPath);
  // Key order follows the row schema: kind, status, file, recordedMode, inferredMode, source, raw, remedy.
  const base: VendorModeRow = { kind: 'recorded-ok', status: 'PASS', file: null, recordedMode: null, inferredMode: null, source: null, raw: null, remedy: null };
  if (record.readProblem === 'section-not-list') {
    return [
      { row: { ...base, kind: 'section-not-list', status: 'WARN' }, detail: fill(DOCTOR_MSG.sectionNotList, { manifestPath }) },
      ...legacyIndexRows(aiDir, base),
    ];
  }
  const out: Array<{ row: VendorModeRow; detail: string | null }> = [];
  for (const r of resolveVendorModes(aiDir)) {
    const ev = r.evidence;
    const row: VendorModeRow = {
      ...base, kind: 'recorded-ok', status: 'PASS', file: r.file, inferredMode: ev.inferredMode, source: r.source,
      recordedMode: r.source === 'recorded' ? r.mode : null,
    };
    let detail: string | null = null;
    const target = compileTargetOf(r.file);
    if (r.source === 'inferred') {
      row.kind = 'inferred';
      row.remedy = 'charter adf vendor init';
    } else if (r.mode === 'unmanaged') {
      row.kind = ev.exists ? 'recorded-ok' : 'recorded-unmanaged-absent';
    } else if (!ev.exists) {
      row.kind = 'recorded-absent';
      row.remedy = r.mode === 'compiled' ? `charter adf compile --target ${target} --write` : `charter adf vendor restore ${r.file}`;
      detail = fill(DOCTOR_MSG.recordedAbsent, { file: r.file, recorded: r.mode, recreate: row.remedy });
    } else if (r.disagrees && ev.inferredMode) {
      row.kind = 'recorded-drift';
      row.remedy = `charter adf vendor set ${r.file} ${ev.inferredMode}`;
      if (r.mode === 'compiled') {
        const n = ev.inferredMode === 'pointer' ? countExtractable(r.file, aiDir) : 0;
        const discards = ev.inferredMode === 'unmanaged' ? '; discards its hand-authored content'
          : n > 0 ? `; discards ${n} item(s) not in ${aiDir}/` : '';
        detail = fill(DOCTOR_MSG.driftCompiled, {
          file: r.file, inferred: ev.inferredMode, target, force: ev.inferredMode === 'unmanaged' ? ' --force' : '', discards,
        });
      } else {
        detail = fill(DOCTOR_MSG.driftPointer, { file: r.file, inferred: ev.inferredMode });
      }
    }
    row.status = ROW_STATUS[row.kind];
    out.push({ row, detail });
  }

  const inferred = out.filter(o => o.row.kind === 'inferred');
  if (inferred.length > 0) {
    // One line for every inferred file: they share one remedy.
    inferred[0].detail = fill(DOCTOR_MSG.inferred, { n: inferred.length, files: inferred.map(o => o.row.file).join(', ') });
  }

  for (const p of record.problems) {
    const status = ENTRY_PROBLEM_STATUS[p.problem];
    const detail = p.problem === 'duplicate'
      ? fill(DOCTOR_MSG.entryDuplicate, { file: p.file ?? '', manifestPath, raw: p.raw })
      : fill(DOCTOR_MSG.entryProblem, { raw: p.raw, manifestPath, problem: p.problem });
    out.push({ row: { ...base, kind: 'entry-problem', status, file: p.file, raw: p.raw }, detail });
  }

  for (const group of vendorFileGroups()) {
    const names = group.filter(n => record.recorded.has(n));
    if (names.length > 1) {
      for (const other of names.slice(1)) {
        const row: VendorModeRow = { ...base, kind: 'alias-recorded', status: 'INFO', file: other, recordedMode: record.recorded.get(other)?.mode ?? null, source: 'recorded' };
        out.push({ row, detail: fill(DOCTOR_MSG.alias, { file: names[0], other }) });
      }
    } else if (names[0] === 'agents.md' && group.includes('AGENTS.md')) {
      const mode = record.recorded.get('agents.md')?.mode ?? 'pointer';
      const row: VendorModeRow = {
        ...base, kind: 'legacy-spelling', status: 'INFO', file: 'agents.md', recordedMode: mode, source: 'recorded', remedy: 'charter adf vendor rename-legacy',
      };
      out.push({ row, detail: DOCTOR_MSG.legacySpelling });
    }
  }
  out.push(...legacyIndexRows(aiDir, base));
  return out;
}

const LEGACY_INDEX_ROWS = {
  'legacy-tracked': { detail: DOCTOR_MSG.legacyTracked, remedy: 'charter adf vendor rename-legacy' },
  'legacy-both-distinct': { detail: DOCTOR_MSG.legacyBothDistinct, remedy: 'git rm agents.md' },
  'legacy-both-one-file': { detail: DOCTOR_MSG.legacyBothOneFile, remedy: 'git rm --cached agents.md' },
} as const;

/**
 * A lowercase agents.md in the git index (#302). Reads the index only (plus the
 * file identity to tell two files from one), so an untracked agents.md, or a
 * directory outside git, gives no row. Always INFO (INV-P6-2).
 */
function legacyIndexRows(aiDir: string, base: VendorModeRow): Array<{ row: VendorModeRow; detail: string | null }> {
  const kind = legacyIndexKind(legacyIndexEntries());
  if (!kind) return [];
  const r = resolveVendorMode(aiDir, 'agents.md');
  const row: VendorModeRow = {
    ...base, kind, status: ROW_STATUS[kind], file: 'agents.md', recordedMode: r.source === 'recorded' ? r.mode : null,
    inferredMode: r.evidence.inferredMode, source: r.source, remedy: LEGACY_INDEX_ROWS[kind].remedy,
  };
  return [{ row, detail: LEGACY_INDEX_ROWS[kind].detail }];
}

/** The `adf vendor mode` check: worst row status, one detail line per non-PASS row. */
function checkVendorModes(aiDir: string, manifestPath: string): DoctorResult['checks'][number] | undefined {
  const entries = vendorModeRows(aiDir, manifestPath);
  if (entries.length === 0) return undefined;
  const rows = entries.map(e => e.row);
  const status = WORST.find(s => rows.some(r => r.status === s)) ?? 'PASS';
  const lines = entries.filter(e => e.row.status !== 'PASS' && e.detail).map(e => e.detail as string);
  return {
    name: 'adf vendor mode',
    status,
    details: lines.length > 0 ? lines.join('\n    ') : fill(DOCTOR_MSG.allRecorded, { n: rows.length }),
    rows,
  };
}

// ============================================================================
// Commit-scoped vendor bloat (#357)
// ============================================================================

export const BLOAT_SCOPE_MSG = {
  tidySkippedNeedsStaged: '--tidy-skipped requires --staged.',
  tidySkippedMissing: '--tidy-skipped requires a value: the vendor files the pre-commit hook skipped (may be empty, "").',
  stagedPass: '{n} staged vendor file(s) checked, within bloat thresholds.',
  stagedPassSkipped: ' {skipped} staged vendor file(s) skipped by auto-tidy are not checked here (see the INFO row).',
  outsideHeader: 'Vendor file bloat outside this commit (not blocking under --staged; charter doctor --ci without --staged still fails on it):',
  notStaged: '{file} (not staged)',
  tidySkipped: '{file} (auto-tidy skipped for it in this commit)',
  outsideRun: 'Run: charter adf tidy --source <file>, then git add the result',
  hookChecked: `Not enforced in this run: the Charter pre-commit hook already checked vendor bloat for this commit (doctor --staged) and set ${HOOK_SCOPED_DOCTOR_ENV} for its verify:adf run. charter doctor --ci outside the hook, as CI runs it, checks every vendor file.`,
  hookCheckedFound: 'Bloat this run would otherwise report:',
  hookCheckedStderr: `[doctor] adf vendor bloat: not enforced in this run; the Charter pre-commit hook already checked it for this commit (${HOOK_SCOPED_DOCTOR_ENV}).`,
} as const;

/**
 * Which vendor files' bloat can fail doctor. `null` (no --staged) is the
 * unscoped default: every vendor file, exactly as before #357.
 * With --staged (the generated pre-commit hook's gate), only vendor files staged
 * in the index, minus the ones listed in --tidy-skipped (the files the hook's
 * tidy block deliberately skipped, CP-3/CP-4). Only the bloat check is scoped.
 */
interface BloatScope {
  staged: ReadonlySet<string>;
  skipped: ReadonlySet<string>;
}

function resolveBloatScope(args: string[]): BloatScope | null {
  const hasSkipped = args.includes('--tidy-skipped');
  if (!args.includes('--staged')) {
    if (hasSkipped) throw new CLIError(BLOAT_SCOPE_MSG.tidySkippedNeedsStaged);
    return null;
  }
  const skippedRaw = hasSkipped ? getFlag(args, '--tidy-skipped') : '';
  if (skippedRaw === undefined || skippedRaw.startsWith('--')) throw new CLIError(BLOAT_SCOPE_MSG.tidySkippedMissing);
  let stagedOut: string;
  try {
    stagedOut = runGit(['diff', '--cached', '--name-only', '--diff-filter=d']);
  } catch {
    // The index cannot be read: fall back to enforcing every vendor file.
    return null;
  }
  const vendorNames = new Set<string>(VENDOR_FILES);
  const staged = new Set(stagedOut.split(/\r?\n/).map(l => l.trim()).filter(l => vendorNames.has(l)));
  const skipped = new Set(skippedRaw.split(/\s+/).filter(Boolean));
  return { staged, skipped };
}

/**
 * True only while the generated pre-commit hook runs verify:adf, after its own
 * doctor --staged has checked vendor bloat for this commit. The hook sets
 * HOOK_SCOPED_DOCTOR_ENV to a token and writes the same token to
 * HOOK_SCOPED_DOCTOR_FILE in the git dir, removing it when the hook exits. Both
 * must match: the variable alone (say, left in a CI environment) does nothing,
 * and while it is unset git is not even asked. Only the bloat check is affected.
 */
function hookAlreadyCheckedBloat(): boolean {
  const token = process.env[HOOK_SCOPED_DOCTOR_ENV]?.trim();
  if (!token) return false;
  try {
    const file = runGit(['rev-parse', '--git-path', HOOK_SCOPED_DOCTOR_FILE]).trim();
    return fs.readFileSync(file, 'utf-8').trim() === token;
  } catch {
    return false;
  }
}

export async function doctorCommand(options: CLIOptions, args: string[] = []): Promise<number> {
  const checks: DoctorResult['checks'] = [];
  const adfOnly = args.includes('--adf-only');
  const bloatScope = resolveBloatScope(args);
  const mcpMode = args.includes('--mcp');
  const configFile = path.join(options.configPath, 'config.json');
  const inGitRepo = isGitRepo();
  const config = loadConfig(options.configPath);
  // Number of files with per-file LOC measurement declared in manifest METRICS;
  // set during manifest parse, used by the source LOC budget coverage check.
  let manifestLocMetricCount = 0;

  // --mcp: focused MCP wiring check only
  if (mcpMode) {
    checks.push(checkMcpWiring());
    const hasWarn = checks.some(c => c.status === 'WARN');
    const result: DoctorResult = { status: hasWarn ? 'WARN' : 'PASS', checks };
    if (options.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`  Doctor status: ${result.status}`);
      for (const check of result.checks) {
        const icon = check.status === 'PASS' ? '[ok]' : check.status === 'INFO' ? '[info]' : '[warn]';
        console.log(`  ${icon} ${check.name}: ${check.details}`);
      }
    }
    if (options.ciMode && hasWarn) return EXIT_CODE.POLICY_VIOLATION;
    return EXIT_CODE.SUCCESS;
  }

  checks.push({
    name: 'git repository',
    status: inGitRepo ? 'PASS' : 'WARN',
    details: inGitRepo ? 'Repository detected.' : 'Not inside a git repository.',
  });

  if (!adfOnly) {
    const hasConfig = fs.existsSync(configFile);
    checks.push({
      name: 'config file',
      status: hasConfig ? 'PASS' : 'WARN',
      details: hasConfig ? `${configFile} exists.` : `${configFile} not found. Run charter setup.`,
    });

    if (hasConfig) {
      const configCheck = validateJSONConfig(configFile);
      checks.push(configCheck);
      const strictTrailers = config.git.requireTrailers
        && ['FAIL', 'STRICT'].includes(config.validation.citationStrictness);
      if (configCheck.status === 'PASS' && strictTrailers && inGitRepo) {
        checks.push(checkGateEnforcement());
      }
    }

    const patterns = loadPatterns(options.configPath);
    checks.push({
      name: 'patterns',
      status: patterns.length > 0 ? 'PASS' : 'WARN',
      details: patterns.length > 0
        ? `${patterns.length} pattern(s) loaded.`
        : 'No patterns found in .charter/patterns/*.json.',
    });

    const policyDir = path.join(options.configPath, 'policies');
    const policyCount = fs.existsSync(policyDir)
      ? fs.readdirSync(policyDir).filter((f) => f.endsWith('.md')).length
      : 0;

    checks.push({
      name: 'policy docs',
      status: policyCount > 0 ? 'PASS' : 'WARN',
      details: policyCount > 0 ? `${policyCount} markdown policy file(s).` : 'No policy markdown files found.',
    });

    // Only meaningful with an index to read. Matches `gate enforcement`, which
    // is likewise withheld outside a repo rather than reported as vacuously OK.
    if (inGitRepo) {
      const telemetryCheck = checkTelemetryTracking(options.configPath);
      if (telemetryCheck) checks.push(telemetryCheck);
    }

    const securityDenyPath = path.join(options.configPath, 'patterns', 'security-deny.json');
    if (fs.existsSync(securityDenyPath)) {
      const securityTestFiles = findSecurityTestFiles('.');
      checks.push({
        name: 'security test coverage',
        status: securityTestFiles.length > 0 ? 'PASS' : 'WARN',
        details: securityTestFiles.length > 0
          ? `${securityTestFiles.length} security test file(s): ${securityTestFiles.slice(0, 5).join(', ')}`
          : 'Security-sensitive repo has no **/security* or **/l4* test file. Add L4/security regression tests.',
      });
    }
  }

  // An old Charter pre-commit hook over-stages .ai/ (#320). No row unless found.
  if (inGitRepo) {
    const preCommitCheck = checkPreCommitScope();
    if (preCommitCheck) checks.push(preCommitCheck);
  }

  // ADF readiness checks
  const aiDir = '.ai';
  const manifestPath = path.join(aiDir, 'manifest.adf');
  const hasManifest = fs.existsSync(manifestPath);

  checks.push({
    name: 'adf manifest',
    status: hasManifest ? 'PASS' : 'WARN',
    details: hasManifest ? `${manifestPath} exists.` : `${manifestPath} not found. Run: charter adf init`,
  });

  if (hasManifest) {
    try {
      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifestDoc = parseAdf(manifestContent);
      const manifest = parseManifest(manifestDoc);
      manifestLocMetricCount = manifest.metrics.length;

      checks.push({
        name: 'adf manifest parse',
        status: 'PASS',
        details: `Parsed: ${manifest.defaultLoad.length} default-load, ${manifest.onDemand.length} on-demand module(s).`,
      });

      // Required baseline wiring for a standard ADF repo
      const missingRequired = findMissingDefaultLoad(manifest);
      checks.push({
        name: 'adf required wiring',
        status: missingRequired.length === 0 ? 'PASS' : 'WARN',
        details: missingRequired.length === 0
          ? `Required default-load modules present (${REQUIRED_DEFAULT_LOAD_MODULES.join(', ')}).`
          : formatMissingDefaultLoad(missingRequired),
      });

      // Check that all defaultLoad modules exist and parse
      const missingModules: string[] = [];
      for (const mod of manifest.defaultLoad) {
        const modPath = path.join(aiDir, mod);
        if (!fs.existsSync(modPath)) {
          missingModules.push(mod);
        } else {
          try {
            parseAdf(fs.readFileSync(modPath, 'utf-8'));
          } catch {
            missingModules.push(`${mod} (parse error)`);
          }
        }
      }

      checks.push({
        name: 'adf default modules',
        status: missingModules.length === 0 ? 'PASS' : 'WARN',
        details: missingModules.length === 0
          ? `All ${manifest.defaultLoad.length} default-load module(s) present and parseable.`
          : `Missing or unparseable: ${missingModules.join(', ')}`,
      });

      // Check that on-demand modules exist and parse (missing modules are warnings)
      const onDemandPaths = [...new Set(manifest.onDemand.map(m => m.path))];
      const onDemandIssues: string[] = [];
      for (const mod of onDemandPaths) {
        const modPath = path.join(aiDir, mod);
        if (!fs.existsSync(modPath)) {
          onDemandIssues.push(`${mod} (missing)`);
          continue;
        }
        try {
          parseAdf(fs.readFileSync(modPath, 'utf-8'));
        } catch {
          onDemandIssues.push(`${mod} (parse error)`);
        }
      }
      checks.push({
        name: 'adf on-demand modules',
        status: onDemandIssues.length === 0 ? 'PASS' : 'WARN',
        details: onDemandIssues.length === 0
          ? `All ${onDemandPaths.length} on-demand module(s) present and parseable.`
          : `Missing or unparseable: ${onDemandIssues.join(', ')}`,
      });

      // Vendor file modes: the VENDORS record against the markers on disk (#318).
      const vendorModeCheck = checkVendorModes(aiDir, manifestPath);
      if (vendorModeCheck) checks.push(vendorModeCheck);

      // Agent config pointer check: flag files with stack rules that should be in .ai/.
      // One entry per physical file (AGENTS.md and agents.md can be one file), in
      // the order this check has always listed them. A file recorded unmanaged is
      // the user's own and is left alone (#318).
      const vendorFiles = resolveVendorModes(aiDir)
        .filter(r => r.evidence.exists)
        .sort((a, b) => AGENT_CONFIG_ORDER.indexOf(a.file) - AGENT_CONFIG_ORDER.indexOf(b.file));
      const recordedUnmanaged = vendorFiles.filter(r => r.source === 'recorded' && r.mode === 'unmanaged');
      const managed = vendorFiles.filter(r => !recordedUnmanaged.includes(r));
      // Same ownership test as before the record: no banner and no pointer marker.
      const nonPointerFiles = managed.filter(r => !r.evidence.banner && r.evidence.pointerMarkers.length === 0).map(r => r.file);
      // Bloat and cold start look at pointers only: resolved pointer, and pointer-shaped on disk.
      const pointerFiles = managed
        .filter(r => r.mode === 'pointer' && r.evidence.inferredMode === 'pointer')
        .map(r => ({ file: r.file, content: fs.readFileSync(r.file, 'utf-8') }));
      if (nonPointerFiles.length > 0) {
        checks.push({
          name: 'adf agent config',
          status: 'WARN',
          details: `${nonPointerFiles.join(', ')} contain${nonPointerFiles.length === 1 ? 's' : ''} stack rules that should live in .ai/. Run: charter adf migrate --dry-run`,
        });
      } else if (vendorFiles.length > 0) {
        const compiled = managed.filter(r => r.evidence.banner).length;
        checks.push({
          name: 'adf agent config',
          status: 'PASS',
          details: fill(DOCTOR_MSG.agentConfigPass, {
            pointers: managed.length - compiled,
            compiled,
            unmanagedNote: recordedUnmanaged.length > 0 ? fill(DOCTOR_MSG.unmanagedNote, { n: recordedUnmanaged.length }) : '',
          }),
        });
      }

      // Vendor file bloat detection: line count, section overlap, keyword density
      const BLOAT_LINE_THRESHOLD = 80;
      const bloatWarnings: string[] = [];
      const bloatByFile: Array<{ file: string; warnings: string }> = [];

      // Collect ADF section keys for overlap detection
      const adfSectionKeys = new Set<string>();
      const allModulePaths = [...manifest.defaultLoad, ...manifest.onDemand.map(m => m.path)];
      for (const mod of allModulePaths) {
        const modPath = path.join(aiDir, mod);
        if (fs.existsSync(modPath)) {
          try {
            const modDoc = parseAdf(fs.readFileSync(modPath, 'utf-8'));
            for (const sec of modDoc.sections) {
              adfSectionKeys.add(sec.key.toLowerCase());
            }
          } catch { /* skip unparseable */ }
        }
      }

      // Collect trigger keywords for density check
      const triggerKeywords: Array<{ keyword: string; module: string }> = [];
      for (const mod of manifest.onDemand) {
        for (const trigger of mod.triggers) {
          triggerKeywords.push({ keyword: trigger.toLowerCase(), module: mod.path });
        }
      }

      for (const { file, content } of pointerFiles) {
        // Compile output never reaches here (pointerFiles is pointers only); a
        // record that contradicts the file is `adf vendor mode`'s to report.

        // Strip charter-managed sentinel blocks before scanning for bloat/keywords.
        const strippedContent = stripCharterSentinels(content);
        const lines = strippedContent.split('\n');
        const lineCount = lines.length;
        const fileWarnings: string[] = [];

        // 1. Line count threshold
        if (lineCount > BLOAT_LINE_THRESHOLD) {
          fileWarnings.push(`${lineCount} lines (threshold: ${BLOAT_LINE_THRESHOLD})`);
        }

        // 2. Section overlap detection — find H2 headers that match ADF section keys
        const h2Sections = lines
          .filter(l => l.trim().startsWith('## '))
          .map(l => l.trim().replace(/^## /, ''))
          .filter(h => h !== 'Environment'); // Environment is legitimate

        for (const header of h2Sections) {
          const headerLower = header.toLowerCase();
          for (const adfKey of adfSectionKeys) {
            const keyWords = adfKey.toLowerCase().split(/[_\s]+/);
            if (keyWords.some(w => w.length > 3 && headerLower.includes(w))) {
              fileWarnings.push(`"${header}" section overlaps ADF section "${adfKey}"`);
              break;
            }
          }
        }

        // 3. Keyword density — check for trigger keyword concentration
        // Exclude pointer preamble lines (blockquotes, comments, marker lines)
        const nonPointerContent = lines.filter(l => {
          const t = l.trim();
          if (t.startsWith('>') || t.startsWith('<!--') || t.startsWith('#') && !t.startsWith('## ')) return false;
          if (CHARTER_OWNED_MARKERS.some(m => t.includes(m))) return false;
          if (t.includes('.ai/manifest.adf') || t.includes('auto-managed by Charter')) return false;
          return true;
        }).join('\n');
        const contentLower = nonPointerContent.toLowerCase();
        const matchedModules = new Map<string, string[]>();
        for (const { keyword, module } of triggerKeywords) {
          // Count occurrences (word boundary match)
          const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
          const matches = contentLower.match(regex);
          if (matches && matches.length >= 2) {
            if (!matchedModules.has(module)) matchedModules.set(module, []);
            matchedModules.get(module)!.push(`${keyword} (${matches.length}x)`);
          }
        }
        for (const [mod, keywords] of matchedModules) {
          fileWarnings.push(`trigger keywords [${keywords.join(', ')}] suggest content belongs in ${mod}`);
        }

        if (fileWarnings.length > 0) {
          bloatWarnings.push(`${file}: ${fileWarnings.join('; ')}`);
          bloatByFile.push({ file, warnings: fileWarnings.join('; ') });
        }
      }

      if (bloatScope) {
        // Hook gate (#357): a file is matched under any spelling of its physical
        // file, so a staged agents.md covers the AGENTS.md row on NTFS.
        const groups = vendorFileGroups();
        const namesOf = (file: string): string[] => groups.find(g => (g as string[]).includes(file)) ?? [file];
        const scopeOf = (file: string): 'blocking' | 'skipped' | 'not-staged' => {
          const names = namesOf(file);
          if (names.some(n => bloatScope.skipped.has(n))) return 'skipped';
          return names.some(n => bloatScope.staged.has(n)) ? 'blocking' : 'not-staged';
        };
        const blocking = bloatByFile.filter(b => scopeOf(b.file) === 'blocking');
        const outside = bloatByFile.filter(b => scopeOf(b.file) !== 'blocking');
        const skippedBloated = outside.filter(b => scopeOf(b.file) === 'skipped').length;
        if (blocking.length > 0) {
          checks.push({
            name: 'adf vendor bloat',
            status: 'WARN',
            // Scoped advice: a whole-tree tidy would also rewrite files this commit leaves out.
            details: `Vendor file bloat detected:\n    ${blocking.map(b => `${b.file}: ${b.warnings}`).join('\n    ')}\n    Run: charter adf tidy --dry-run${blocking.map(b => ` --source ${b.file}`).join('')}`,
          });
        } else if (pointerFiles.length > 0) {
          checks.push({
            name: 'adf vendor bloat',
            status: 'PASS',
            details: fill(BLOAT_SCOPE_MSG.stagedPass, { n: pointerFiles.filter(p => scopeOf(p.file) === 'blocking').length })
              + (skippedBloated > 0 ? fill(BLOAT_SCOPE_MSG.stagedPassSkipped, { skipped: skippedBloated }) : ''),
          });
        }
        if (outside.length > 0) {
          const label = (file: string): string => fill(scopeOf(file) === 'skipped' ? BLOAT_SCOPE_MSG.tidySkipped : BLOAT_SCOPE_MSG.notStaged, { file });
          checks.push({
            name: 'adf vendor bloat (not blocking)',
            status: 'INFO',
            details: `${BLOAT_SCOPE_MSG.outsideHeader}\n    ${outside.map(b => `${label(b.file)}: ${b.warnings}`).join('\n    ')}\n    ${BLOAT_SCOPE_MSG.outsideRun}`,
          });
        }
      } else if (hookAlreadyCheckedBloat()) {
        // Inside the hook's verify:adf run: reported, never a WARN, and said out loud.
        console.error(BLOAT_SCOPE_MSG.hookCheckedStderr);
        checks.push({
          name: 'adf vendor bloat (checked by pre-commit hook)',
          status: 'INFO',
          details: BLOAT_SCOPE_MSG.hookChecked
            + (bloatWarnings.length > 0 ? `\n    ${BLOAT_SCOPE_MSG.hookCheckedFound}\n    ${bloatWarnings.join('\n    ')}` : ''),
        });
      } else if (bloatWarnings.length > 0) {
        checks.push({
          name: 'adf vendor bloat',
          status: 'WARN',
          details: `Vendor file bloat detected:\n    ${bloatWarnings.join('\n    ')}\n    Run: charter adf tidy --dry-run`,
        });
      } else if (pointerFiles.length > 0) {
        checks.push({
          name: 'adf vendor bloat',
          status: 'PASS',
          details: `${pointerFiles.length} vendor file(s) within bloat thresholds.`,
        });
      }

      // Cold-start check: thin pointers with no architectural orientation (#41)
      // A pointer that's <15 lines and contains no stack/framework keywords gives
      // agents zero context about the project. Soft [info] — does not fail doctor.
      //
      // HOWEVER: if the file is a validated thin pointer to a populated .ai/
      // directory with modules, the pointer IS doing its job — agents get context
      // from .ai/ modules, not from the pointer file. Suppress in that case (#72).
      const STACK_KEYWORDS = /\b(react|vue|svelte|next|nuxt|astro|remix|angular|node|bun|deno|python|go|rust|postgres|mysql|sqlite|d1|prisma|drizzle|hono|express|fastify|trpc|cloudflare|vercel|railway|docker|kubernetes)\b/i;
      const hasPopulatedModules = allModulePaths.length > 0;
      for (const { file, content } of pointerFiles) {
        const lineCount = content.split('\n').filter(l => l.trim()).length;
        const hasStackHint = STACK_KEYWORDS.test(content);
        if (lineCount < 15 && !hasStackHint && !hasPopulatedModules) {
          checks.push({
            name: 'adf cold start',
            status: 'INFO',
            details: `${file} is a thin pointer with ${lineCount} lines and no stack keywords — agents have no architecture orientation. Run: charter adf populate`,
          });
        }
      }

      // Sync lock status
      if (manifest.sync.length > 0) {
        const lockFile = path.join(aiDir, '.adf.lock');
        const hasLock = fs.existsSync(lockFile);
        checks.push({
          name: 'adf sync lock',
          status: hasLock ? 'PASS' : 'WARN',
          details: hasLock
            ? `${lockFile} exists (${manifest.sync.length} sync entry/entries).`
            : `${lockFile} not found. Run: charter adf sync --write`,
        });
      }
    } catch {
      checks.push({
        name: 'adf manifest parse',
        status: 'WARN',
        details: `${manifestPath} failed to parse.`,
      });
    }
  }

  // Source LOC budget coverage + enforcement (#186).
  // Runs regardless of --adf-only so the pre-commit/CI gate surfaces it.
  const locBudgets = config.locBudgets;
  const budgetRules = locBudgets?.paths ?? [];
  const budgetsEnabled = !!locBudgets && locBudgets.enabled !== false && budgetRules.length > 0;

  if (budgetsEnabled) {
    const measured = collectBudgetFiles('.', budgetRules);
    const results = evaluateLocBudgets(measured, budgetRules, {
      warn: locBudgets!.defaultWarn,
      fail: locBudgets!.defaultFail,
    });
    const failed = results.filter(r => r.status === 'fail');
    const warned = results.filter(r => r.status === 'warn');

    if (failed.length > 0) {
      // Over the fail ceiling → WARN (doctor fails CI on any WARN in --ci mode).
      checks.push({
        name: 'source loc budget',
        status: 'WARN',
        details: `${failed.length} file(s) over their fail ceiling:\n    ${failed.map(r => r.message).join('\n    ')}`,
      });
    } else if (warned.length > 0) {
      // Over the warn ceiling only → advisory INFO (does not break CI).
      checks.push({
        name: 'source loc budget',
        status: 'INFO',
        details: `${warned.length} file(s) over their warn ceiling (advisory):\n    ${warned.map(r => r.message).join('\n    ')}`,
      });
    } else {
      checks.push({
        name: 'source loc budget',
        status: 'PASS',
        details: `${results.length} file(s) within configured source LOC budgets.`,
      });
    }
  } else if (manifestLocMetricCount === 0) {
    // No runtime LOC coverage from either source → soft, non-blocking nudge.
    // Intentionally INFO, not WARN: doctor fails CI on any WARN, and emitting
    // a warning here would break every repo that hasn't opted in yet (#186).
    checks.push({
      name: 'source loc budget',
      status: 'INFO',
      details: 'No runtime source LOC coverage configured. Only ADF entry_loc (if declared) is enforced, so other files can grow into god-objects unchecked. Add a `locBudgets` block to .charter/config.json to set per-path warn/fail ceilings.',
    });
  }

  // Package ecosystem check (#90): verify enabled packages are installed.
  // Charter does not maintain a hard-coded registry — it only checks that
  // packages listed in config.packages are resolvable in node_modules.
  const pkgEntries = Object.entries(config.packages ?? {}).filter(([, v]) => v.enabled);
  if (pkgEntries.length > 0) {
    const missing: string[] = [];
    for (const [pkgName] of pkgEntries) {
      try {
        require.resolve(pkgName, { paths: [process.cwd()] });
      } catch {
        missing.push(pkgName);
      }
    }
    checks.push({
      name: 'packages',
      status: missing.length > 0 ? 'WARN' : 'PASS',
      details: missing.length > 0
        ? `Enabled package(s) not installed: ${missing.join(', ')}. Run: npm install ${missing.join(' ')}`
        : `${pkgEntries.length} enabled package(s) installed.`,
    });
  }

  const hasWarn = checks.some((check) => check.status === 'WARN');
  const result: DoctorResult = {
    status: hasWarn ? 'WARN' : 'PASS',
    checks,
  };

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`  Doctor status: ${result.status}`);
    for (const check of result.checks) {
      const icon = check.status === 'PASS' ? '[ok]' : check.status === 'INFO' ? '[info]' : '[warn]';
      console.log(`  ${icon} ${check.name}: ${check.details}`);
    }
  }

  if (options.ciMode && hasWarn) {
    return EXIT_CODE.POLICY_VIOLATION;
  }

  return EXIT_CODE.SUCCESS;
}

/**
 * Walk the repo and measure line counts for files matching any LOC budget rule.
 * Skips the same heavy/managed directories as the security-test walk. Paths are
 * returned repo-relative with forward slashes so they match POSIX-style patterns.
 */
function collectBudgetFiles(
  rootPath: string,
  rules: LocBudgetRule[],
): Array<{ path: string; lines: number }> {
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'coverage', '.ai', '.charter', '.pnpm-store']);
  const out: Array<{ path: string; lines: number }> = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = (path.relative(rootPath, fullPath) || entry.name).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          walk(fullPath);
        }
        continue;
      }

      if (entry.isFile() && rules.some(r => matchPath(relPath, r.pattern))) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          out.push({ path: relPath, lines: content.split('\n').length });
        } catch {
          // Skip unreadable files.
        }
      }
    }
  }

  walk(rootPath);
  return out;
}

function findSecurityTestFiles(rootPath: string): string[] {
  const matches: string[] = [];
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'coverage', '.ai', '.charter']);

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(rootPath, fullPath) || entry.name;
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          walk(fullPath);
        }
        continue;
      }

      if (entry.isFile() && /^(security|l4)/i.test(entry.name) && isTestLikePath(relPath)) {
        matches.push(relPath);
      }
    }
  }

  walk(rootPath);
  return matches.sort();
}

function isTestLikePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/test/')
    || normalized.includes('/tests/')
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized);
}


function validateJSONConfig(configFile: string): DoctorResult['checks'][number] {
  try {
    JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    return {
      name: 'config parse',
      status: 'PASS',
      details: 'config.json is valid JSON.',
    };
  } catch {
    return {
      name: 'config parse',
      status: 'WARN',
      details: 'config.json is invalid JSON.',
    };
  }
}

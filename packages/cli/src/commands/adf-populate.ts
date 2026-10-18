/**
 * charter adf populate
 *
 * Auto-fills ADF context files from codebase signals:
 * package.json, README.md, and stack detection.
 *
 * Replaces scaffold placeholder content with project-specific context.
 * Skips sections that have already been customized (unless --force): a section
 * counts as untouched only while it is exactly its template content (#354).
 * Edits are made in place, keeping every other byte of the file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAdf } from '@stackbilt/adf';
import type { AdfSection, PatchOperation } from '@stackbilt/adf';
import { applyOpsAsText, type TextPatchOperation } from './adf-text-patch';
import { BACKEND_SCAFFOLD, CORE_SCAFFOLD, FRONTEND_SCAFFOLD, STATE_SCAFFOLD } from './adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import {
  loadPackageContexts,
  detectStack,
  inferProjectName,
  type PackageContext,
  type DetectionResult,
} from './setup';

// ============================================================================
// Untouched scaffold detection
// ============================================================================

/**
 * The template a populated section starts from, per file. A section is filled
 * only while it is absent, empty, or still exactly this template content (#354):
 * one line of the user's own, anywhere in it, means hands off. Lines are compared
 * trimmed, ignoring blank lines.
 */
function templateSection(file: string, key: string): AdfSection | undefined {
  const template: Record<string, string> = {
    'core.adf': CORE_SCAFFOLD,
    'state.adf': STATE_SCAFFOLD,
    'backend.adf': BACKEND_SCAFFOLD,
    'frontend.adf': FRONTEND_SCAFFOLD,
  };
  const text = template[path.basename(file)];
  return text === undefined ? undefined : parseAdf(text).sections.find(s => s.key === key);
}

function normalized(section: AdfSection): string[] {
  return sectionText(section).split('\n').map(l => l.trim()).filter(l => l !== '');
}

/**
 * CONSTRAINTS gets stack bullets only while it is untouched (#371): the
 * template's bullets, in order, followed by nothing but bullets populate itself
 * added (`added`, from the populate record; each at most once, any order).
 * Unlike CONTEXT, an empty section does not count as untouched: emptying
 * CONSTRAINTS means the defaults were deleted, and a deleted default counts as an
 * edit (#354 Q3). Only the bullets are compared, not the header's weight or
 * decoration.
 */
export function isTemplateConstraints(section: AdfSection, file: string, added: readonly string[] = []): boolean {
  if (section.content.type !== 'list') return false;
  const template = templateSection(file, section.key);
  if (!template) return false;
  const want = normalized(template);
  const lines = normalized(section);
  if (lines.length < want.length || want.some((l, i) => lines[i] !== l)) return false;
  const rest = lines.slice(want.length).map(normalizeValue);
  const own = new Set(added.map(normalizeValue));
  return rest.every(l => own.has(l)) && new Set(rest).size === rest.length;
}

export function isUntouchedScaffold(section: AdfSection, file: string): boolean {
  const lines = normalized(section);
  if (lines.length === 0) return true;
  const template = templateSection(file, section.key);
  if (!template) return false;
  const want = normalized(template);
  return lines.length === want.length && lines.every((l, i) => l === want[i]);
}

function sectionText(section: AdfSection): string {
  switch (section.content.type) {
    case 'list': return section.content.items.join('\n');
    case 'text': return section.content.value;
    case 'map': return section.content.entries.map(e => `${e.key}: ${e.value}`).join('\n');
    default: return '';
  }
}

// ============================================================================
// Command Entry
// ============================================================================

/**
 * 'force' replaces CONTEXT/STATE even when customized, and adds missing stack
 * CONSTRAINTS bullets to any list section; 'scaffold-only' replaces only sections
 * that still hold scaffold text, and adds stack CONSTRAINTS only to an untouched
 * section, never one recorded in .ai/.populate.json (#371). The CLI picks 'force' under
 * --force or --yes. `charter bootstrap` passes 'scaffold-only' explicitly, so its
 * own --yes never re-enables force (#354).
 */
export type PopulateMode = 'scaffold-only' | 'force';

export interface PopulateResult {
  file: string;
  ops: number;
  /** 'skipped': nothing to do. 'refused': edits were due but could not be applied safely (see reason). */
  status: 'populated' | 'skipped' | 'refused' | 'missing';
  /**
   * Why a file with pending operations was left as is, or (on any status) why
   * part of it was: e.g. stack constraints not added to an edited CONSTRAINTS (#371).
   */
  reason?: string;
  /** One line per applied operation, e.g. "Filled CONTEXT". */
  changes?: string[];
  /** Stack constraints detected but not added, and why (#371). Each is reported once, then recorded as offered. */
  notAdded?: ConstraintsNotAdded;
}

export interface ConstraintsNotAdded {
  section: 'CONSTRAINTS';
  /** 'edited': the section differs from the template; 'not-a-list': it holds text; 'removed': it was deleted after populate recorded it. */
  why: 'edited' | 'not-a-list' | 'removed';
  constraints: string[];
}

// ============================================================================
// Populate record (.ai/.populate.json, #371)
// ============================================================================

/**
 * What populate has added to, or offered for, each file's CONSTRAINTS. Without
 * it, a section holding the template plus the one bullet populate added looks,
 * once the user deletes that bullet, exactly like a fresh scaffold. Committed
 * with the rest of `.ai/`, so the memory travels with the repo.
 */
export interface PopulateRecord {
  version: 1;
  constraints: Record<string, { added: string[]; offered: string[] }>;
}

export const POPULATE_RECORD_FILE = '.populate.json';

type RecordRead = { status: 'absent' | 'ok'; record: PopulateRecord } | { status: 'invalid'; record: PopulateRecord; detail: string };

function emptyRecord(): PopulateRecord {
  return { version: 1, constraints: {} };
}

function readPopulateRecord(file: string): RecordRead {
  if (!fs.existsSync(file)) return { status: 'absent', record: emptyRecord() };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<PopulateRecord>;
    if (raw?.version !== 1 || typeof raw.constraints !== 'object' || raw.constraints === null) {
      return { status: 'invalid', record: emptyRecord(), detail: 'not a version 1 record' };
    }
    const constraints: PopulateRecord['constraints'] = {};
    for (const [key, entry] of Object.entries(raw.constraints)) {
      const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(normalizeValue) : [];
      constraints[key] = { added: list(entry?.added), offered: list(entry?.offered) };
    }
    return { status: 'ok', record: { version: 1, constraints } };
  } catch (err) {
    return { status: 'invalid', record: emptyRecord(), detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Deterministic: keys and lists sorted, lists de-duplicated, two-space indent, trailing newline. */
export function serializePopulateRecord(record: PopulateRecord): string {
  const sorted = (xs: string[]): string[] => [...new Set(xs)].sort();
  const constraints: PopulateRecord['constraints'] = {};
  for (const key of Object.keys(record.constraints).sort()) {
    const e = record.constraints[key];
    constraints[key] = { added: sorted(e.added), offered: sorted(e.offered) };
  }
  return JSON.stringify({ version: 1, constraints }, null, 2) + '\n';
}

/** Constraint bookkeeping for one file, filled by buildCoreOps and committed once its edit is applied. */
interface ConstraintLedger {
  /** The file's entry in the record, or undefined when the record has none for it. */
  recorded?: { added: string[]; offered: string[] };
  add: string[];
  offer: string[];
  notAdded?: ConstraintsNotAdded;
}

/**
 * Generated values (package.json description, README summary, ...) become ADF
 * list items or map values, which the parser reads as one trimmed line. Strip
 * control characters and collapse whitespace and newlines to single spaces, so
 * every value round-trips and the re-parse guard can accept it (#354).
 */
export function normalizeValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeOps(ops: TextPatchOperation[]): TextPatchOperation[] {
  return ops.map(op => {
    if (op.op === 'ADD_BULLET') return { ...op, value: normalizeValue(op.value) };
    if (op.op !== 'REPLACE_SECTION' && op.op !== 'ADD_SECTION') return op;
    const c = op.content;
    const content = c.type === 'list'
      ? { type: 'list' as const, items: c.items.map(normalizeValue).filter(i => i !== '') }
      : c.type === 'map'
        ? { type: 'map' as const, entries: c.entries.map(e => ({ key: e.key, value: normalizeValue(e.value) })) }
        : c;
    return { ...op, content };
  }).filter(op => op.op !== 'ADD_BULLET' || op.value !== '');
}

function describeOp(op: TextPatchOperation): string {
  if (op.op === 'ADD_BULLET') return `Added ${op.section} item: ${op.value}`;
  if (op.op === 'REPLACE_SECTION' || op.op === 'ADD_SECTION') return `Filled ${op.key}`;
  return op.op;
}

export async function adfPopulateCommand(
  options: CLIOptions,
  args: string[],
  internal: { mode?: PopulateMode; embedded?: boolean; report?: (results: PopulateResult[]) => void } = {},
): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const mode: PopulateMode = internal.mode ?? (options.yes || args.includes('--force') ? 'force' : 'scaffold-only');
  const force = mode === 'force';
  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const manifestPath = path.join(aiDir, 'manifest.adf');

  if (!fs.existsSync(manifestPath)) {
    throw new CLIError(`manifest.adf not found at ${manifestPath}. Run 'charter adf init' first.`);
  }

  // Gather codebase signals
  const contexts = loadPackageContexts();
  const detection = detectStack(contexts);
  const projectName = inferProjectName(contexts) || path.basename(process.cwd());
  const rootPkg = readRootPackageJson();
  const description = rootPkg?.description;
  const readmeSummary = readReadmeSummary();

  const results: PopulateResult[] = [];

  const recordPath = path.join(aiDir, POPULATE_RECORD_FILE);
  const recordRead = readPopulateRecord(recordPath);
  const record = recordRead.record;
  const ledgers = new Map<string, ConstraintLedger>();
  const ledgerFor = (file: string): ConstraintLedger => {
    const key = path.basename(file);
    if (!ledgers.has(key)) ledgers.set(key, { recorded: record.constraints[key], add: [], offer: [] });
    return ledgers.get(key)!;
  };

  const fileTasks: Array<{ file: string; build: (notes: string[]) => TextPatchOperation[] | null }> = [
    {
      file: path.join(aiDir, 'core.adf'),
      build: notes => buildCoreOps(aiDir, projectName, description, readmeSummary, detection, contexts, force, notes, ledgerFor('core.adf')),
    },
    {
      file: path.join(aiDir, 'state.adf'),
      build: () => buildStateOps(aiDir, detection, force),
    },
    {
      file: path.join(aiDir, 'backend.adf'),
      build: () => buildBackendOps(aiDir, detection, force),
    },
    {
      file: path.join(aiDir, 'frontend.adf'),
      build: () => buildFrontendOps(aiDir, detection, force),
    },
  ];

  for (const task of fileTasks) {
    if (!fs.existsSync(task.file)) {
      results.push({ file: task.file, ops: 0, status: 'missing' });
      continue;
    }

    const notes: string[] = [];
    const built = task.build(notes);
    const ledger = ledgers.get(path.basename(task.file));
    const note = {
      ...(notes.length > 0 ? { reason: notes.join('; ') } : {}),
      ...(ledger?.notAdded ? { notAdded: ledger.notAdded } : {}),
    };
    const ops = built ? normalizeOps(built) : null;
    if (!ops || ops.length === 0) {
      results.push({ file: task.file, ops: 0, status: 'skipped', ...note });
      continue;
    }

    // Edit in place (#354): only the affected lines change; a result that does not
    // re-parse as exactly the intended change is not written.
    const edit = applyOpsAsText(fs.readFileSync(task.file, 'utf-8'), ops);
    if (edit.status === 'refused') {
      // Nothing was written, so nothing is recorded as added or offered.
      if (ledger) { ledger.add = []; ledger.offer = []; }
      results.push({ file: task.file, ops: 0, status: 'refused', reason: `could not be edited in place: ${edit.detail}` });
      continue;
    }
    if (!dryRun) fs.writeFileSync(task.file, edit.next);

    results.push({ file: task.file, ops: ops.length, status: 'populated', changes: ops.map(describeOp), ...note });
  }

  // The record changes only when something was added or offered, so a run with
  // nothing to do leaves .populate.json untouched, byte for byte.
  const recordRow = updatePopulateRecord(recordPath, recordRead, ledgers, dryRun);
  if (recordRow) results.push(recordRow);

  internal.report?.(results);

  if (internal.embedded) {
    // Called by bootstrap, which renders `results` itself; its own JSON report
    // is the only document on stdout.
  } else if (options.format === 'json') {
    console.log(JSON.stringify({
      dryRun,
      projectName,
      detection: {
        preset: detection.suggestedPreset,
        confidence: detection.confidence,
        runtime: detection.runtime,
        frameworks: detection.frameworks,
      },
      results,
    }, null, 2));
  } else {
    const prefix = dryRun ? '[dry-run] ' : '';
    console.log(`  ${prefix}ADF context populated from codebase signals:`);
    console.log(`    Project: ${projectName}${description ? ' — ' + description : ''}`);
    console.log(`    Stack: ${detection.suggestedPreset} (${detection.confidence} confidence)`);
    if (detection.frameworks.length > 0) {
      console.log(`    Frameworks: ${detection.frameworks.join(', ')}`);
    }
    console.log('');
    for (const r of results) {
      if (r.status === 'missing') continue;
      const icon = r.status === 'populated' ? '[ok]' : r.status === 'refused' ? '[refused]' : '[skip]';
      const detail = r.status === 'populated' && r.ops === 0
        ? (r.changes ?? []).join('; ')
        : r.status === 'populated'
        ? `${r.ops} op${r.ops === 1 ? '' : 's'} applied${r.reason ? `; ${r.reason}` : ''}`
        : r.reason ?? 'already customized — use --force to overwrite';
      console.log(`    ${icon} ${r.file}  (${detail})`);
    }
    if (dryRun) {
      console.log('');
      console.log('  Run without --dry-run to apply.');
    }
  }

  return EXIT_CODE.SUCCESS;
}

function updatePopulateRecord(
  file: string,
  read: RecordRead,
  ledgers: Map<string, ConstraintLedger>,
  dryRun: boolean,
): PopulateResult | null {
  const pending = [...ledgers].filter(([, l]) => l.add.length > 0 || l.offer.length > 0);
  if (pending.length === 0) return null;
  if (read.status === 'invalid') {
    return {
      file, ops: 0, status: 'refused',
      reason: `could not be read (${read.detail}); left as is, so this run's stack constraints are not recorded`,
    };
  }
  const next: PopulateRecord = JSON.parse(JSON.stringify(read.record));
  for (const [key, l] of pending) {
    const entry = (next.constraints[key] ??= { added: [], offered: [] });
    entry.added.push(...l.add.map(normalizeValue));
    entry.offered.push(...l.offer.map(normalizeValue));
  }
  const text = serializePopulateRecord(next);
  if (read.status === 'ok' && fs.readFileSync(file, 'utf-8') === text) return null;
  if (!dryRun) fs.writeFileSync(file, text);
  const label = file.split(path.sep).join('/');
  return { file, ops: 0, status: 'populated', changes: [`${read.status === 'absent' ? 'Created' : 'Updated'} ${label}`] };
}

// ============================================================================
// core.adf ops
// ============================================================================

function buildCoreOps(
  aiDir: string,
  projectName: string,
  description: string | undefined,
  readmeSummary: string | undefined,
  detection: DetectionResult,
  contexts: PackageContext[],
  force: boolean,
  notes: string[],
  ledger: ConstraintLedger,
): TextPatchOperation[] | null {
  const filePath = path.join(aiDir, 'core.adf');
  const input = fs.readFileSync(filePath, 'utf-8');
  const doc = parseAdf(input);
  const ops: TextPatchOperation[] = [];

  // Build CONTEXT items from signals
  const contextItems: string[] = [
    `project: ${projectName}${description ? ' — ' + description : ''}`,
  ];
  if (readmeSummary) contextItems.push(readmeSummary);
  if (detection.runtime.length > 0) contextItems.push(`runtime: ${detection.runtime.join(', ')}`);
  if (detection.frameworks.length > 0) contextItems.push(`stack: ${detection.frameworks.join(', ')}`);
  if (detection.monorepo) contextItems.push('monorepo: true');

  const contextSection = doc.sections.find(s => s.key === 'CONTEXT');
  if (!contextSection) {
    ops.push({
      op: 'ADD_SECTION',
      key: 'CONTEXT',
      decoration: '\u{1F4CB}',
      content: { type: 'list', items: contextItems },
    });
  } else if (force || isUntouchedScaffold(contextSection, filePath)) {
    ops.push({
      op: 'REPLACE_SECTION',
      key: 'CONTEXT',
      content: { type: 'list', items: contextItems },
    });
  }

  // Stack-specific constraints (#371). Additive only, and only into a CONSTRAINTS
  // the user has not edited: missing (and never recorded), or the template's
  // bullets plus any of the bullets populate itself added earlier. A constraint
  // populate has added or offered before is never added again, even after it was
  // deleted. Under --force, any constraint not present is appended, as before.
  const constraintsSection = doc.sections.find(s => s.key === 'CONSTRAINTS');
  const existingItems = constraintsSection?.content.type === 'list' ? constraintsSection.content.items : [];
  const recorded = ledger.recorded;
  const known = new Set([...(recorded?.added ?? []), ...(recorded?.offered ?? [])]);
  const wanted: string[] = [];
  const addConstraint = (value: string, matchFn: (item: string) => boolean) => {
    if (existingItems.some(matchFn)) return;
    if (!force && known.has(normalizeValue(value))) return;
    wanted.push(value);
  };

  // ESM import extensions: gated on TypeScript's moduleResolution, not on
  // package.json `type` (#294). Every ESM package must agree that extensions
  // are required before the rule is emitted — one bundler package vetoes it.
  const esmSignals = contexts
    .filter(ctx => readJsonFile(path.resolve(ctx.source))?.type === 'module')
    .map(ctx => esmExtensionSignal(ctx, contexts));
  const requiresEsmExtensions =
    esmSignals.includes('required') && !esmSignals.includes('not-required');
  if (requiresEsmExtensions) {
    addConstraint(
      'Use .js extensions for all ESM imports (never .ts in import paths)',
      item => item.includes('.js extensions') || (item.includes('ESM') && item.includes('import'))
    );
  }

  if (detection.signals.hasCloudflare) {
    addConstraint(
      'No Node.js-specific APIs in Worker handlers; use CF-native APIs (fetch, KV, D1, R2)',
      item => item.includes('Worker handler') || (item.includes('Node') && item.includes('CF'))
    );
  }

  if (detection.signals.hasPnpm && detection.monorepo) {
    addConstraint(
      'Internal packages use pnpm workspace:^ protocol, never relative paths',
      item => item.includes('workspace') || (item.includes('pnpm') && item.includes('package'))
    );
  }

  if (wanted.length === 0) return ops.length > 0 ? ops : null;

  const offer = (why: ConstraintsNotAdded['why']) => {
    const state = why === 'removed' ? 'was removed' : why === 'not-a-list' ? 'is not a list' : 'has been edited';
    const values = wanted.map(normalizeValue);
    notes.push(
      `CONSTRAINTS ${state}, so populate did not add the stack constraint${values.length === 1 ? '' : 's'}: `
      + `${values.join(' | ')}. Add ${values.length === 1 ? 'it' : 'them'} by hand if you want ${values.length === 1 ? 'it' : 'them'}`,
    );
    ledger.notAdded = { section: 'CONSTRAINTS', why, constraints: values };
    ledger.offer.push(...values);
  };

  if (!constraintsSection) {
    // Recreated only while populate has no record for this file: a recorded file
    // whose CONSTRAINTS is gone had it deleted on purpose.
    if (recorded && !force) {
      offer('removed');
    } else {
      ops.push({
        op: 'ADD_SECTION',
        key: 'CONSTRAINTS',
        decoration: '\u26A0', // as parsed; the text edit writes it as the scaffold's U+26A0 U+FE0F
        weight: 'load-bearing',
        content: { type: 'list', items: wanted },
        // Where the scaffold has it: after CONTEXT, else after GUIDE, else before METRICS.
        anchor: { after: ['CONTEXT', 'GUIDE'], before: ['METRICS'] },
      });
      ledger.add.push(...wanted);
    }
    return ops.length > 0 ? ops : null;
  }

  // An emptied section parses as empty text, not as an empty list.
  const empty = normalized(constraintsSection).length === 0;
  const appendable = constraintsSection.content.type === 'list' && existingItems.length > 0;
  if (appendable && (force || isTemplateConstraints(constraintsSection, filePath, recorded?.added ?? []))) {
    for (const value of wanted) ops.push({ op: 'ADD_BULLET', section: 'CONSTRAINTS', value });
    ledger.add.push(...wanted);
  } else if (force && empty) {
    // No bullet to append after; --force fills the empty section.
    ops.push({ op: 'REPLACE_SECTION', key: 'CONSTRAINTS', content: { type: 'list', items: wanted } });
    ledger.add.push(...wanted);
  } else {
    offer(appendable || empty ? 'edited' : 'not-a-list');
  }

  return ops.length > 0 ? ops : null;
}

// ============================================================================
// ESM extension detection (#294)
// ============================================================================

/**
 * Whether relative ESM imports in a package need an explicit `.js` extension.
 *
 * 'unknown' means "could not tell" and never produces a rule: the constraint
 * lands under CONSTRAINTS [load-bearing], where a wrong entry tells agents to
 * rewrite correct code.
 */
type EsmExtensionSignal = 'required' | 'not-required' | 'unknown';

/** moduleResolution (or the `module` value that implies it) that needs extensions. */
const EXTENSION_REQUIRING_RESOLUTION = new Set(['node16', 'nodenext']);

/** Only one level of `extends` is followed; a full resolver is out of scope. */
const MAX_EXTENDS_DEPTH = 1;

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // Missing, unreadable, or JSONC (comments/trailing commas) that JSON.parse
    // rejects. All resolve to 'unknown' at the call site.
    return null;
  }
}

/**
 * package.json `type: "module"` says nothing about import extensions — a Vite
 * app is ESM with `moduleResolution: "bundler"`, where extensionless relative
 * imports are the correct convention. TypeScript's moduleResolution is the
 * signal that actually decides it.
 */
function esmExtensionSignal(ctx: PackageContext, contexts: PackageContext[]): EsmExtensionSignal {
  const packageDir = path.resolve(path.dirname(ctx.source));
  const candidates = [path.join(packageDir, 'tsconfig.json')];
  if (packageDir !== path.resolve('.')) candidates.push(path.resolve('tsconfig.json'));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return readModuleResolution(candidate, 0);
  }

  // No tsconfig anywhere: native Node ESM does require extensions, but only
  // claim that when TypeScript is not in play at all.
  return usesTypeScript(ctx, contexts) ? 'unknown' : 'required';
}

function readModuleResolution(tsconfigPath: string, depth: number): EsmExtensionSignal {
  const config = readJsonFile(tsconfigPath);
  if (!config) return 'unknown';

  const compilerOptions = config.compilerOptions as Record<string, unknown> | undefined;
  // `module: node16|nodenext` implies the matching moduleResolution in TS.
  const declared = compilerOptions?.moduleResolution ?? compilerOptions?.module;
  if (typeof declared === 'string') {
    return EXTENSION_REQUIRING_RESOLUTION.has(declared.toLowerCase()) ? 'required' : 'not-required';
  }

  // Array `extends` (TS 5.0+) and bare package names (@tsconfig/node20,
  // astro/tsconfigs/strict) are not resolved; neither are project references.
  const extendsPath = config.extends;
  if (depth >= MAX_EXTENDS_DEPTH || typeof extendsPath !== 'string') return 'unknown';
  if (!extendsPath.startsWith('.') && !path.isAbsolute(extendsPath)) return 'unknown';

  const resolved = path.resolve(path.dirname(tsconfigPath), extendsPath);
  const basePath = fs.existsSync(resolved) ? resolved : `${resolved}.json`;
  if (!fs.existsSync(basePath)) return 'unknown';
  return readModuleResolution(basePath, depth + 1);
}

/**
 * Deliberately bounded: only the package itself and the repo root are consulted.
 * A monorepo confining `typescript` to a sibling outside the scanned set reports
 * false here. That is reachable only when no tsconfig exists anywhere in the
 * scanned tree, which is already the weakest branch; widening the search would
 * cost more false negatives than it prevents.
 */
function usesTypeScript(ctx: PackageContext, contexts: PackageContext[]): boolean {
  const root = contexts.find(c => c.source === 'package.json');
  return [ctx, root].some(c =>
    Boolean(c?.dependencies?.typescript || c?.devDependencies?.typescript)
  );
}

// ============================================================================
// state.adf ops
// ============================================================================

function buildStateOps(
  aiDir: string,
  detection: DetectionResult,
  force: boolean
): PatchOperation[] | null {
  const filePath = path.join(aiDir, 'state.adf');
  const input = fs.readFileSync(filePath, 'utf-8');
  const doc = parseAdf(input);

  const stateSection = doc.sections.find(s => s.key === 'STATE');
  if (!stateSection) return null;
  if (!force && !isUntouchedScaffold(stateSection, filePath)) return null;

  const stackSummary = [
    ...detection.runtime,
    ...detection.frameworks,
  ].join(', ') || detection.suggestedPreset;

  return [{
    op: 'REPLACE_SECTION',
    key: 'STATE',
    content: {
      type: 'map',
      entries: [
        { key: 'CURRENT', value: `Charter initialized — ${stackSummary} project` },
        { key: 'NEXT', value: 'Author project-specific constraints in core.adf' },
      ],
    },
  }];
}

// ============================================================================
// backend.adf ops
// ============================================================================

function buildBackendOps(
  aiDir: string,
  detection: DetectionResult,
  force: boolean
): PatchOperation[] | null {
  const filePath = path.join(aiDir, 'backend.adf');
  if (!fs.existsSync(filePath)) return null;

  const input = fs.readFileSync(filePath, 'utf-8');
  const doc = parseAdf(input);

  const contextSection = doc.sections.find(s => s.key === 'CONTEXT');
  if (contextSection && !force && !isUntouchedScaffold(contextSection, filePath)) return null;

  const items: string[] = [];
  if (detection.signals.hasWorker || detection.signals.hasCloudflare) {
    items.push('Cloudflare Workers edge runtime (wrangler deploy)');
  }
  if (detection.signals.hasHono) {
    items.push('Hono for route composition — typed, lightweight, edge-compatible');
  }
  if (!detection.signals.hasWorker && detection.signals.hasBackend) {
    items.push('Node.js backend service with typed request boundaries');
  }
  if (items.length === 0) {
    items.push('Backend module — add service/API/database constraints and rules');
  }

  const op: PatchOperation = contextSection
    ? { op: 'REPLACE_SECTION', key: 'CONTEXT', content: { type: 'list', items } }
    : { op: 'ADD_SECTION', key: 'CONTEXT', decoration: '\u{1F4CB}', content: { type: 'list', items } };

  return [op];
}

// ============================================================================
// frontend.adf ops
// ============================================================================

function buildFrontendOps(
  aiDir: string,
  detection: DetectionResult,
  force: boolean
): PatchOperation[] | null {
  const filePath = path.join(aiDir, 'frontend.adf');
  if (!fs.existsSync(filePath)) return null;

  const input = fs.readFileSync(filePath, 'utf-8');
  const doc = parseAdf(input);

  const contextSection = doc.sections.find(s => s.key === 'CONTEXT');
  if (contextSection && !force && !isUntouchedScaffold(contextSection, filePath)) return null;

  const items: string[] = [];
  if (detection.signals.hasReact) items.push('React component model (hooks-based, no class components)');
  if (detection.signals.hasVite) items.push('Vite for build tooling and dev server');
  if (items.length === 0) {
    items.push('Frontend module — add framework-specific constraints and rules');
  }

  const op: PatchOperation = contextSection
    ? { op: 'REPLACE_SECTION', key: 'CONTEXT', content: { type: 'list', items } }
    : { op: 'ADD_SECTION', key: 'CONTEXT', decoration: '\u{1F4CB}', content: { type: 'list', items } };

  return [op];
}

// ============================================================================
// Helpers
// ============================================================================

function readRootPackageJson(): { name?: string; description?: string; type?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function readReadmeSummary(): string | undefined {
  for (const name of ['README.md', 'readme.md', 'Readme.md']) {
    try {
      const content = fs.readFileSync(path.resolve(name), 'utf-8');
      const lines = content.split('\n');
      let inParagraph = false;
      const paragraphLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith('#')) continue;
        if (line.trim() === '') {
          if (inParagraph) break;
          continue;
        }
        inParagraph = true;
        paragraphLines.push(line.trim());
        if (paragraphLines.length >= 2) break;
      }

      if (paragraphLines.length > 0) {
        const summary = paragraphLines.join(' ');
        return summary.length > 120 ? summary.slice(0, 117) + '...' : summary;
      }
    } catch { /* file not found */ }
  }
  return undefined;
}

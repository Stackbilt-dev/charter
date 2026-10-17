/**
 * Shared scaffold write engine for `charter bootstrap` phase 3 and
 * `charter adf init` (#354, #370).
 *
 * Three modes, one loop:
 *   skip   — create missing scaffold files; never touch an existing one
 *   merge  — also append missing whole sections and register missing template
 *            modules (append-only; existing bytes are never rewritten)
 *   reset  — replace each differing file with the template, after backing it
 *            up to `<aiDir>/.backup/`; a file whose backup fails is not replaced
 *
 * Callers pass the scaffold list, the manifest template and the command name
 * used in hint text, so each command keeps its own preset set and wording.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as crypto from 'node:crypto';
import type { CLIOptions } from '../index';
import { registerManifestModules } from './adf-manifest-register';
import { readVendorRecord, recordVendorModes } from './adf-vendor';
import {
  appendMissingSections,
  backupFile,
  computeLoss,
  describeMerge,
  dirLabel,
  formatLossLines,
  MANIFEST_EXCLUDED_KEYS,
  templateModules,
} from './adf-scaffold-merge';
import type { AddedModule, ScaffoldMode, ScaffoldOutcome } from './adf-scaffold-merge';

export interface ScaffoldSpec {
  name: string;
  content: string;
}

export interface ScaffoldWriteOptions {
  aiDir: string;
  mode: ScaffoldMode;
  /** The scaffold files, manifest.adf first. */
  scaffolds: ScaffoldSpec[];
  /** The manifest template the scaffold modules' placement and triggers come from. */
  manifestTemplate: string;
  /** Named in re-run hints, e.g. 'charter bootstrap' or 'charter adf init'. */
  command: string;
  /**
   * `.adf.lock` handling. 'hash': rewrite it with core/state hashes whenever they
   * differ (bootstrap). 'create-empty': write `{}` only when it is absent (adf init).
   */
  lock: 'hash' | 'create-empty';
}

export interface ScaffoldWriteResult {
  files: string[];
  warnings: string[];
  backedUp: number;
  /** One outcome per scaffold, in scaffold order. */
  scaffolds: ScaffoldOutcome[];
  /** Old text of each replaced file, for the loss report. */
  replacedText: Map<string, string>;
  lockExisted: boolean;
  lockWritten: boolean;
}

export type ResetConfirmation =
  | { kind: 'confirmed-by-yes' }
  /** No scaffold file exists that differs from the template: nothing to confirm (#373). */
  | { kind: 'nothing-to-replace' }
  | { kind: 'confirmed-by-prompt' }
  | { kind: 'declined-at-prompt'; exitCode: 1 }
  | { kind: 'refused-non-interactive'; exitCode: 1 };

/** Display prefix for files under `aiDir`: `.ai/` for the default directory. */
export function aiDirLabel(aiDir: string): string {
  return dirLabel(aiDir);
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function buildAdfLockContent(aiDir: string): string {
  const lockData: Record<string, string> = {};
  for (const mod of ['core.adf', 'state.adf']) {
    const modPath = path.join(aiDir, mod);
    if (!fs.existsSync(modPath)) continue;
    lockData[mod] = hashContent(fs.readFileSync(modPath, 'utf-8'));
  }
  return JSON.stringify(lockData, null, 2) + '\n';
}

/** The re-run hint for a scaffold the merge left as is. */
export function mergeSkipDetail(label: string, reason: 'unparseable' | 'guard', command: string): string {
  const why = reason === 'unparseable'
    ? 'could not be parsed'
    : 'could not be merged without changing its existing content (re-parse guard)';
  return `${label} ${why}; left as is. Fix it by hand, or run '${command} --reset-adf --yes' to replace it with the template (the old file is backed up first).`;
}

export function writeAdfScaffolds(opts: ScaffoldWriteOptions): ScaffoldWriteResult {
  const { aiDir, mode, scaffolds, manifestTemplate, command } = opts;
  fs.mkdirSync(aiDir, { recursive: true });

  const prefix = aiDirLabel(aiDir);
  const files: string[] = [];
  const warnings: string[] = [];
  const outcomes = new Map<string, ScaffoldOutcome>();
  const replacedText = new Map<string, string>();
  const createdThisRun = new Set<string>();
  let backedUp = 0;
  const backupDir = path.join(aiDir, '.backup');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const manifestName = 'manifest.adf';
  const manifestPath = path.join(aiDir, manifestName);

  // A reset replaces manifest.adf (backing it up), which would drop the VENDORS
  // record (#318). Its valid entries are carried over below, add-if-absent; under
  // skip or merge the record is never touched and the carry-over is a no-op.
  const priorRecord = readVendorRecord(manifestPath).recorded;

  for (const scaffold of scaffolds) {
    const targetPath = path.join(aiDir, scaffold.name);
    const label = `${prefix}${scaffold.name}`;

    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, scaffold.content);
      files.push(label);
      createdThisRun.add(scaffold.name);
      outcomes.set(scaffold.name, { kind: 'created', file: label });
      continue;
    }

    const existing = fs.readFileSync(targetPath, 'utf-8');
    if (existing.trim() === scaffold.content.trim()) {
      outcomes.set(scaffold.name, { kind: 'unchanged', file: label });
      continue;
    }

    if (mode === 'skip') {
      const detail = `${label} has custom content (${Buffer.byteLength(existing, 'utf-8')} bytes); skipping scaffold overwrite`;
      warnings.push(detail);
      outcomes.set(scaffold.name, { kind: 'skipped', file: label, reason: 'custom-content', detail });
      continue;
    }

    if (mode === 'merge') {
      // Append-only (#354): whole missing sections, never a line inside an existing one.
      const excluded = scaffold.name === manifestName ? MANIFEST_EXCLUDED_KEYS : [];
      const merged = appendMissingSections(existing, scaffold.content, excluded);
      if (merged.status === 'refused') {
        const detail = mergeSkipDetail(label, merged.reason, command);
        warnings.push(detail);
        outcomes.set(scaffold.name, { kind: 'skipped', file: label, reason: merged.reason, detail });
      } else if (merged.status === 'appended') {
        fs.writeFileSync(targetPath, merged.next);
        files.push(label);
        outcomes.set(scaffold.name, { kind: 'merged', file: label, addedSections: merged.added, addedModules: [] });
      } else {
        outcomes.set(scaffold.name, { kind: 'unchanged', file: label });
      }
      continue;
    }

    // --reset-adf: back up first; a file whose backup failed is not replaced (INV-4).
    let backupName: string;
    try {
      backupName = backupFile(targetPath, backupDir, scaffold.name, timestamp);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const detail = `Could not back up ${label} to ${prefix}.backup/ (${msg}); not replaced.`;
      warnings.push(detail);
      outcomes.set(scaffold.name, { kind: 'skipped', file: label, reason: 'backup-failed', detail });
      continue;
    }
    backedUp++;
    fs.writeFileSync(targetPath, scaffold.content);
    files.push(label);
    replacedText.set(label, existing);
    outcomes.set(scaffold.name, {
      kind: 'replaced',
      file: label,
      backupPath: `${prefix}.backup/${backupName}`,
      lost: computeLoss(existing, scaffold.content, scaffold.name === manifestName),
    });
  }

  // Template modules with no manifest entry are registered with the template's
  // triggers, never the stem fallback (CP-3). Append-only, through the shared writer.
  const manifestOutcome = outcomes.get(manifestName);
  const canRegister = manifestOutcome !== undefined
    && (manifestOutcome.kind !== 'skipped' || manifestOutcome.reason === 'custom-content');
  if (canRegister) {
    const moduleNames = scaffolds.map(s => s.name).filter(n => n !== manifestName);
    const planned = templateModules(manifestTemplate, moduleNames).map(m => ({
      module: m.module,
      loadPolicy: m.loadPolicy,
      triggers: m.triggers,
      reason: 'preset template module',
      status: 'planned' as const,
      triggerSources: [],
    }));
    const { registrations } = registerManifestModules(manifestPath, planned, { onWarning: w => warnings.push(w) });
    const added: AddedModule[] = registrations
      .filter(r => r.status === 'added')
      .map(r => ({ module: r.module, loadPolicy: r.loadPolicy, triggers: r.triggers, fileCreated: createdThisRun.has(r.module) }));
    const label = `${prefix}${manifestName}`;
    if (added.length > 0) {
      const prev = outcomes.get(manifestName);
      outcomes.set(manifestName, {
        kind: 'merged',
        file: label,
        addedSections: prev?.kind === 'merged' ? prev.addedSections : [],
        addedModules: added,
      });
      if (!files.includes(label)) files.push(label);
    } else if (outcomes.get(manifestName)?.kind === 'unchanged') {
      const skipped = registrations.find(r => r.status === 'skipped');
      if (skipped) {
        const reason = skipped.skipReason === 'section-not-list' ? 'not-a-list' : 'guard';
        outcomes.set(manifestName, { kind: 'skipped', file: label, reason, detail: `${label}: template modules were not registered (${skipped.skipReason})` });
      }
    }
  }

  const lockPath = path.join(aiDir, '.adf.lock');
  const lockExisted = fs.existsSync(lockPath);
  let lockWritten = false;
  if (opts.lock === 'hash') {
    const lockContent = buildAdfLockContent(aiDir);
    if (!lockExisted || fs.readFileSync(lockPath, 'utf-8') !== lockContent) {
      fs.writeFileSync(lockPath, lockContent);
      lockWritten = true;
    }
  } else if (!lockExisted) {
    fs.writeFileSync(lockPath, '{}\n');
    lockWritten = true;
  }
  if (lockWritten) files.push(`${prefix}.adf.lock`);

  if (priorRecord.size > 0) {
    const entries = [...priorRecord].sort((a, b) => a[1].index - b[1].index).map(([file, { mode: m }]) => ({ file, mode: m }));
    recordVendorModes(manifestPath, entries, 'add-if-absent', { onWarning: w => warnings.push(w) });
  }

  return {
    files,
    warnings,
    backedUp,
    scaffolds: scaffolds.map(s => outcomes.get(s.name)!),
    replacedText,
    lockExisted,
    lockWritten,
  };
}

/**
 * Recompute each replaced file's loss against the file as the whole run left
 * it, so content a later step put back (populate, orphan registration, the
 * VENDORS carry-over) is not reported as lost.
 */
export function finalizeLoss(outcomes: ScaffoldOutcome[], replacedText: Map<string, string>, manifestLabel: string): Array<Extract<ScaffoldOutcome, { kind: 'replaced' }>> {
  const replaced = outcomes.filter((o): o is Extract<ScaffoldOutcome, { kind: 'replaced' }> => o.kind === 'replaced');
  for (const o of replaced) {
    let finalText = '';
    try { finalText = fs.readFileSync(o.file, 'utf-8'); } catch { /* removed mid-run: everything is lost */ }
    o.lost = computeLoss(replacedText.get(o.file) ?? '', finalText, o.file === manifestLabel);
  }
  return replaced;
}

/** Scaffold files under `aiDir` that `--reset-adf` would replace: present and not already the template. */
export function filesResetWouldReplace(aiDir: string, scaffolds: ScaffoldSpec[]): string[] {
  const prefix = aiDirLabel(aiDir);
  return scaffolds
    .filter(s => {
      try {
        return fs.readFileSync(path.join(aiDir, s.name), 'utf-8').trim() !== s.content.trim();
      } catch {
        return false;
      }
    })
    .map(s => `${prefix}${s.name}`);
}

export function resetRefusalMessage(aiDir: string, scaffolds: ScaffoldSpec[]): string {
  const files = filesResetWouldReplace(aiDir, scaffolds);
  const prefix = aiDirLabel(aiDir);
  const list = files.length > 0 ? files.join(', ') : scaffolds.map(s => `${prefix}${s.name}`).join(', ');
  return `--reset-adf replaces ${list} with the preset template. ` +
    'Re-run with --reset-adf --yes to confirm, or use --force to merge instead. Nothing was written.';
}

export function resetDeclinedMessage(aiDir: string): string {
  return `Aborted; nothing was written. Re-run with --force to merge the template into ${aiDirLabel(aiDir)} instead.`;
}

/**
 * `--reset-adf` confirmation (#354): `--yes` confirms; an interactive text run
 * asks y/N after listing the files; anything else (CI, pipes, --format json)
 * is refused. Never waits on a non-TTY stdin. When no existing file differs
 * from the template (an empty or absent .ai/), there is nothing to replace and
 * nothing to confirm: the run goes ahead and only creates files.
 */
export async function confirmReset(options: CLIOptions, aiDir: string, scaffolds: ScaffoldSpec[]): Promise<ResetConfirmation> {
  if (options.yes) return { kind: 'confirmed-by-yes' };
  const files = filesResetWouldReplace(aiDir, scaffolds);
  if (files.length === 0) return { kind: 'nothing-to-replace' };
  if (!process.stdin.isTTY || options.format !== 'text') return { kind: 'refused-non-interactive', exitCode: 1 };
  console.log(`--reset-adf replaces these files with the preset template (each is backed up to ${aiDirLabel(aiDir)}.backup/ first):`);
  for (const f of files) console.log(`  ${f}`);
  return await promptYesNo('Replace them? (y/N) ')
    ? { kind: 'confirmed-by-prompt' }
    : { kind: 'declined-at-prompt', exitCode: 1 };
}

/**
 * The `--reset-adf` gate for a command with no other phases (adf init): asks
 * for confirmation and, on refusal, prints why (JSON payload `{ ...base,
 * resetAdf, message }`, or the message on stderr). Nothing is written either way.
 */
export async function gateReset(
  options: CLIOptions,
  aiDir: string,
  scaffolds: ScaffoldSpec[],
  base: Record<string, unknown>,
): Promise<{ confirmation: ResetConfirmation; refused: boolean }> {
  const confirmation = await confirmReset(options, aiDir, scaffolds);
  if (confirmation.kind !== 'declined-at-prompt' && confirmation.kind !== 'refused-non-interactive') {
    return { confirmation, refused: false };
  }
  const message = confirmation.kind === 'declined-at-prompt' ? resetDeclinedMessage(aiDir) : resetRefusalMessage(aiDir, scaffolds);
  if (options.format === 'json') console.log(JSON.stringify({ ...base, resetAdf: confirmation, message }, null, 2));
  else console.error(message);
  return { confirmation, refused: true };
}

/** A run's scaffold names split into written and not written (`.adf.lock` last), as adf init reports them. */
export function splitWritten(w: ScaffoldWriteResult, scaffolds: ScaffoldSpec[]): { written: string[]; notWritten: string[] } {
  const wrote = (o: ScaffoldOutcome): boolean => o.kind === 'created' || o.kind === 'merged' || o.kind === 'replaced';
  const written = scaffolds.filter((_s, i) => wrote(w.scaffolds[i])).map(s => s.name);
  const notWritten = scaffolds.filter((_s, i) => !wrote(w.scaffolds[i])).map(s => s.name);
  (w.lockWritten ? written : notWritten).push('.adf.lock');
  return { written, notWritten };
}

/**
 * Report a merge or reset run of a single-phase command (adf init) and return
 * its exit code: 1 when --reset-adf had files to replace and every backup failed.
 * Loss is measured against each file as the run left it.
 */
export function reportScaffoldRun(
  options: CLIOptions,
  base: Record<string, unknown>,
  mode: Exclude<ScaffoldMode, 'skip'>,
  w: ScaffoldWriteResult,
  aiDir: string,
  extras: { backupGitignore?: string; resetAdf?: ResetConfirmation },
  /** Text lines of other writes in the same run (adf init --emit-pointers), printed after the header. */
  laterLines: string[] = [],
): number {
  const prefix = aiDirLabel(aiDir);
  const replaced = finalizeLoss(w.scaffolds, w.replacedText, `${prefix}manifest.adf`);
  const notReset = w.scaffolds.filter(o => o.kind === 'skipped' && o.reason === 'backup-failed').map(o => o.file);
  if (options.format === 'json') {
    console.log(JSON.stringify({
      ...base, mode, scaffolds: w.scaffolds, warnings: w.warnings,
      replaced: replaced.map(o => ({ file: o.file, backup: o.backupPath })),
      ...(mode === 'reset' ? { notReset, ...extras } : {}),
    }, null, 2));
  } else {
    console.log(mode === 'merge'
      ? `  Merged the preset template into ${prefix} (--force):`
      : `  Reset ${prefix} to the preset template (--reset-adf); each backup holds what its file lost:`);
    for (const line of scaffoldReportLines(w.scaffolds, mode, w.replacedText)) console.log(line);
    if (w.lockWritten) console.log(`  Created ${prefix}.adf.lock`);
    for (const line of laterLines) console.log(line);
    for (const warning of w.warnings) console.log(`  Warning: ${warning}`);
  }
  return mode === 'reset' && notReset.length > 0 && replaced.length === 0 ? 1 : 0;
}

/** Text lines for a merge or reset run's outcomes; a replaced file is followed by its loss report. */
export function scaffoldReportLines(outcomes: ScaffoldOutcome[], mode: ScaffoldMode, replacedText: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const o of outcomes) {
    if (o.kind === 'created') lines.push(`  Created ${o.file}`);
    else if (o.kind === 'merged') lines.push(`  ${describeMerge(o)}`);
    else if (o.kind === 'unchanged') lines.push(mode === 'reset' ? `  Already the template: ${o.file}` : `  Unchanged by merge: ${o.file}`);
    else if (o.kind === 'replaced') {
      const loss = formatLossLines(o.lost, replacedText.get(o.file) ?? '');
      lines.push(`  Replaced ${o.file} (backup: ${o.backupPath})${loss.length === 0 ? ': nothing lost' : ''}`);
      for (const l of loss) lines.push(`    ${l}`);
    }
    // 'skipped' outcomes carry a warning, which the caller prints.
  }
  return lines;
}

/**
 * Prompt user for a yes/no answer via readline.
 */
export function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return Promise.resolve(false);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

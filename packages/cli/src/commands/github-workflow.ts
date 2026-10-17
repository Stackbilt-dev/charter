/**
 * `.github/workflows/charter-governance.yml`: refresh it only while it is a
 * file Charter generated whose refresh changes nothing CI may do (#374).
 *
 * `bootstrap --ci github` and `setup --ci github` overwrite the workflow
 * without `--force` only when it is a known Charter template marked `safe`
 * (the current npm or pnpm form). An older Charter template is kept, with a
 * warning that states what refreshing it changes; a workflow that matches no
 * Charter template is kept, with a warning that states what the current
 * template grants. No claim is made about what a hand edit changed: the YAML
 * is never diffed. `--force` replaces either after backing it up to
 * `.charter/.backup/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { backupFile, dirLabel, tryEnsureBackupGitignore } from './adf-scaffold-merge';

/** What the current template grants CI, in one line. A test checks it against the template. */
export const TEMPLATE_PERMISSIONS =
  'the current Charter template grants contents: write and pull-requests: write, runs on push, pull_request and workflow_dispatch, ' +
  'and has a step that commits and pushes to the repo';

/** What refreshing any pre-badge template (contents: read, pull_request only) to the current one changes. */
const PRE_BADGE_CHANGES = 'contents: read → write; adds push and workflow_dispatch triggers; adds a step that commits and pushes to the repo';

export interface KnownWorkflow {
  /** sha256 of the template after `normalizeWorkflow`. */
  hash: string;
  /** The first commit in setup.ts's history that generated it, and what set it apart. */
  origin: string;
  /** The package manager its install steps are for. */
  packageManager: 'npm' | 'pnpm';
  /** Whether refreshing it to the current template changes nothing CI may do. */
  safe: boolean;
  /** For an entry that is not safe: what refreshing it changes, shown as is in the warning. */
  refreshChanges: string;
}

/**
 * Every `charter-governance.yml` Charter has generated, recovered from the
 * history of `getGithubWorkflow` / `GITHUB_WORKFLOW` in setup.ts (each
 * template's npm and pnpm form). When the template changes, add the new
 * hashes (a test fails until the current ones are listed), mark the old ones
 * unsafe if the new template grants more, and describe the change by hand.
 */
export const KNOWN_WORKFLOWS: readonly KnownWorkflow[] = [
  { hash: '59b8380e5926f47656fb4870effe234090528bd9b1f0705d5e283e009e0ff225', origin: '003ec8d, current (score-badge steps)', packageManager: 'npm', safe: true, refreshChanges: '' },
  { hash: '1ff96c6454952dbc630b6cc079cd1fd7840f6b18673098bec030595968a302cd', origin: '003ec8d, current (score-badge steps)', packageManager: 'pnpm', safe: true, refreshChanges: '' },
  // Everything below ran on pull_request only, with contents: read.
  { hash: '38f58106b0dd4c9a0363d971bfd10c23f1a5067c1998224abd5ed9a70337f98f', origin: '0fdea60 (ADF wiring and evidence steps)', packageManager: 'npm', safe: false, refreshChanges: PRE_BADGE_CHANGES },
  { hash: '87c27e54791175c4a3937490b9f7f03f841269b6d01b1fe303352ab0ebb5748f', origin: '0fdea60 (ADF wiring and evidence steps)', packageManager: 'pnpm', safe: false, refreshChanges: PRE_BADGE_CHANGES },
  { hash: '35d3c37b5bb5cf7c2a8aa5eaf5d6c67fba2b2ae244473f9ee05220ac3a8b9c57', origin: '7ed4679 (npx charter)', packageManager: 'npm', safe: false, refreshChanges: PRE_BADGE_CHANGES },
  { hash: '351527f91d2d737cb1b639e52220fa6efdc91f82e588a4a124b889708a38d27b', origin: '9773577 (npx charter, pnpm form)', packageManager: 'pnpm', safe: false, refreshChanges: PRE_BADGE_CHANGES },
  { hash: '6e5d94d02eceff4601b8df3f2d3c223fc0faac09f4725397d9bb9aac2c5106a4', origin: '04b1442 (npm install -g @stackbilt/cli@<version>)', packageManager: 'npm', safe: false, refreshChanges: PRE_BADGE_CHANGES },
  { hash: '1c0be5478ab2bf8fdbbf60ce823a057d6eb6e486359e95438ac3e98ebe0e3969', origin: '490cd80 (npm install -g @stackbilt/cli)', packageManager: 'npm', safe: false, refreshChanges: PRE_BADGE_CHANGES },
  { hash: '9714db6011806c2350c1467cc0fdc1db48f67d848a96b5487abf8e4267d7fd6e', origin: 'e214ad0 (npm install -g @charter/cli, the first template)', packageManager: 'npm', safe: false, refreshChanges: PRE_BADGE_CHANGES },
];

const KNOWN_BY_HASH: ReadonlyMap<string, KnownWorkflow> = new Map(KNOWN_WORKFLOWS.map(k => [k.hash, k]));

const VERSION_PIN = /(@stackbilt\/cli@)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;

/**
 * The form workflows are compared in: no BOM, LF line endings, no trailing
 * whitespace on any line, exactly one final newline, and a pinned
 * `@stackbilt/cli@<version>` (only the 04b1442 template pinned one) replaced
 * by a placeholder, so any pin matches that template.
 */
export function normalizeWorkflow(text: string): string {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`.replace(VERSION_PIN, '$1{{CHARTER_VERSION}}');
}

export function workflowHash(text: string): string {
  return createHash('sha256').update(normalizeWorkflow(text)).digest('hex');
}

/** The known Charter workflow `text` is (up to `normalizeWorkflow`), if any. */
export function knownCharterWorkflow(text: string, known: ReadonlyMap<string, KnownWorkflow> = KNOWN_BY_HASH): KnownWorkflow | undefined {
  return known.get(workflowHash(text));
}

/** True when `existing` may be replaced by `content` without --force (#374). */
export function canRefreshSilently(existing: string, content: string, known?: ReadonlyMap<string, KnownWorkflow>): boolean {
  if (normalizeWorkflow(existing) === normalizeWorkflow(content)) return true;
  return knownCharterWorkflow(existing, known)?.safe === true;
}

export type WorkflowKeepReason = 'hand-edited' | 'would-widen-permissions';

export interface PackageManagerChange {
  from: 'npm' | 'pnpm';
  to: 'npm' | 'pnpm';
  /** e.g. `adds pnpm/action-setup@v4`. */
  detail: string;
}

interface Kept {
  reason: WorkflowKeepReason;
  /** For an older Charter template: what refreshing it changes (static text). */
  changes?: string;
  /** What the current template grants (static text). */
  templatePermissions: string;
}

export type WorkflowOutcome =
  | { action: 'created' }
  | { action: 'unchanged' }
  /** A safe Charter template refreshed to the current one; names a package-manager switch. */
  | { action: 'updated'; packageManagerChange?: PackageManagerChange }
  /** Kept without --force. */
  | ({ action: 'kept'; warning: string } & Kept)
  /** Replaced under --force after a backup; `note` is what the Replaced line adds after the backup. */
  | ({ action: 'replaced'; backup: string; note: string; warning?: string } & Kept)
  /** Not replaced under --force because the backup failed. */
  | ({ action: 'not-replaced'; warning: string } & Kept);

export type WorkflowCommand = 'bootstrap' | 'setup';

/** What else `--force` does in each command, in the style of the .mcp.json warning. */
function forceHint(command: WorkflowCommand, backupLabel: string, verb: string): string {
  const also = command === 'bootstrap'
    ? "--force also rewrites every Charter-managed pointer, replaces .mcp.json's mcpServers.charter entry (backing .mcp.json up first) " +
      'and merges the preset template into .ai/*.adf without rewriting existing content'
    : `--force also replaces every .charter/ template that differs, backing each up to ${backupLabel} first`;
  return `'charter ${command} --ci github --force' ${verb}, backing it up to ${backupLabel} first (${also}). ` +
    'To replace only the workflow, delete it and re-run without --force.';
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Write the governance workflow at `targetPath` (relative to the cwd) without
 * losing hand edits or silently changing what CI may do: create it when
 * missing, leave it when identical, refresh a safe Charter template, and
 * otherwise keep it — or, with `force`, back it up to `<configDir>/.backup/`
 * and then replace it.
 */
export function applyGovernanceWorkflow(
  targetPath: string,
  content: string,
  options: {
    force: boolean;
    configDir: string;
    command: WorkflowCommand;
    packageManager: 'npm' | 'pnpm';
    known?: ReadonlyMap<string, KnownWorkflow>;
  },
): WorkflowOutcome {
  const absolute = path.resolve(targetPath);
  const label = targetPath.split(path.sep).join('/');

  if (!fs.existsSync(absolute)) {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    return { action: 'created' };
  }

  const current = fs.readFileSync(absolute, 'utf-8');
  if (current === content) return { action: 'unchanged' };

  if (normalizeWorkflow(current) === normalizeWorkflow(content)) {
    fs.writeFileSync(absolute, content);
    return { action: 'updated' };
  }

  const known = knownCharterWorkflow(current, options.known);
  if (known?.safe) {
    fs.writeFileSync(absolute, content);
    if (known.packageManager === options.packageManager) return { action: 'updated' };
    const detail = options.packageManager === 'pnpm' ? 'adds pnpm/action-setup@v4' : 'removes pnpm/action-setup@v4';
    return { action: 'updated', packageManagerChange: { from: known.packageManager, to: options.packageManager, detail } };
  }

  const kept: Kept = known
    ? { reason: 'would-widen-permissions', changes: known.refreshChanges, templatePermissions: TEMPLATE_PERMISSIONS }
    : { reason: 'hand-edited', templatePermissions: TEMPLATE_PERMISSIONS };
  const backupLabel = `${dirLabel(options.configDir)}.backup/`;

  if (!options.force) {
    const why = known
      ? `it is an older Charter template, and refreshing it to the current one changes what CI may do: ${known.refreshChanges}. ` +
        `It was not overwritten. ${forceHint(options.command, backupLabel, 'upgrades it')}`
      : 'it differs from every workflow Charter generated (edited by hand?), so it was not overwritten. ' +
        `${capitalize(TEMPLATE_PERMISSIONS)}; review it before using --force. ` +
        forceHint(options.command, backupLabel, 'replaces it with the current template');
    return { action: 'kept', ...kept, warning: `Kept ${label}: ${why}` };
  }

  let backup: string;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${backupLabel}${backupFile(absolute, path.join(options.configDir, '.backup'), 'github-workflows-charter-governance.yml', stamp)}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    tryEnsureBackupGitignore(options.configDir, () => undefined);
    return {
      action: 'not-replaced',
      ...kept,
      warning: `Could not back up ${label} to ${backupLabel} (${msg}); not replaced (backup failed).`,
    };
  }
  let warning: string | undefined;
  tryEnsureBackupGitignore(options.configDir, w => { warning = w; });
  fs.writeFileSync(absolute, content);
  const note = known ? `changes: ${known.refreshChanges}` : TEMPLATE_PERMISSIONS;
  return { action: 'replaced', ...kept, backup, note, ...(warning ? { warning } : {}) };
}

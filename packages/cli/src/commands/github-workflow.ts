/**
 * `.github/workflows/charter-governance.yml`: refresh it only while it is still
 * a file Charter generated, and only when the refresh widens nothing (#374).
 *
 * `bootstrap --ci github` and `setup --ci github` overwrite the workflow without
 * `--force` only when it matches the current template or one Charter shipped
 * before, and the current template grants CI no more than that file did: the
 * same `permissions` and `on:` triggers, and no new step that runs `git push`.
 * Any other workflow is kept, with a warning; `--force` replaces it after
 * backing it up to `.charter/.backup/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { backupFile, dirLabel, tryEnsureBackupGitignore } from './adf-scaffold-merge';

export interface KnownWorkflow {
  /** sha256 of the template after `normalizeWorkflow`. */
  hash: string;
  /** Where it came from in setup.ts's history. */
  origin: string;
  /**
   * Whether refreshing it to the current template widens nothing (same
   * `permissions` and `on:`, no new `git push` step). Checked again at run time
   * by `workflowWidening`, which also names what would widen.
   */
  safe: boolean;
}

/**
 * Every `charter-governance.yml` Charter has generated, recovered from the
 * history of `getGithubWorkflow` / `GITHUB_WORKFLOW` in setup.ts (each
 * template's npm and pnpm form). When the template changes, add the new hashes
 * (a test fails until the current ones are listed) and re-check each `safe`.
 */
export const KNOWN_WORKFLOWS: readonly KnownWorkflow[] = [
  { hash: '59b8380e5926f47656fb4870effe234090528bd9b1f0705d5e283e009e0ff225', origin: 'current, npm (score-badge steps; contents: write)', safe: true },
  { hash: '1ff96c6454952dbc630b6cc079cd1fd7840f6b18673098bec030595968a302cd', origin: 'current, pnpm (score-badge steps; contents: write)', safe: true },
  // Everything below ran on pull_request only, with contents: read.
  { hash: '38f58106b0dd4c9a0363d971bfd10c23f1a5067c1998224abd5ed9a70337f98f', origin: '0844601, npm (ADF wiring and evidence steps)', safe: false },
  { hash: '87c27e54791175c4a3937490b9f7f03f841269b6d01b1fe303352ab0ebb5748f', origin: '0844601, pnpm (ADF wiring and evidence steps)', safe: false },
  { hash: '35d3c37b5bb5cf7c2a8aa5eaf5d6c67fba2b2ae244473f9ee05220ac3a8b9c57', origin: '8cbfd78, npm (npx charter)', safe: false },
  { hash: '351527f91d2d737cb1b639e52220fa6efdc91f82e588a4a124b889708a38d27b', origin: '8cbfd78, pnpm (npx charter)', safe: false },
  { hash: '6e5d94d02eceff4601b8df3f2d3c223fc0faac09f4725397d9bb9aac2c5106a4', origin: 'f691c8a (npm install -g @stackbilt/cli@<version>)', safe: false },
  { hash: '1c0be5478ab2bf8fdbbf60ce823a057d6eb6e486359e95438ac3e98ebe0e3969', origin: '90d3651 (npm install -g @stackbilt/cli)', safe: false },
  { hash: '9714db6011806c2350c1467cc0fdc1db48f67d848a96b5487abf8e4267d7fd6e', origin: 'e214ad0 (npm install -g @charter/cli, the first template)', safe: false },
];

const KNOWN_BY_HASH: ReadonlyMap<string, KnownWorkflow> = new Map(KNOWN_WORKFLOWS.map(k => [k.hash, k]));

const VERSION_PIN = /(@stackbilt\/cli@)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;

/**
 * The form workflows are compared in: no BOM, LF line endings, no trailing
 * whitespace on any line, exactly one final newline, and a pinned
 * `@stackbilt/cli@<version>` (a template that embedded the CLI version)
 * replaced by a placeholder, so a pin is treated as template text.
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
export function knownCharterWorkflow(
  text: string,
  current?: string,
  known: ReadonlyMap<string, KnownWorkflow> = KNOWN_BY_HASH,
): KnownWorkflow | undefined {
  if (current !== undefined && normalizeWorkflow(text) === normalizeWorkflow(current)) {
    return { hash: workflowHash(current), origin: 'current', safe: true };
  }
  return known.get(workflowHash(text));
}

/** The non-blank lines of a top-level YAML block (`key:` at column 0), or null when absent. */
function topLevelBlock(normalized: string, key: string): string[] | null {
  const lines = normalized.split('\n');
  const start = lines.indexOf(`${key}:`);
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== '' && !/^\s/.test(line)) break;
    if (line.trim() !== '') body.push(line);
  }
  return body;
}

/** `key: value` pairs one level under a block. */
function blockEntries(block: string[] | null): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of block ?? []) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) entries.set(m[1], m[2]);
  }
  return entries;
}

const PUSH_STEP = /\bgit\s+push\b/;

/**
 * What replacing `oldText` with `newText` would widen, in words; empty when it
 * widens nothing. Compares the normalized top-level `permissions` and `on:`
 * blocks (any difference counts) and whether `newText` adds a `git push`.
 */
export function workflowWidening(oldText: string, newText: string): string[] {
  const oldN = normalizeWorkflow(oldText);
  const newN = normalizeWorkflow(newText);
  const reasons: string[] = [];

  const oldPerms = topLevelBlock(oldN, 'permissions');
  const newPerms = topLevelBlock(newN, 'permissions');
  if (JSON.stringify(oldPerms) !== JSON.stringify(newPerms)) {
    const before = blockEntries(oldPerms);
    const after = blockEntries(newPerms);
    const changes: string[] = [];
    for (const [k, v] of after) if (before.get(k) !== v) changes.push(`${k}: ${before.get(k) ?? 'unset'} → ${v}`);
    for (const [k, v] of before) if (!after.has(k)) changes.push(`${k}: ${v} → unset`);
    reasons.push(changes.length > 0 ? `CI permissions (${changes.join(', ')})` : 'CI permissions');
  }

  const oldOn = topLevelBlock(oldN, 'on');
  const newOn = topLevelBlock(newN, 'on');
  if (JSON.stringify(oldOn) !== JSON.stringify(newOn)) {
    const before = blockEntries(oldOn);
    const added = [...blockEntries(newOn).keys()].filter(k => !before.has(k));
    reasons.push(added.length > 0 ? `triggers (adds ${added.join(', ')})` : 'triggers');
  }

  if (PUSH_STEP.test(newN) && !PUSH_STEP.test(oldN)) {
    reasons.push('an auto-commit step that runs git push');
  }
  return reasons;
}

/** True when `existing` may be replaced by `content` without --force: a known Charter version that widens nothing. */
export function canRefreshSilently(existing: string, content: string, known?: ReadonlyMap<string, KnownWorkflow>): boolean {
  const k = knownCharterWorkflow(existing, content, known);
  return !!k && k.safe && workflowWidening(existing, content).length === 0;
}

export type WorkflowKeepReason = 'hand-edited' | 'would-widen-permissions';

export type WorkflowOutcome =
  | { action: 'created' }
  | { action: 'unchanged' }
  /** A Charter-generated workflow refreshed to the current template (widens nothing). */
  | { action: 'updated' }
  /** Kept without --force: hand-edited, or a refresh would widen CI permissions. */
  | { action: 'kept'; reason: WorkflowKeepReason; widens?: string[]; warning: string }
  /** Replaced under --force after a backup. */
  | { action: 'replaced'; reason: WorkflowKeepReason; widens?: string[]; backup: string; warning?: string }
  /** Not replaced under --force because the backup failed. */
  | { action: 'not-replaced'; reason: WorkflowKeepReason; widens?: string[]; warning: string };

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

/**
 * Write the governance workflow at `targetPath` (relative to the cwd) without
 * losing hand edits or silently widening CI permissions: create it when
 * missing, leave it when identical, refresh a known Charter version that
 * widens nothing, and otherwise keep it — or, with `force`, back it up to
 * `<configDir>/.backup/` and then replace it.
 */
export function applyGovernanceWorkflow(
  targetPath: string,
  content: string,
  options: { force: boolean; configDir: string; command: WorkflowCommand; known?: ReadonlyMap<string, KnownWorkflow> },
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

  const known = knownCharterWorkflow(current, content, options.known);
  const widens = workflowWidening(current, content);
  if (known && known.safe && widens.length === 0) {
    fs.writeFileSync(absolute, content);
    return { action: 'updated' };
  }

  const reason: WorkflowKeepReason = known ? 'would-widen-permissions' : 'hand-edited';
  // A hand-edited file can widen too; the Replaced line names it either way.
  const extra = widens.length > 0 ? { widens } : known ? { widens: ['CI permissions'] } : {};
  const backupLabel = `${dirLabel(options.configDir)}.backup/`;
  if (!options.force) {
    const why = known
      ? `it is an older Charter template, and refreshing it would widen what CI may do: ${(extra.widens ?? []).join('; ')}, so it was not overwritten. ` +
        forceHint(options.command, backupLabel, 'upgrades it')
      : 'it differs from every workflow Charter generated (edited by hand?), so it was not overwritten. ' +
        forceHint(options.command, backupLabel, 'replaces it with the current template');
    return { action: 'kept', reason, ...extra, warning: `Kept ${label}: ${why}` };
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
      reason,
      ...extra,
      warning: `Could not back up ${label} to ${backupLabel} (${msg}); not replaced (backup failed).`,
    };
  }
  let warning: string | undefined;
  tryEnsureBackupGitignore(options.configDir, w => { warning = w; });
  fs.writeFileSync(absolute, content);
  return { action: 'replaced', reason, ...extra, backup, ...(warning ? { warning } : {}) };
}

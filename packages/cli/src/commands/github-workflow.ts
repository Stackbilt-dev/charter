/**
 * `.github/workflows/charter-governance.yml`: refresh it only while it is still
 * a file Charter generated (#374).
 *
 * `bootstrap --ci github` and `setup --ci github` overwrite the workflow only
 * when it matches the current template or one Charter shipped before. A file
 * that matches none of them was edited by hand: it is kept, with a warning,
 * and `--force` replaces it after backing it up to `.charter/.backup/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { backupFile, dirLabel, tryEnsureBackupGitignore } from './adf-scaffold-merge';

/**
 * sha256 of every `charter-governance.yml` Charter has generated, after
 * `normalizeWorkflow`, recovered from the history of `getGithubWorkflow` in
 * setup.ts (each template's npm and pnpm form). When the template changes,
 * append the new hashes here; a test fails until the current ones are listed.
 */
export const KNOWN_WORKFLOW_HASHES: ReadonlySet<string> = new Set([
  // Current: score-badge refresh steps (npm, pnpm)
  '59b8380e5926f47656fb4870effe234090528bd9b1f0705d5e283e009e0ff225',
  '1ff96c6454952dbc630b6cc079cd1fd7840f6b18673098bec030595968a302cd',
  // ADF wiring and evidence steps, before the badge steps (0844601; npm, pnpm)
  '38f58106b0dd4c9a0363d971bfd10c23f1a5067c1998224abd5ed9a70337f98f',
  '87c27e54791175c4a3937490b9f7f03f841269b6d01b1fe303352ab0ebb5748f',
  // npx charter with a package-manager-aware install (8cbfd78; npm, pnpm)
  '35d3c37b5bb5cf7c2a8aa5eaf5d6c67fba2b2ae244473f9ee05220ac3a8b9c57',
  '351527f91d2d737cb1b639e52220fa6efdc91f82e588a4a124b889708a38d27b',
  // npm install -g @stackbilt/cli@<version>, the pin normalized away (f691c8a)
  '6e5d94d02eceff4601b8df3f2d3c223fc0faac09f4725397d9bb9aac2c5106a4',
  // npm install -g @stackbilt/cli (90d3651)
  '1c0be5478ab2bf8fdbbf60ce823a057d6eb6e486359e95438ac3e98ebe0e3969',
  // npm install -g @charter/cli (e214ad0, the first template)
  '9714db6011806c2350c1467cc0fdc1db48f67d848a96b5487abf8e4267d7fd6e',
]);

const VERSION_PIN = /(@stackbilt\/cli@)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;

/**
 * The form workflows are compared in: no BOM, LF line endings, no trailing
 * whitespace on any line, exactly one final newline, and a pinned
 * `@stackbilt/cli@<version>` (a template that embedded the CLI version)
 * replaced by a placeholder.
 */
export function normalizeWorkflow(text: string): string {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`.replace(VERSION_PIN, '$1{{CHARTER_VERSION}}');
}

export function workflowHash(text: string): string {
  return createHash('sha256').update(normalizeWorkflow(text)).digest('hex');
}

/** True when `text` is, up to `normalizeWorkflow`, a workflow Charter generated (or `current`). */
export function isKnownCharterWorkflow(text: string, current?: string): boolean {
  if (current !== undefined && normalizeWorkflow(text) === normalizeWorkflow(current)) return true;
  return KNOWN_WORKFLOW_HASHES.has(workflowHash(text));
}

export type WorkflowOutcome =
  | { action: 'created' }
  | { action: 'unchanged' }
  /** A Charter-generated workflow refreshed to the current template. */
  | { action: 'updated' }
  /** Hand-edited, kept without --force. */
  | { action: 'kept'; warning: string }
  /** Hand-edited, replaced under --force after a backup. */
  | { action: 'replaced'; backup: string; warning?: string }
  /** Hand-edited, not replaced under --force because the backup failed. */
  | { action: 'not-replaced'; warning: string };

/**
 * Write the governance workflow at `targetPath` (relative to the cwd) without
 * losing hand edits: create it when missing, leave it when identical, refresh
 * it when it is a known Charter version, and otherwise keep it — or, with
 * `force`, back it up to `<configDir>/.backup/` and then replace it.
 */
export function applyGovernanceWorkflow(
  targetPath: string,
  content: string,
  options: { force: boolean; configDir: string; forceHint: string },
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

  if (isKnownCharterWorkflow(current, content)) {
    fs.writeFileSync(absolute, content);
    return { action: 'updated' };
  }

  const backupLabel = `${dirLabel(options.configDir)}.backup/`;
  if (!options.force) {
    return {
      action: 'kept',
      warning: `Kept ${label}: it differs from every workflow Charter generated (edited by hand?), so it was not overwritten. ` +
        `${options.forceHint} replaces it with the current template, backing it up to ${backupLabel} first.`,
    };
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
      warning: `Could not back up ${label} to ${backupLabel} (${msg}); not replaced.`,
    };
  }
  let warning: string | undefined;
  tryEnsureBackupGitignore(options.configDir, w => { warning = w; });
  fs.writeFileSync(absolute, content);
  return { action: 'replaced', backup, ...(warning ? { warning } : {}) };
}

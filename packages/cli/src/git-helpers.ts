/**
 * Shared git invocation helpers.
 *
 * Centralizes all child-process git calls behind a single `runGit()` that
 * uses `shell: true` for cross-platform PATH resolution (fixes WSL, CMD,
 * PowerShell parity — see ADX-005 F2).
 */

import { execFileSync } from 'node:child_process';
import type { GitCommit } from '@stackbilt/types';

// ---------------------------------------------------------------------------
// Core git invocation
// ---------------------------------------------------------------------------

/**
 * Run a git command and return its stdout.
 *
 * Uses `shell: true` so that the OS shell resolves the `git` binary via
 * PATH.  This is the key cross-platform fix: `execFileSync` *without* a
 * shell can fail on WSL/Windows when git lives in a PATH entry the Node
 * process doesn't see directly.
 */
export function runGit(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    shell: true,
  });
}

/** Returns `true` when the current working directory is inside a git work tree. */
export function isGitRepo(): boolean {
  try {
    runGit(['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

/** Returns `true` when the repository has at least one commit (HEAD exists). */
export function hasCommits(): boolean {
  try {
    runGit(['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/** Extract a human-readable message from a git child-process error. */
export function getGitErrorMessage(error: unknown): string {
  const fallback = 'Unknown git error.';
  if (!(error instanceof Error)) return fallback;
  const execError = error as Error & { stderr?: Buffer | string };

  if (execError.stderr) {
    const stderr = execError.stderr.toString().trim();
    if (stderr.length > 0) {
      return stderr;
    }
  }

  if (execError.message) {
    return execError.message.trim();
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// Commit log parsing (shared by audit, validate, why)
// ---------------------------------------------------------------------------

/**
 * Parse `git log --format=%H%x1f%an%x1f%aI%x1f%B%x1e` output into commit
 * metadata (without file lists).
 */
export function parseCommitMetadata(logOutput: string): Array<Omit<GitCommit, 'files_changed'>> {
  const commits: Array<Omit<GitCommit, 'files_changed'>> = [];

  for (const rawRecord of logOutput.split('\x1e')) {
    const record = rawRecord.trim();
    if (!record) continue;

    const [sha = '', author = '', timestamp = '', ...messageParts] = record.split('\x1f');
    if (!sha) continue;

    commits.push({
      sha: sha.trim(),
      author: author.trim(),
      timestamp: timestamp.trim(),
      message: messageParts.join('\x1f').replace(/\r\n/g, '\n').replace(/\n+$/, ''),
    });
  }

  return commits;
}

/**
 * Parse `git log --name-only --format=%H` output into a Map of SHA → changed
 * file paths.
 */
export function parseChangedFilesByCommit(logOutput: string): Map<string, string[]> {
  const filesBySha = new Map<string, string[]>();
  let currentSha = '';

  for (const rawLine of logOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^[a-f0-9]{40}$/i.test(line)) {
      currentSha = line;
      if (!filesBySha.has(currentSha)) {
        filesBySha.set(currentSha, []);
      }
      continue;
    }

    if (!currentSha) continue;
    const files = filesBySha.get(currentSha);
    if (!files || files.includes(line)) continue;
    files.push(line);
  }

  return filesBySha;
}

// ---------------------------------------------------------------------------
// Commit range helpers (shared by audit, validate)
// ---------------------------------------------------------------------------

/** Return a short recent-commits range like `HEAD~5..HEAD`. */
export function getRecentCommitRange(): string {
  try {
    const count = Number.parseInt(runGit(['rev-list', '--count', 'HEAD']).trim(), 10);
    if (!Number.isFinite(count) || count <= 1) {
      return 'HEAD';
    }
    const span = Math.min(5, count - 1);
    return `HEAD~${span}..HEAD`;
  } catch {
    return 'HEAD';
  }
}

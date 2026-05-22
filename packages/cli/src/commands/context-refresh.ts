/**
 * charter context-refresh
 *
 * Generates a live session snapshot (Phase 1: git source only) and writes it
 * to .ai/context.adf. Optionally mirrors markdown to a user-provided output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';

interface GitCommit {
  hash: string;
  date: string;
  subject: string;
}

interface GitSnapshot {
  available: boolean;
  branch: string | null;
  dirty: boolean;
  dirtyFiles: string[];
  recentCommits: GitCommit[];
  error?: string;
}

interface ContextRefreshSnapshot {
  generatedAt: string;
  repoRoot: string;
  sources: string[];
  git: GitSnapshot;
}

const SUPPORTED_SOURCES = new Set(['git']);
const DEFAULT_SOURCES = ['git'];
const DEFAULT_COMMIT_LIMIT = 5;
const DEFAULT_DIRTY_LIMIT = 10;

export async function contextRefreshCommand(options: CLIOptions, args: string[]): Promise<number> {
  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const outputPath = getFlag(args, '--output');
  const sourcesFlag = getFlag(args, '--sources');
  const sources = parseSources(sourcesFlag);
  const unsupported = sources.filter((source) => !SUPPORTED_SOURCES.has(source));
  if (unsupported.length > 0) {
    throw new CLIError(
      `Unsupported --sources value(s): ${unsupported.join(', ')}. ` +
      `Phase 1 currently supports: ${[...SUPPORTED_SOURCES].join(', ')}.`
    );
  }

  const snapshot = buildSnapshot(process.cwd(), sources);
  const adf = renderContextAdf(snapshot);
  const markdown = renderContextMarkdown(snapshot);

  const aiDirAbs = path.resolve(aiDir);
  if (!fs.existsSync(aiDirAbs)) {
    fs.mkdirSync(aiDirAbs, { recursive: true });
  }

  const contextAdfPath = path.join(aiDirAbs, 'context.adf');
  fs.writeFileSync(contextAdfPath, adf, 'utf8');

  let mirroredOutput: string | null = null;
  if (outputPath) {
    const outAbs = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, markdown, 'utf8');
    mirroredOutput = outAbs;
  }

  if (options.format === 'json') {
    console.log(JSON.stringify({
      status: 'ok',
      generatedAt: snapshot.generatedAt,
      sources: snapshot.sources,
      files: {
        contextAdf: path.relative(process.cwd(), contextAdfPath) || '.',
        outputMarkdown: mirroredOutput ? (path.relative(process.cwd(), mirroredOutput) || '.') : null,
      },
      git: {
        available: snapshot.git.available,
        branch: snapshot.git.branch,
        dirty: snapshot.git.dirty,
        dirtyFiles: snapshot.git.dirtyFiles,
        recentCommits: snapshot.git.recentCommits,
        error: snapshot.git.error ?? null,
      },
    }, null, 2));
  } else {
    console.log('');
    console.log('  charter context-refresh');
    console.log(`  Sources:      ${snapshot.sources.join(', ')}`);
    console.log(`  Wrote:        ${path.relative(process.cwd(), contextAdfPath) || '.ai/context.adf'}`);
    if (mirroredOutput) {
      console.log(`  Mirrored MD:  ${path.relative(process.cwd(), mirroredOutput) || mirroredOutput}`);
    }
    if (snapshot.git.available) {
      console.log(`  Git branch:   ${snapshot.git.branch ?? 'unknown'}`);
      console.log(`  Working tree: ${snapshot.git.dirty ? `dirty (${snapshot.git.dirtyFiles.length} file(s))` : 'clean'}`);
      console.log(`  Commits:      ${snapshot.git.recentCommits.length}`);
    } else {
      console.log(`  Git source:   unavailable (${snapshot.git.error ?? 'not a git repository'})`);
    }
    console.log('');
  }

  return EXIT_CODE.SUCCESS;
}

function parseSources(sourcesFlag: string | undefined): string[] {
  if (!sourcesFlag) return [...DEFAULT_SOURCES];
  const parsed = sourcesFlag
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_SOURCES];
}

function buildSnapshot(cwd: string, sources: string[]): ContextRefreshSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    repoRoot: cwd,
    sources,
    git: sources.includes('git')
      ? collectGitSnapshot(cwd)
      : { available: false, branch: null, dirty: false, dirtyFiles: [], recentCommits: [] },
  };
}

function collectGitSnapshot(cwd: string): GitSnapshot {
  const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return {
      available: false,
      branch: null,
      dirty: false,
      dirtyFiles: [],
      recentCommits: [],
      error: 'not a git repository',
    };
  }

  const branch = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown';
  const status = runGit(cwd, ['status', '--short']) ?? '';
  const dirtyLines = status
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const dirtyFiles = dirtyLines.slice(0, DEFAULT_DIRTY_LIMIT);

  const log = runGit(cwd, ['log', '-n', String(DEFAULT_COMMIT_LIMIT), '--date=iso-strict', '--pretty=format:%h\t%ad\t%s']) ?? '';
  const recentCommits: GitCommit[] = [];
  for (const line of log.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [hash, date, ...subjectParts] = line.split('\t');
    if (!hash || !date || subjectParts.length === 0) continue;
    recentCommits.push({
      hash: hash.trim(),
      date: date.trim(),
      subject: subjectParts.join('\t').trim(),
    });
  }

  return {
    available: true,
    branch,
    dirty: dirtyLines.length > 0,
    dirtyFiles,
    recentCommits,
  };
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim();
  } catch {
    return null;
  }
}

function renderContextAdf(snapshot: ContextRefreshSnapshot): string {
  const lines: string[] = [];
  lines.push('ADF: 0.1');
  lines.push('ROLE: Live session snapshot for warm-start context');
  lines.push('');
  lines.push('STATE:');
  lines.push(`  GENERATED_AT: ${snapshot.generatedAt}`);
  lines.push(`  SOURCES: ${snapshot.sources.join(', ')}`);
  lines.push(`  REPO_ROOT: ${path.basename(snapshot.repoRoot) || snapshot.repoRoot}`);
  lines.push('');
  lines.push('OPEN_WORK:');
  if (snapshot.git.available) {
    lines.push(`  - Git branch: ${snapshot.git.branch ?? 'unknown'}`);
    lines.push(`  - Working tree: ${snapshot.git.dirty ? 'dirty' : 'clean'}`);
    if (snapshot.git.dirtyFiles.length > 0) {
      lines.push(...snapshot.git.dirtyFiles.map((file) => `  - Pending change: ${file}`));
    }
  } else {
    lines.push(`  - Git source unavailable: ${snapshot.git.error ?? 'unknown error'}`);
  }
  lines.push('');
  lines.push('RECENT_ACTIVITY:');
  if (snapshot.git.recentCommits.length > 0) {
    for (const commit of snapshot.git.recentCommits) {
      lines.push(`  - ${commit.hash} ${commit.date} — ${commit.subject}`);
    }
  } else {
    lines.push('  - No recent git commits available');
  }
  lines.push('');
  lines.push('PENDING_DECISIONS:');
  lines.push('  - No external decision queue configured (git-only source mode)');
  lines.push('');
  return lines.join('\n');
}

function renderContextMarkdown(snapshot: ContextRefreshSnapshot): string {
  const lines: string[] = [];
  lines.push(`# Live Context — ${snapshot.generatedAt}`);
  lines.push('');
  lines.push('## Open Work');
  if (snapshot.git.available) {
    lines.push(`- Branch: \`${snapshot.git.branch ?? 'unknown'}\``);
    lines.push(`- Working tree: ${snapshot.git.dirty ? `dirty (${snapshot.git.dirtyFiles.length} change(s))` : 'clean'}`);
    for (const dirty of snapshot.git.dirtyFiles) {
      lines.push(`- Pending: \`${dirty}\``);
    }
  } else {
    lines.push(`- Git source unavailable: ${snapshot.git.error ?? 'unknown error'}`);
  }
  lines.push('');
  lines.push('## Recent Activity');
  if (snapshot.git.recentCommits.length > 0) {
    for (const commit of snapshot.git.recentCommits) {
      lines.push(`- \`${commit.hash}\` ${commit.date} — ${commit.subject}`);
    }
  } else {
    lines.push('- No recent git commits available');
  }
  lines.push('');
  lines.push('## Pending Decisions');
  lines.push('- No external decision queue configured (git-only source mode)');
  lines.push('');
  return lines.join('\n');
}

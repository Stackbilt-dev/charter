/**
 * charter context-refresh
 *
 * Generates a live session snapshot and writes:
 *   - .ai/context.adf
 *   - .ai/context.snapshot.json
 * Optional:
 *   - markdown mirror via --output
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';

type ContextSource = 'git' | 'github';

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

interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  updatedAt: string;
  labels: string[];
  url: string;
}

interface GitHubSnapshot {
  available: boolean;
  repo: string | null;
  filterMode: 'strict';
  labels: string[];
  issues: GitHubIssue[];
  error?: string;
}

interface DerivedItem {
  source: ContextSource;
  type: string;
  summary: string;
  ref?: string;
}

interface ContextSnapshot {
  version: 1;
  generatedAt: string;
  expiresAt: string;
  repo: {
    root: string;
    name: string;
  };
  sourcesRequested: ContextSource[];
  sourcesUsed: ContextSource[];
  sources: {
    git: GitSnapshot;
    github: GitHubSnapshot;
  };
  openWork: DerivedItem[];
  recentActivity: DerivedItem[];
  pendingDecisions: DerivedItem[];
  warnings: string[];
  errors: string[];
}

interface ContextConfig {
  version: number;
  defaults: {
    sources: ContextSource[];
    ttlMinutes: number;
    maxItems: {
      gitCommits: number;
      gitDirtyFiles: number;
      githubIssues: number;
    };
  };
  sources: {
    git: {
      enabled: boolean;
    };
    github: {
      enabled: boolean;
      repo: string | null;
      labels: string[];
      includePullRequests: boolean;
      includeChecks: boolean;
    };
  };
}

interface RefreshOptionsResolved {
  aiDirAbs: string;
  outputPathAbs: string | null;
  ttlMinutes: number;
  once: boolean;
  force: boolean;
  sourcesRequested: ContextSource[];
  config: ContextConfig;
}

const SOURCE_SET = new Set<ContextSource>(['git', 'github']);
const DEFAULT_CONFIG: ContextConfig = {
  version: 1,
  defaults: {
    sources: ['git'],
    ttlMinutes: 30,
    maxItems: {
      gitCommits: 10,
      gitDirtyFiles: 25,
      githubIssues: 20,
    },
  },
  sources: {
    git: {
      enabled: true,
    },
    github: {
      enabled: false,
      repo: null,
      labels: [],
      includePullRequests: true,
      includeChecks: true,
    },
  },
};

export async function contextRefreshCommand(options: CLIOptions, args: string[]): Promise<number> {
  const resolved = resolveOptions(options, args);
  const snapshotPath = path.join(resolved.aiDirAbs, 'context.snapshot.json');
  const contextAdfPath = path.join(resolved.aiDirAbs, 'context.adf');

  if (resolved.once && !resolved.force) {
    const skipReason = shouldSkipRefresh(snapshotPath, resolved.ttlMinutes);
    if (skipReason.skip) {
      const existing = skipReason.snapshot;
      const files = {
        contextAdf: path.relative(process.cwd(), contextAdfPath) || '.',
        snapshotJson: path.relative(process.cwd(), snapshotPath) || '.',
        outputMarkdown: resolved.outputPathAbs
          ? (path.relative(process.cwd(), resolved.outputPathAbs) || '.')
          : null,
      };
      if (options.format === 'json') {
        console.log(JSON.stringify({
          status: 'skipped',
          reason: 'fresh_snapshot',
          generatedAt: existing?.generatedAt ?? null,
          expiresAt: existing?.expiresAt ?? null,
          sourcesRequested: resolved.sourcesRequested,
          sourcesUsed: existing?.sourcesUsed ?? [],
          files,
          warnings: [],
          errors: [],
        }, null, 2));
      } else {
        console.log('');
        console.log('  charter context-refresh');
        console.log('  Status:       skipped (fresh snapshot)');
        console.log(`  Snapshot:     ${files.snapshotJson}`);
        console.log(`  TTL (mins):   ${resolved.ttlMinutes}`);
        console.log('');
      }
      return EXIT_CODE.SUCCESS;
    }
  }

  const snapshot = await buildSnapshot(process.cwd(), resolved);
  const adf = renderContextAdf(snapshot);
  const markdown = renderContextMarkdown(snapshot);

  fs.mkdirSync(resolved.aiDirAbs, { recursive: true });
  fs.writeFileSync(contextAdfPath, adf, 'utf8');
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');

  if (resolved.outputPathAbs) {
    fs.mkdirSync(path.dirname(resolved.outputPathAbs), { recursive: true });
    fs.writeFileSync(resolved.outputPathAbs, markdown, 'utf8');
  }

  const status = snapshot.errors.length > 0 || snapshot.warnings.length > 0
    ? 'partial_source_failure'
    : 'refreshed';
  const files = {
    contextAdf: path.relative(process.cwd(), contextAdfPath) || '.',
    snapshotJson: path.relative(process.cwd(), snapshotPath) || '.',
    outputMarkdown: resolved.outputPathAbs
      ? (path.relative(process.cwd(), resolved.outputPathAbs) || '.')
      : null,
  };

  if (options.format === 'json') {
    console.log(JSON.stringify({
      status: 'ok',
      reason: status,
      generatedAt: snapshot.generatedAt,
      expiresAt: snapshot.expiresAt,
      sourcesRequested: snapshot.sourcesRequested,
      sourcesUsed: snapshot.sourcesUsed,
      files,
      warnings: snapshot.warnings,
      errors: snapshot.errors,
    }, null, 2));
  } else {
    console.log('');
    console.log('  charter context-refresh');
    console.log(`  Status:       ${status}`);
    console.log(`  Sources:      ${snapshot.sourcesUsed.join(', ') || '(none)'}`);
    console.log(`  Wrote:        ${files.contextAdf}`);
    console.log(`  Snapshot:     ${files.snapshotJson}`);
    if (files.outputMarkdown) {
      console.log(`  Mirrored MD:  ${files.outputMarkdown}`);
    }
    if (snapshot.warnings.length > 0) {
      console.log(`  Warnings:     ${snapshot.warnings.length}`);
    }
    if (snapshot.errors.length > 0) {
      console.log(`  Errors:       ${snapshot.errors.length}`);
    }
    console.log('');
  }

  return EXIT_CODE.SUCCESS;
}

function resolveOptions(options: CLIOptions, args: string[]): RefreshOptionsResolved {
  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const outputPath = getFlag(args, '--output');
  const sourcesFlag = getFlag(args, '--sources');
  const ttlFlag = getFlag(args, '--ttl-minutes');
  const once = args.includes('--once');
  const force = args.includes('--force');

  const config = loadContextConfig(options.configPath);
  const sourcesRequested = parseRequestedSources(sourcesFlag, config.defaults.sources);
  const ttlMinutes = resolveTtlMinutes(ttlFlag, config.defaults.ttlMinutes);

  return {
    aiDirAbs: path.resolve(aiDir),
    outputPathAbs: outputPath ? path.resolve(outputPath) : null,
    ttlMinutes,
    once,
    force,
    sourcesRequested,
    config,
  };
}

function loadContextConfig(configPath: string): ContextConfig {
  const cfgFile = path.resolve(configPath, 'context-sources.json');
  if (!fs.existsSync(cfgFile)) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ContextConfig;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  } catch (error) {
    throw new CLIError(`Invalid JSON in ${path.relative(process.cwd(), cfgFile)}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new CLIError(`Invalid config in ${path.relative(process.cwd(), cfgFile)}: expected an object`);
  }

  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ContextConfig;
  const root = parsed as Record<string, unknown>;

  if (typeof root.version === 'number') cfg.version = root.version;
  if (root.defaults && typeof root.defaults === 'object') {
    const defaults = root.defaults as Record<string, unknown>;
    if (Array.isArray(defaults.sources)) {
      const cleaned = defaults.sources
        .map((entry) => String(entry).trim().toLowerCase())
        .filter((entry) => entry.length > 0 && SOURCE_SET.has(entry as ContextSource)) as ContextSource[];
      if (cleaned.length > 0) cfg.defaults.sources = [...new Set(cleaned)];
    }
    if (typeof defaults.ttlMinutes === 'number' && defaults.ttlMinutes > 0) {
      cfg.defaults.ttlMinutes = Math.floor(defaults.ttlMinutes);
    }
    if (defaults.maxItems && typeof defaults.maxItems === 'object') {
      const maxItems = defaults.maxItems as Record<string, unknown>;
      if (typeof maxItems.gitCommits === 'number' && maxItems.gitCommits > 0) {
        cfg.defaults.maxItems.gitCommits = Math.floor(maxItems.gitCommits);
      }
      if (typeof maxItems.gitDirtyFiles === 'number' && maxItems.gitDirtyFiles > 0) {
        cfg.defaults.maxItems.gitDirtyFiles = Math.floor(maxItems.gitDirtyFiles);
      }
      if (typeof maxItems.githubIssues === 'number' && maxItems.githubIssues > 0) {
        cfg.defaults.maxItems.githubIssues = Math.floor(maxItems.githubIssues);
      }
    }
  }

  if (root.sources && typeof root.sources === 'object') {
    const sources = root.sources as Record<string, unknown>;
    if (sources.git && typeof sources.git === 'object') {
      const git = sources.git as Record<string, unknown>;
      if (typeof git.enabled === 'boolean') cfg.sources.git.enabled = git.enabled;
    }
    if (sources.github && typeof sources.github === 'object') {
      const github = sources.github as Record<string, unknown>;
      if (typeof github.enabled === 'boolean') cfg.sources.github.enabled = github.enabled;
      if (typeof github.repo === 'string') cfg.sources.github.repo = github.repo.trim();
      if (Array.isArray(github.labels)) {
        cfg.sources.github.labels = github.labels
          .map((entry) => String(entry).trim())
          .filter((entry) => entry.length > 0);
      }
      if (typeof github.includePullRequests === 'boolean') {
        cfg.sources.github.includePullRequests = github.includePullRequests;
      }
      if (typeof github.includeChecks === 'boolean') {
        cfg.sources.github.includeChecks = github.includeChecks;
      }
    }
  }

  return cfg;
}

function parseRequestedSources(sourcesFlag: string | undefined, fallback: ContextSource[]): ContextSource[] {
  if (!sourcesFlag) return [...fallback];
  const requested = sourcesFlag
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const invalid = requested.filter((entry) => !SOURCE_SET.has(entry as ContextSource));
  if (invalid.length > 0) {
    throw new CLIError(`Unsupported --sources value(s): ${invalid.join(', ')}. Supported: git, github.`);
  }
  return [...new Set(requested as ContextSource[])];
}

function resolveTtlMinutes(ttlFlag: string | undefined, defaultTtl: number): number {
  if (!ttlFlag) return defaultTtl;
  const parsed = Number(ttlFlag);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CLIError(`Invalid --ttl-minutes value: ${ttlFlag}. Must be a positive number.`);
  }
  return Math.floor(parsed);
}

function shouldSkipRefresh(snapshotPath: string, ttlMinutes: number): { skip: boolean; snapshot?: ContextSnapshot } {
  if (!fs.existsSync(snapshotPath)) return { skip: false };
  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as ContextSnapshot;
    if (!snapshot.generatedAt) return { skip: false };
    const generatedAtMs = Date.parse(snapshot.generatedAt);
    if (!Number.isFinite(generatedAtMs)) return { skip: false };
    const ageMs = Date.now() - generatedAtMs;
    const ttlMs = ttlMinutes * 60 * 1000;
    if (ageMs <= ttlMs) {
      return { skip: true, snapshot };
    }
  } catch {
    return { skip: false };
  }
  return { skip: false };
}

async function buildSnapshot(cwd: string, resolved: RefreshOptionsResolved): Promise<ContextSnapshot> {
  const now = new Date();
  const generatedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + resolved.ttlMinutes * 60_000).toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  const sourcesUsed: ContextSource[] = [];

  const git = resolved.sourcesRequested.includes('git') && resolved.config.sources.git.enabled
    ? collectGitSnapshot(cwd, resolved.config.defaults.maxItems.gitCommits, resolved.config.defaults.maxItems.gitDirtyFiles)
    : { available: false, branch: null, dirty: false, dirtyFiles: [], recentCommits: [], error: 'disabled' };
  if (git.available) {
    sourcesUsed.push('git');
  } else if (resolved.sourcesRequested.includes('git') && git.error && git.error !== 'disabled') {
    warnings.push(`git source unavailable: ${git.error}`);
  }

  const github = resolved.sourcesRequested.includes('github') && resolved.config.sources.github.enabled
    ? await collectGitHubSnapshot(resolved.config, resolved.config.defaults.maxItems.githubIssues)
    : { available: false, repo: null, filterMode: 'strict' as const, labels: [], issues: [], error: 'disabled' };
  if (github.available) {
    sourcesUsed.push('github');
  } else if (resolved.sourcesRequested.includes('github') && github.error && github.error !== 'disabled') {
    const msg = `github source unavailable: ${github.error}`;
    warnings.push(msg);
    if (github.error.startsWith('request_failed:') || github.error.startsWith('api_error:') || github.error.startsWith('invalid_json:')) {
      errors.push(msg);
    }
  }

  const derived = deriveAggregates(git, github);

  return {
    version: 1,
    generatedAt,
    expiresAt,
    repo: {
      root: cwd,
      name: path.basename(cwd) || cwd,
    },
    sourcesRequested: resolved.sourcesRequested,
    sourcesUsed,
    sources: {
      git,
      github,
    },
    openWork: derived.openWork,
    recentActivity: derived.recentActivity,
    pendingDecisions: derived.pendingDecisions,
    warnings,
    errors,
  };
}

function collectGitSnapshot(cwd: string, commitLimit: number, dirtyLimit: number): GitSnapshot {
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
  const dirtyFiles = dirtyLines.slice(0, dirtyLimit);

  const log = runGit(cwd, ['log', '-n', String(commitLimit), '--date=iso-strict', '--pretty=format:%h\t%ad\t%s']) ?? '';
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

async function collectGitHubSnapshot(config: ContextConfig, issueLimit: number): Promise<GitHubSnapshot> {
  const repo = config.sources.github.repo;
  if (!repo) {
    return {
      available: false,
      repo: null,
      filterMode: 'strict',
      labels: config.sources.github.labels,
      issues: [],
      error: 'not_configured',
    };
  }
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    return {
      available: false,
      repo,
      filterMode: 'strict',
      labels: config.sources.github.labels,
      issues: [],
      error: 'missing GITHUB_TOKEN',
    };
  }

  const labels = config.sources.github.labels.filter((label) => label.length > 0);
  const params = new URLSearchParams({
    state: 'open',
    per_page: String(issueLimit),
  });
  if (labels.length > 0) {
    params.set('labels', labels.join(','));
  }

  const endpoint = `https://api.github.com/repos/${repo}/issues?${params.toString()}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'charter-cli',
      },
    });
  } catch (error) {
    return {
      available: false,
      repo,
      filterMode: 'strict',
      labels,
      issues: [],
      error: `request_failed: ${(error as Error).message}`,
    };
  }

  if (!response.ok) {
    return {
      available: false,
      repo,
      filterMode: 'strict',
      labels,
      issues: [],
      error: `api_error: ${response.status} ${response.statusText}`,
    };
  }

  type GitHubIssueApi = {
    number: number;
    title: string;
    state: string;
    updated_at: string;
    html_url: string;
    labels: Array<{ name?: string } | string>;
    pull_request?: unknown;
  };
  let payload: GitHubIssueApi[] = [];
  try {
    payload = await response.json() as GitHubIssueApi[];
  } catch (error) {
    return {
      available: false,
      repo,
      filterMode: 'strict',
      labels,
      issues: [],
      error: `invalid_json: ${(error as Error).message}`,
    };
  }

  const issues: GitHubIssue[] = payload
    .filter((item) => !item.pull_request)
    .map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state,
      updatedAt: item.updated_at,
      labels: item.labels.map((entry) => typeof entry === 'string' ? entry : (entry.name ?? '')).filter((entry) => entry.length > 0),
      url: item.html_url,
    }));

  return {
    available: true,
    repo,
    filterMode: 'strict',
    labels,
    issues,
  };
}

function deriveAggregates(
  git: GitSnapshot,
  github: GitHubSnapshot,
): {
  openWork: DerivedItem[];
  recentActivity: DerivedItem[];
  pendingDecisions: DerivedItem[];
} {
  const openWork: DerivedItem[] = [];
  const recentActivity: DerivedItem[] = [];
  const pendingDecisions: DerivedItem[] = [];

  if (git.available) {
    openWork.push({
      source: 'git',
      type: 'branch',
      summary: `Branch ${git.branch ?? 'unknown'}`,
    });
    if (git.dirty) {
      openWork.push({
        source: 'git',
        type: 'working-tree',
        summary: `Working tree has ${git.dirtyFiles.length} pending change(s)`,
      });
      for (const dirty of git.dirtyFiles) {
        openWork.push({
          source: 'git',
          type: 'dirty-file',
          summary: dirty,
        });
      }
    }
    for (const commit of git.recentCommits) {
      recentActivity.push({
        source: 'git',
        type: 'commit',
        summary: `${commit.hash} ${commit.subject}`,
        ref: commit.hash,
      });
    }
  }

  if (github.available) {
    for (const issue of github.issues) {
      openWork.push({
        source: 'github',
        type: 'issue',
        summary: `#${issue.number} ${issue.title}`,
        ref: issue.url,
      });
      pendingDecisions.push({
        source: 'github',
        type: 'issue',
        summary: `Review issue #${issue.number}`,
        ref: issue.url,
      });
      recentActivity.push({
        source: 'github',
        type: 'issue-update',
        summary: `Issue #${issue.number} updated ${issue.updatedAt}`,
        ref: issue.url,
      });
    }
  }

  return { openWork, recentActivity, pendingDecisions };
}

function renderContextAdf(snapshot: ContextSnapshot): string {
  const lines: string[] = [];
  lines.push('ADF: 0.1');
  lines.push('ROLE: Live session snapshot for warm-start context');
  lines.push('');
  lines.push('STATE:');
  lines.push(`  GENERATED_AT: ${snapshot.generatedAt}`);
  lines.push(`  EXPIRES_AT: ${snapshot.expiresAt}`);
  lines.push(`  SOURCES_REQUESTED: ${snapshot.sourcesRequested.join(', ')}`);
  lines.push(`  SOURCES_USED: ${snapshot.sourcesUsed.join(', ') || '(none)'}`);
  lines.push(`  REPO_ROOT: ${snapshot.repo.name}`);
  lines.push('');
  lines.push('OPEN_WORK:');
  if (snapshot.openWork.length > 0) {
    for (const item of snapshot.openWork) {
      lines.push(`  - [${item.source}] ${item.summary}`);
    }
  } else {
    lines.push('  - none');
  }
  lines.push('');
  lines.push('RECENT_ACTIVITY:');
  if (snapshot.recentActivity.length > 0) {
    for (const item of snapshot.recentActivity) {
      lines.push(`  - [${item.source}] ${item.summary}`);
    }
  } else {
    lines.push('  - none');
  }
  lines.push('');
  lines.push('PENDING_DECISIONS:');
  if (snapshot.pendingDecisions.length > 0) {
    for (const item of snapshot.pendingDecisions) {
      lines.push(`  - [${item.source}] ${item.summary}`);
    }
  } else {
    lines.push('  - none');
  }
  if (snapshot.warnings.length > 0) {
    lines.push('');
    lines.push('WARNINGS:');
    for (const warning of snapshot.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderContextMarkdown(snapshot: ContextSnapshot): string {
  const lines: string[] = [];
  lines.push(`# Live Context — ${snapshot.generatedAt}`);
  lines.push('');
  lines.push('## Open Work');
  if (snapshot.openWork.length > 0) {
    for (const item of snapshot.openWork) {
      lines.push(`- [${item.source}] ${item.summary}`);
    }
  } else {
    lines.push('- none');
  }
  lines.push('');
  lines.push('## Recent Activity');
  if (snapshot.recentActivity.length > 0) {
    for (const item of snapshot.recentActivity) {
      lines.push(`- [${item.source}] ${item.summary}`);
    }
  } else {
    lines.push('- none');
  }
  lines.push('');
  lines.push('## Pending Decisions');
  if (snapshot.pendingDecisions.length > 0) {
    for (const item of snapshot.pendingDecisions) {
      lines.push(`- [${item.source}] ${item.summary}`);
    }
  } else {
    lines.push('- none');
  }
  if (snapshot.warnings.length > 0) {
    lines.push('');
    lines.push('## Warnings');
    for (const warning of snapshot.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

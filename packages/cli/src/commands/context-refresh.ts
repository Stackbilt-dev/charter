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

type ContextSource = 'git' | 'github' | 'repo-intel';

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

// repo-intel types
interface RepoIntelIssue {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  createdAt: string;
  updatedAt: string;
  comments: number;
}

interface RepoIntelClosedIssue {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  closedAt: string;
}

interface RepoIntelPR {
  number: number;
  title: string;
  state: string;
  author: { login: string };
  mergedAt: string | null;
  createdAt: string;
  reviewDecision: string | null;
  labels: Array<{ name: string }>;
}

interface RepoIntelRelease {
  tagName: string;
  publishedAt: string;
  isLatest: boolean;
}

interface RepoIntelSummary {
  openIssueCount: number;
  stalledIssues: number;
  recurringLabels: string[];
  mergeVelocity: number;
  releaseCadence: number | null;
}

interface RepoIntelSnapshot {
  available: boolean;
  generatedAt: string;
  openIssues: RepoIntelIssue[];
  closedIssues: RepoIntelClosedIssue[];
  pullRequests: RepoIntelPR[];
  releases: RepoIntelRelease[];
  summary: RepoIntelSummary;
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
    'repo-intel': RepoIntelSnapshot;
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
    'repo-intel': {
      enabled: boolean;
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

interface ContextRefreshIO {
  log?: (message: string) => void;
}

const SOURCE_SET = new Set<ContextSource>(['git', 'github', 'repo-intel']);
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
    'repo-intel': {
      enabled: true,
    },
  },
};

export async function contextRefreshCommand(
  options: CLIOptions,
  args: string[],
  io?: ContextRefreshIO,
): Promise<number> {
  const log = io?.log ?? console.log;
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
        log(JSON.stringify({
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
        log('');
        log('  charter context-refresh');
        log('  Status:       skipped (fresh snapshot)');
        log(`  Snapshot:     ${files.snapshotJson}`);
        log(`  TTL (mins):   ${resolved.ttlMinutes}`);
        log('');
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
    log(JSON.stringify({
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
    log('');
    log('  charter context-refresh');
    log(`  Status:       ${status}`);
    log(`  Sources:      ${snapshot.sourcesUsed.join(', ') || '(none)'}`);
    log(`  Wrote:        ${files.contextAdf}`);
    log(`  Snapshot:     ${files.snapshotJson}`);
    if (files.outputMarkdown) {
      log(`  Mirrored MD:  ${files.outputMarkdown}`);
    }
    if (snapshot.warnings.length > 0) {
      log(`  Warnings:     ${snapshot.warnings.length}`);
    }
    if (snapshot.errors.length > 0) {
      log(`  Errors:       ${snapshot.errors.length}`);
    }
    log('');
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
    const repoIntelCfg = sources['repo-intel'];
    if (repoIntelCfg && typeof repoIntelCfg === 'object') {
      const ri = repoIntelCfg as Record<string, unknown>;
      if (typeof ri.enabled === 'boolean') cfg.sources['repo-intel'].enabled = ri.enabled;
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
    throw new CLIError(`Unsupported --sources value(s): ${invalid.join(', ')}. Supported: git, github, repo-intel.`);
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

  const repoIntelEnabled = resolved.sourcesRequested.includes('repo-intel') && resolved.config.sources['repo-intel'].enabled;
  const repoIntel = repoIntelEnabled
    ? collectRepoIntelSnapshot(cwd, generatedAt)
    : { available: false, generatedAt, openIssues: [], closedIssues: [], pullRequests: [], releases: [], summary: { openIssueCount: 0, stalledIssues: 0, recurringLabels: [], mergeVelocity: 0, releaseCadence: null }, error: 'disabled' };
  if (repoIntel.available) {
    sourcesUsed.push('repo-intel');
    // Persist full snapshot to .charter/repo-intel/snapshot.json
    const repoIntelSnapshotPath = path.resolve(cwd, '.charter', 'repo-intel', 'snapshot.json');
    fs.mkdirSync(path.dirname(repoIntelSnapshotPath), { recursive: true });
    fs.writeFileSync(repoIntelSnapshotPath, JSON.stringify(repoIntel, null, 2), 'utf8');
  } else if (resolved.sourcesRequested.includes('repo-intel') && repoIntel.error && repoIntel.error !== 'disabled') {
    warnings.push(`repo-intel source unavailable: ${repoIntel.error}`);
  }

  const derived = deriveAggregates(git, github, repoIntel);

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
      'repo-intel': repoIntel,
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

function runGhCommand(args: string[], cwd?: string): string | null {
  try {
    const output = execFileSync('gh', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim();
  } catch {
    return null;
  }
}

function collectRepoIntelSnapshot(cwd: string, generatedAt: string): RepoIntelSnapshot {

  const empty: RepoIntelSnapshot = {
    available: false,
    generatedAt,
    openIssues: [],
    closedIssues: [],
    pullRequests: [],
    releases: [],
    summary: { openIssueCount: 0, stalledIssues: 0, recurringLabels: [], mergeVelocity: 0, releaseCadence: null },
  };

  // Check if gh CLI is available
  const ghVersion = runGhCommand(['--version'], cwd);
  if (!ghVersion) {
    return { ...empty, error: 'gh CLI not available' };
  }

  // Open issues (last 50, sorted by updated)
  const openIssuesRaw = runGhCommand([
    'issue', 'list', '--limit', '50', '--state', 'open',
    '--json', 'number,title,labels,assignees,createdAt,updatedAt,comments',
  ], cwd);
  if (!openIssuesRaw) {
    return { ...empty, error: 'no GitHub remote or gh auth required' };
  }

  let openIssues: RepoIntelIssue[];
  try {
    openIssues = JSON.parse(openIssuesRaw) as RepoIntelIssue[];
  } catch {
    return { ...empty, error: 'invalid_json: open issues response' };
  }

  // Recent closed issues (last 20)
  const closedIssuesRaw = runGhCommand([
    'issue', 'list', '--limit', '20', '--state', 'closed',
    '--json', 'number,title,labels,closedAt',
  ], cwd);
  let closedIssues: RepoIntelClosedIssue[] = [];
  if (closedIssuesRaw) {
    try {
      closedIssues = JSON.parse(closedIssuesRaw) as RepoIntelClosedIssue[];
    } catch { /* ignore parse failures for supplemental data */ }
  }

  // Recent PRs (last 30, all states)
  const prsRaw = runGhCommand([
    'pr', 'list', '--limit', '30', '--state', 'all',
    '--json', 'number,title,state,author,mergedAt,createdAt,reviewDecision,labels',
  ], cwd);
  let pullRequests: RepoIntelPR[] = [];
  if (prsRaw) {
    try {
      pullRequests = JSON.parse(prsRaw) as RepoIntelPR[];
    } catch { /* ignore */ }
  }

  // Release cadence (last 10 releases)
  const releasesRaw = runGhCommand([
    'release', 'list', '--limit', '10',
    '--json', 'tagName,publishedAt,isLatest',
  ], cwd);
  let releases: RepoIntelRelease[] = [];
  if (releasesRaw) {
    try {
      releases = JSON.parse(releasesRaw) as RepoIntelRelease[];
    } catch { /* ignore */ }
  }

  // Compute summary
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  const stalledIssues = openIssues.filter((issue) => {
    const updatedMs = Date.parse(issue.updatedAt);
    return Number.isFinite(updatedMs) && (now - updatedMs) > thirtyDaysMs;
  }).length;

  // Count label occurrences in closed issues
  const labelCounts = new Map<string, number>();
  for (const issue of closedIssues) {
    for (const label of issue.labels) {
      const name = label.name;
      labelCounts.set(name, (labelCounts.get(name) ?? 0) + 1);
    }
  }
  const recurringLabels = [...labelCounts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  const mergeVelocity = pullRequests.filter((pr) => {
    if (!pr.mergedAt) return false;
    const mergedMs = Date.parse(pr.mergedAt);
    return Number.isFinite(mergedMs) && (now - mergedMs) <= thirtyDaysMs;
  }).length;

  let releaseCadence: number | null = null;
  const lastFiveReleases = releases
    .slice(0, 5)
    .map((r) => Date.parse(r.publishedAt))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => b - a);
  if (lastFiveReleases.length >= 2) {
    const gaps: number[] = [];
    for (let i = 0; i < lastFiveReleases.length - 1; i++) {
      gaps.push((lastFiveReleases[i]! - lastFiveReleases[i + 1]!) / (24 * 60 * 60 * 1000));
    }
    releaseCadence = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  }

  const summary: RepoIntelSummary = {
    openIssueCount: openIssues.length,
    stalledIssues,
    recurringLabels,
    mergeVelocity,
    releaseCadence,
  };

  return {
    available: true,
    generatedAt,
    openIssues,
    closedIssues,
    pullRequests,
    releases,
    summary,
  };
}

function deriveAggregates(
  git: GitSnapshot,
  github: GitHubSnapshot,
  repoIntel: RepoIntelSnapshot,
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

  if (repoIntel.available) {
    const s = repoIntel.summary;
    recentActivity.push({
      source: 'repo-intel',
      type: 'summary',
      summary: `repo-intel: ${s.openIssueCount} open issues, ${s.mergeVelocity} PRs merged in last 30d, ${s.stalledIssues} stalled`,
    });
    if (s.stalledIssues > 0) {
      openWork.push({
        source: 'repo-intel',
        type: 'stalled-issues',
        summary: `${s.stalledIssues} open issue(s) with no activity in 30+ days`,
      });
    }
    if (s.recurringLabels.length > 0) {
      pendingDecisions.push({
        source: 'repo-intel',
        type: 'recurring-labels',
        summary: `Recurring closed-issue labels (≥3 times): ${s.recurringLabels.slice(0, 5).join(', ')}`,
      });
    }
    if (s.releaseCadence !== null) {
      recentActivity.push({
        source: 'repo-intel',
        type: 'release-cadence',
        summary: `Avg release cadence: ~${s.releaseCadence} day(s) between last 5 releases`,
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

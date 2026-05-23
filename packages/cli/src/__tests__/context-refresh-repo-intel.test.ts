/**
 * Tests for the repo-intel source in context-refresh.
 *
 * Uses vi.mock at the top level (required for ESM) to intercept execFileSync.
 * A module-level `ghResponder` variable is mutated per-test so the hoisted
 * mock factory can dispatch different responses without re-mocking.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { contextRefreshCommand } from '../commands/context-refresh';

// ---------------------------------------------------------------------------
// Module-level gh responder — set this before each test, read by the mock
// ---------------------------------------------------------------------------
type GhResponder = ((args: string[]) => string) | null;
let ghResponder: GhResponder = null;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(
      (cmd: string, args: unknown, opts: unknown): string => {
        if (cmd === 'gh') {
          if (!ghResponder) throw new Error('ENOENT: gh not found');
          return ghResponder(args as string[]);
        }
        // Pass through to real execFileSync for git and everything else
        return actual.execFileSync(
          cmd,
          args as string[],
          opts as Parameters<typeof actual.execFileSync>[2],
        ) as string;
      },
    ),
  };
});

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------
const options: CLIOptions = {
  configPath: '.charter',
  format: 'text',
  ciMode: false,
  yes: false,
};

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-repo-intel-test-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  ghResponder = null;
});

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  ghResponder = null;
});

// ---------------------------------------------------------------------------
// Fake data helpers
// ---------------------------------------------------------------------------
const fakeOpenIssues = [
  {
    number: 1,
    title: 'Fix bug in auth flow',
    labels: [{ name: 'bug' }],
    assignees: [],
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-10T00:00:00Z',
    comments: 2,
  },
  {
    number: 2,
    title: 'Improve onboarding docs',
    labels: [{ name: 'docs' }],
    assignees: [],
    createdAt: '2026-03-01T00:00:00Z',
    // Old updatedAt — should count as stalled (>30 days ago from 2026-05-23)
    updatedAt: '2026-03-01T00:00:00Z',
    comments: 0,
  },
];

const fakeClosedIssues = [
  { number: 3, title: 'Old bug 1', labels: [{ name: 'bug' }], closedAt: '2026-02-01T00:00:00Z' },
  { number: 4, title: 'Old bug 2', labels: [{ name: 'bug' }], closedAt: '2026-02-10T00:00:00Z' },
  { number: 5, title: 'Old bug 3', labels: [{ name: 'bug' }], closedAt: '2026-02-15T00:00:00Z' },
];

const fakePRs = [
  {
    number: 10,
    title: 'feat: new feature',
    state: 'MERGED',
    author: { login: 'alice' },
    // Merged 5 days ago — should count toward mergeVelocity
    mergedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: '2026-05-10T00:00:00Z',
    reviewDecision: 'APPROVED',
    labels: [],
  },
];

const fakeReleases = [
  // 9 days apart → releaseCadence should be 9
  { tagName: 'v1.0.0', publishedAt: '2026-05-01T00:00:00Z', isLatest: false },
  { tagName: 'v1.1.0', publishedAt: '2026-05-10T00:00:00Z', isLatest: true },
];

function makeFullGhResponder(): GhResponder {
  return (args: string[]) => {
    if (args[0] === '--version') return 'gh version 2.0.0 (2026-01-01)';
    if (args[0] === 'issue') {
      // args: ['issue', 'list', '--limit', '50', '--state', 'open', '--json', '...']
      const stateIdx = args.indexOf('--state');
      const state = stateIdx >= 0 ? args[stateIdx + 1] : undefined;
      if (state === 'open') return JSON.stringify(fakeOpenIssues);
      if (state === 'closed') return JSON.stringify(fakeClosedIssues);
      return '[]';
    }
    if (args[0] === 'pr') return JSON.stringify(fakePRs);
    if (args[0] === 'release') return JSON.stringify(fakeReleases);
    return '[]';
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('context-refresh repo-intel source', () => {
  it('writes .charter/repo-intel/snapshot.json and summary contains openIssueCount', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    ghResponder = makeFullGhResponder();

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await contextRefreshCommand(
      { ...options, format: 'json' },
      ['--sources', 'repo-intel'],
    );
    expect(exitCode).toBe(0);

    // Snapshot file must be written
    const snapshotPath = path.join(tmp, '.charter', 'repo-intel', 'snapshot.json');
    expect(fs.existsSync(snapshotPath)).toBe(true);

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
      available: boolean;
      summary: {
        openIssueCount: number;
        stalledIssues: number;
        recurringLabels: string[];
        mergeVelocity: number;
        releaseCadence: number | null;
      };
      openIssues: unknown[];
      closedIssues: unknown[];
      pullRequests: unknown[];
      releases: unknown[];
    };

    expect(snapshot.available).toBe(true);
    expect(snapshot.summary.openIssueCount).toBe(2);
    // Issue 2 was last updated 2026-03-01, which is >30 days before 2026-05-23
    expect(snapshot.summary.stalledIssues).toBeGreaterThanOrEqual(1);
    // "bug" label appears 3 times in closed issues
    expect(snapshot.summary.recurringLabels).toContain('bug');
    // PR merged 5 days ago is within 30-day window
    expect(snapshot.summary.mergeVelocity).toBeGreaterThanOrEqual(1);
    // Two releases 9 days apart → cadence of 9
    expect(snapshot.summary.releaseCadence).toBe(9);
    // Raw arrays are present
    expect(Array.isArray(snapshot.openIssues)).toBe(true);
    expect(snapshot.openIssues).toHaveLength(2);
    expect(Array.isArray(snapshot.closedIssues)).toBe(true);
    expect(snapshot.closedIssues).toHaveLength(3);
    expect(Array.isArray(snapshot.pullRequests)).toBe(true);
    expect(Array.isArray(snapshot.releases)).toBe(true);
  });

  it('source appears in sourcesUsed and produces repo-intel entries in context.adf', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    ghResponder = makeFullGhResponder();

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((v?: unknown) => { logs.push(String(v ?? '')); });

    const exitCode = await contextRefreshCommand(
      { ...options, format: 'json' },
      ['--sources', 'repo-intel'],
    );
    expect(exitCode).toBe(0);

    const payload = JSON.parse(logs[0]) as { sourcesUsed: string[]; warnings: string[] };
    expect(payload.sourcesUsed).toContain('repo-intel');
    expect(payload.warnings).toHaveLength(0);

    const adf = fs.readFileSync(path.join(tmp, '.ai', 'context.adf'), 'utf8');
    expect(adf).toContain('repo-intel');
  });

  it('skips gracefully when gh CLI is not available — warning but no hard error', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    // Leave ghResponder = null → mock throws ENOENT for any gh call
    ghResponder = null;

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((v?: unknown) => { logs.push(String(v ?? '')); });

    const exitCode = await contextRefreshCommand(
      { ...options, format: 'json' },
      ['--sources', 'repo-intel'],
    );
    expect(exitCode).toBe(0);

    const payload = JSON.parse(logs[0]) as {
      status: string;
      sourcesUsed: string[];
      warnings: string[];
      errors: string[];
    };

    // Graceful degradation: ok status, a warning, no errors
    expect(payload.status).toBe('ok');
    expect(payload.sourcesUsed).not.toContain('repo-intel');
    expect(payload.warnings.some((w) => w.includes('repo-intel'))).toBe(true);
    expect(payload.errors).toHaveLength(0);

    // Snapshot file must NOT be written when gh is unavailable
    const snapshotPath = path.join(tmp, '.charter', 'repo-intel', 'snapshot.json');
    expect(fs.existsSync(snapshotPath)).toBe(false);
  });
});

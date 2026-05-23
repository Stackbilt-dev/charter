import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { parseAllTrailers, assessCommitRisk } from '@stackbilt/git';
import type { GitCommit } from '@stackbilt/types';
import { runGit, isGitRepo, hasCommits, parseCommitMetadata, parseChangedFilesByCommit } from '../git-helpers';
import { loadPatterns } from '../config';

type Signal = 'ok' | 'warn' | 'fail';

interface SnapshotResult {
  inGitRepo: boolean;
  hasBaseline: boolean;
  commitsScanned: number;
  coveragePercent: number;
  highRiskUnlinked: number;
  activePatterns: number;
  nextAction: string;
}

function coverageSignal(pct: number): Signal {
  if (pct >= 50) return 'ok';
  if (pct >= 10) return 'warn';
  return 'fail';
}

function patternSignal(count: number): Signal {
  if (count >= 3) return 'ok';
  if (count >= 1) return 'warn';
  return 'fail';
}

function signalTag(s: Signal): string {
  return s === 'ok' ? '' : s === 'warn' ? '  [warn]' : '  [fail]';
}

export async function quickstartCommand(options: CLIOptions): Promise<number> {
  const snapshot = getSnapshot(options.configPath);

  if (options.format === 'json') {
    console.log(JSON.stringify(snapshot, null, 2));
    return EXIT_CODE.SUCCESS;
  }

  if (snapshot.hasBaseline) {
    return printPostureView(snapshot, options.ciMode);
  }

  return printAdoptionPitch(snapshot);
}

function printPostureView(snapshot: SnapshotResult, ci: boolean): number {
  const covSig = coverageSignal(snapshot.coveragePercent);
  const patSig = patternSignal(snapshot.activePatterns);
  const hasFail = covSig === 'fail' || patSig === 'fail';

  const date = new Date().toISOString().slice(0, 10);
  console.log('');
  console.log(`  charter — governance snapshot (${date})`);
  console.log(`    Coverage:  ${snapshot.coveragePercent}% of last ${snapshot.commitsScanned} commits${signalTag(covSig)}`);
  console.log(`    Patterns:  ${snapshot.activePatterns} active${signalTag(patSig)}`);
  if (snapshot.highRiskUnlinked > 0) {
    console.log(`    Risk:      ${snapshot.highRiskUnlinked} high-risk commit(s) without governance links  [warn]`);
  }
  console.log('');
  console.log("  Run 'charter audit' for full report · 'charter why' for adoption info");
  console.log('');

  return ci && hasFail ? EXIT_CODE.POLICY_VIOLATION : EXIT_CODE.SUCCESS;
}

function printAdoptionPitch(snapshot: SnapshotResult): number {
  console.log('');
  console.log('  Charter Quickstart');
  console.log('  Turns governance from abstract policy into merge-time guardrails.');
  console.log('');
  console.log('  Repo snapshot:');
  console.log(`    - Git repo: ${snapshot.inGitRepo ? 'yes' : 'no'}`);
  console.log(`    - Governance baseline (.charter): ${snapshot.hasBaseline ? 'installed' : 'missing'}`);
  console.log(`    - Recent commits scanned: ${snapshot.commitsScanned}`);
  console.log(`    - Governance-linked commit coverage: ${snapshot.coveragePercent}%`);
  console.log(`    - High-risk commits without governance links: ${snapshot.highRiskUnlinked}`);
  console.log('');
  console.log('  Why teams use Charter:');
  console.log('    - Catch risky, unreviewed changes before merge');
  console.log('    - Create an auditable trail from code changes to governance decisions');
  console.log('    - Keep policy checks consistent across local dev and CI');
  console.log('');
  console.log(`  Next action: ${snapshot.nextAction}`);
  console.log('');

  return EXIT_CODE.SUCCESS;
}

export async function whyCommand(options: CLIOptions): Promise<number> {
  if (options.format === 'json') {
    console.log(JSON.stringify({
      problem: 'Teams lose context on risky changes and approvals become inconsistent.',
      charterSolves: [
        'Enforces governance trailers for significant changes',
        'Scans for stack drift against blessed patterns',
        'Produces repeatable audit evidence for PRs and reviews',
      ],
      value: [
        'Lower probability of breaking changes landing without architectural context',
        'Faster reviews because reviewers see linked decisions in commit metadata',
        'Clear governance posture for leadership and compliance reporting',
      ],
      start: 'charter setup --ci github',
    }, null, 2));
    return EXIT_CODE.SUCCESS;
  }

  console.log('');
  console.log('  Why Charter');
  console.log('');
  console.log('  Problem it solves:');
  console.log('    Governance intent lives in docs, but risky changes merge without clear decision links.');
  console.log('');
  console.log('  What Charter does:');
  console.log('    - Enforces commit-level governance links for significant changes');
  console.log('    - Detects drift from your blessed architecture patterns');
  console.log('    - Generates audit output leadership and reviewers can actually use');
  console.log('');
  console.log('  Expected payoff:');
  console.log('    - Fewer high-impact surprises in production');
  console.log('    - Faster review cycles with clearer architectural accountability');
  console.log('    - Consistent governance behavior across repos');
  console.log('');
  console.log('  Start here: charter setup --ci github');
  console.log('');

  return EXIT_CODE.SUCCESS;
}

function getSnapshot(configPath: string): SnapshotResult {
  const inGitRepo = isGitRepo();
  const hasBaseline = fs.existsSync(path.join(configPath, 'config.json'));
  const activePatterns = hasBaseline ? loadPatterns(configPath).filter((p) => p.status === 'ACTIVE').length : 0;

  if (!inGitRepo) {
    return {
      inGitRepo,
      hasBaseline,
      commitsScanned: 0,
      coveragePercent: 0,
      highRiskUnlinked: 0,
      activePatterns,
      nextAction: 'Run this inside a git repository, then run: charter setup --ci github',
    };
  }

  const commits = hasCommits() ? getRecentCommits(20) : [];
  const parsed = parseAllTrailers(commits);

  const linked = new Set<string>();
  for (const t of parsed.governedBy) linked.add(t.commitSha);
  for (const t of parsed.resolvesRequest) linked.add(t.commitSha);

  let highRiskUnlinked = 0;
  for (const commit of commits) {
    if (!linked.has(commit.sha) && assessCommitRisk(commit.files_changed, commit.message) === 'HIGH') {
      highRiskUnlinked++;
    }
  }

  const coveragePercent = commits.length > 0 ? Math.round((linked.size / commits.length) * 100) : 0;
  const nextAction = !hasBaseline
    ? 'Run: charter setup --ci github'
    : highRiskUnlinked > 0
      ? 'Run: charter validate --format text and add Governed-By trailers to high-risk commits'
      : 'Run: charter audit --format text for a shareable governance posture report';

  return {
    inGitRepo,
    hasBaseline,
    commitsScanned: commits.length,
    coveragePercent,
    highRiskUnlinked,
    activePatterns,
    nextAction,
  };
}

function getRecentCommits(count: number): GitCommit[] {
  try {
    const metadataLog = runGit(['log', `-${count}`, '--format=%H%x1f%an%x1f%aI%x1f%B%x1e']);
    const filesLog = runGit(['log', `-${count}`, '--name-only', '--format=%H']);

    const filesBySha = parseChangedFilesByCommit(filesLog);
    return parseCommitMetadata(metadataLog).map((commit) => ({
      ...commit,
      files_changed: filesBySha.get(commit.sha) || [],
    }));
  } catch {
    return [];
  }
}

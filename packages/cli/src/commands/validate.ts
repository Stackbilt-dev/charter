/**
 * charter validate
 *
 * Validates recent git commits for governance trailers.
 * Checks that high-risk commits reference ADRs or governance requests.
 */

import { execFileSync } from 'node:child_process';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import type { GitCommit } from '@stackbilt/types';
import { loadConfig } from '../config';
import { parseAllTrailers } from '@stackbilt/git';
import { assessCommitRisk, generateSuggestions } from '@stackbilt/git';

interface LocalValidationResult {
  status: 'PASS' | 'WARN' | 'FAIL';
  summary: string;
  commits: number;
  trailersFound: number;
  highRiskUnlinked: number;
  suggestions: string[];
}

export async function validateCommand(options: CLIOptions, args: string[]): Promise<number> {
  const config = loadConfig(options.configPath);

  const range = getCommitRange(args);
  const commits = getGitCommits(range);

  if (commits.length === 0) {
    if (options.format === 'json') {
      console.log(JSON.stringify({ status: 'PASS', summary: 'No commits to validate.' }, null, 2));
    } else {
      console.log('  No commits to validate.');
    }
    return EXIT_CODE.SUCCESS;
  }

  const result = validateCommits(commits, config.git.trailerThreshold);

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }

  if (options.ciMode && (result.status === 'FAIL' || (config.ci.failOnWarn && result.status === 'WARN'))) {
    return EXIT_CODE.POLICY_VIOLATION;
  }

  return EXIT_CODE.SUCCESS;
}

function validateCommits(
  commits: GitCommit[],
  threshold: 'LOW' | 'MEDIUM' | 'HIGH'
): LocalValidationResult {
  const parsed = parseAllTrailers(commits);

  const linkedCommits = new Set<string>();
  parsed.governedBy.forEach((t) => linkedCommits.add(t.commitSha));
  parsed.resolvesRequest.forEach((t) => linkedCommits.add(t.commitSha));

  const unlinked: Array<{ sha: string; message: string; risk: string }> = [];
  let highRiskUnlinked = 0;

  const thresholdRanks: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  const thresholdRank = thresholdRanks[threshold];

  for (const commit of commits) {
    if (!linkedCommits.has(commit.sha)) {
      const risk = assessCommitRisk(commit.files_changed, commit.message);
      const riskRank = thresholdRanks[risk];

      if (riskRank >= thresholdRank) {
        unlinked.push({ sha: commit.sha, message: commit.message.split('\n')[0], risk });
        if (risk === 'HIGH') highRiskUnlinked++;
      }
    }
  }

  const trailers = {
    governed_by: parsed.governedBy.map((t) => ({
      commit_sha: t.commitSha,
      reference: t.reference,
      valid: true,
      resolved_id: null,
      ledger_entry_id: null,
    })),
    resolves_request: parsed.resolvesRequest.map((t) => ({
      commit_sha: t.commitSha,
      reference: t.reference,
      valid: true,
      resolved_id: null,
      request_id: null,
    })),
  };

  const unlinkedForSuggestions = unlinked.map((u) => ({
    sha: u.sha,
    short_sha: u.sha.slice(0, 7),
    message_first_line: u.message.slice(0, 72),
    risk_level: u.risk as 'LOW' | 'MEDIUM' | 'HIGH',
    suggestion: u.risk === 'HIGH'
      ? 'HIGH-risk changes should reference governance. Add: Governed-By: <adr-id>'
      : 'Consider adding governance reference for traceability.',
  }));

  const suggestions = generateSuggestions(trailers, unlinkedForSuggestions, commits.length);

  let status: 'PASS' | 'WARN' | 'FAIL';
  if (highRiskUnlinked > 0) {
    status = 'FAIL';
  } else if (unlinked.length > 0) {
    status = 'WARN';
  } else {
    status = 'PASS';
  }

  const totalTrailers = parsed.governedBy.length + parsed.resolvesRequest.length;

  return {
    status,
    summary: status === 'PASS'
      ? `All ${commits.length} commit(s) pass governance checks.`
      : `${unlinked.length} commit(s) above ${threshold} risk threshold without governance trailers.`,
    commits: commits.length,
    trailersFound: totalTrailers,
    highRiskUnlinked,
    suggestions,
  };
}

function printResult(result: LocalValidationResult): void {
  const icon = result.status === 'PASS' ? '[ok]' : result.status === 'WARN' ? '[warn]' : '[fail]';

  console.log(`\n  ${icon} ${result.status}: ${result.summary}`);
  console.log(`     Commits: ${result.commits} | Trailers found: ${result.trailersFound}`);

  if (result.suggestions.length > 0) {
    console.log('');
    console.log('  Suggestions:');
    for (const s of result.suggestions) {
      console.log(`    - ${s}`);
    }
  }

  console.log('');
}

function getCommitRange(args: string[]): string {
  const rangeIdx = args.indexOf('--range');
  if (rangeIdx !== -1 && rangeIdx + 1 < args.length) {
    return args[rangeIdx + 1];
  }

  try {
    const currentBranch = runGit(['rev-parse', 'HEAD']).trim();

    let baseBranch = '';
    try {
      baseBranch = runGit(['rev-parse', '--verify', 'main']).trim();
    } catch {
      baseBranch = runGit(['rev-parse', '--verify', 'master']).trim();
    }

    if (!baseBranch || baseBranch === currentBranch) {
      return 'HEAD~5..HEAD';
    }

    return `${baseBranch}..HEAD`;
  } catch {
    return 'HEAD~5..HEAD';
  }
}

function getGitCommits(range: string): GitCommit[] {
  try {
    const log = runGit(['log', range, '--format=%H|%an|%aI|%s', '--name-only']);

    const commits: GitCommit[] = [];
    let current: GitCommit | null = null;

    for (const line of log.split('\n')) {
      if (line.includes('|') && line.length > 40) {
        if (current) commits.push(current);
        const [sha, author, timestamp, ...msgParts] = line.split('|');
        current = {
          sha,
          author,
          timestamp,
          message: msgParts.join('|'),
          files_changed: [],
        };
      } else if (line.trim() && current) {
        current.files_changed!.push(line.trim());
      }
    }

    if (current) commits.push(current);
    return commits;
  } catch {
    return [];
  }
}

function runGit(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

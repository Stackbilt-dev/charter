/**
 * charter validate
 *
 * Validates recent git commits for governance trailers.
 * Checks that high-risk commits reference ADRs or governance requests.
 */

import { execSync } from 'node:child_process';
import type { CLIOptions } from '../index';
import type { GitCommit } from '@charter/types';
import { loadConfig } from '../config';
import { parseAllTrailers } from '@charter/git';
import { assessCommitRisk, generateSuggestions } from '@charter/git';

interface LocalValidationResult {
  status: 'PASS' | 'WARN' | 'FAIL';
  summary: string;
  commits: number;
  trailersFound: number;
  highRiskUnlinked: number;
  suggestions: string[];
}

export async function validateCommand(options: CLIOptions, args: string[]): Promise<void> {
  const config = loadConfig(options.configPath);

  // Get commit range
  const range = getCommitRange(args);
  const commits = getGitCommits(range);

  if (commits.length === 0) {
    console.log('  No commits to validate.');
    return;
  }

  const result = validateCommits(commits, config.git.trailerThreshold);

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }

  if (options.ciMode && (result.status === 'FAIL' || (config.ci.failOnWarn && result.status === 'WARN'))) {
    process.exit(1);
  }
}

function validateCommits(
  commits: GitCommit[],
  threshold: 'LOW' | 'MEDIUM' | 'HIGH'
): LocalValidationResult {
  const parsed = parseAllTrailers(commits);

  // Track which commits have trailers
  const linkedCommits = new Set<string>();
  parsed.governedBy.forEach(t => linkedCommits.add(t.commitSha));
  parsed.resolvesRequest.forEach(t => linkedCommits.add(t.commitSha));

  // Find unlinked commits and assess risk
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

  // Build suggestions using the kit's generateSuggestions
  const trailers = {
    governed_by: parsed.governedBy.map(t => ({
      commit_sha: t.commitSha,
      reference: t.reference,
      valid: true, // Can't validate without DB — mark as valid locally
      resolved_id: null,
      ledger_entry_id: null,
    })),
    resolves_request: parsed.resolvesRequest.map(t => ({
      commit_sha: t.commitSha,
      reference: t.reference,
      valid: true,
      resolved_id: null,
      request_id: null,
    })),
  };

  const unlinkedForSuggestions = unlinked.map(u => ({
    sha: u.sha,
    short_sha: u.sha.slice(0, 7),
    message_first_line: u.message.slice(0, 72),
    risk_level: u.risk as 'LOW' | 'MEDIUM' | 'HIGH',
    suggestion: u.risk === 'HIGH'
      ? 'HIGH-risk changes should reference governance. Add: Governed-By: <adr-id>'
      : 'Consider adding governance reference for traceability.',
  }));

  const suggestions = generateSuggestions(trailers, unlinkedForSuggestions, commits.length);

  // Determine status
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
  const icon = result.status === 'PASS' ? '✅' : result.status === 'WARN' ? '⚠️' : '❌';

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
  // Check for explicit range
  const rangeIdx = args.indexOf('--range');
  if (rangeIdx !== -1 && rangeIdx + 1 < args.length) {
    return args[rangeIdx + 1];
  }

  // Default: commits on current branch not on main/master
  try {
    const mainBranch = execSync('git rev-parse --verify main 2>/dev/null || git rev-parse --verify master 2>/dev/null', {
      encoding: 'utf-8',
    }).trim();
    const currentBranch = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();

    if (mainBranch === currentBranch) {
      // On main — validate last 5 commits
      return 'HEAD~5..HEAD';
    }

    return `${mainBranch}..HEAD`;
  } catch {
    // Fallback: last 5 commits
    return 'HEAD~5..HEAD';
  }
}

function getGitCommits(range: string): GitCommit[] {
  try {
    const log = execSync(
      `git log ${range} --format='%H|%an|%aI|%s' --name-only`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );

    const commits: GitCommit[] = [];
    let current: GitCommit | null = null;

    for (const line of log.split('\n')) {
      if (line.includes('|') && line.length > 40) {
        // New commit line: sha|author|timestamp|subject
        if (current) commits.push(current);
        const [sha, author, timestamp, ...msgParts] = line.split('|');
        current = {
          sha: sha.replace(/'/g, ''),
          author,
          timestamp,
          message: msgParts.join('|'),
          files_changed: [],
        };
      } else if (line.trim() && current) {
        // File changed line
        current.files_changed!.push(line.trim());
      }
    }

    if (current) commits.push(current);
    return commits;
  } catch {
    return [];
  }
}

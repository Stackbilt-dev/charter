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
  commitRange: string;
  effectiveRangeSource: 'explicit' | 'branch-base' | 'recent-fallback';
  defaultCommitRange?: string;
  commits: number;
  trailersFound: number;
  highRiskUnlinked: number;
  strictTrailerMode: {
    active: boolean;
    mode: 'STRICT_ONLY' | 'RISK_ONLY' | 'STRICT_AND_RISK' | 'NONE';
    reason: string;
  };
  suggestions: string[];
  trailerParsingWarnings: TrailerParsingWarning[];
  evidence: {
    policyOffenders: OffenderCommit[];
    riskOffenders: OffenderCommit[];
  };
}

interface TrailerParsingWarning {
  sha: string;
  shortSha: string;
  subject: string;
  governanceLinesDetected: number;
  governanceTrailersParsed: number;
  warning: string;
}

interface OffenderCommit {
  classification: 'policy' | 'risk' | 'both';
  policyContextOnly?: boolean;
  sha: string;
  shortSha: string;
  subject: string;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  riskRuleId?: string;
  matchedSignals?: string[];
  thresholdSource?: string;
  policyReason?: string;
  riskReason: string;
  missingTrailers: string[];
  filesChangedCount: number;
}

interface GitCommitLoadResult {
  commits: GitCommit[];
  error?: string;
}

export async function validateCommand(options: CLIOptions, args: string[]): Promise<number> {
  const config = loadConfig(options.configPath);

  if (!hasCommits()) {
    if (options.format === 'json') {
      console.log(JSON.stringify({ status: 'PASS', summary: 'No commits to validate.' }, null, 2));
    } else {
      console.log('  No commits to validate.');
    }
    return EXIT_CODE.SUCCESS;
  }

  const rangeInfo = getCommitRangeInfo(args);
  const range = rangeInfo.range;
  const commitLoad = getGitCommits(range);

  if (commitLoad.error) {
    if (options.format === 'json') {
      console.log(JSON.stringify({
        status: 'ERROR',
        summary: 'Failed to read git commits for validation.',
        details: commitLoad.error,
      }, null, 2));
    } else {
      console.log('  [fail] Failed to read git commits for validation.');
      console.log(`  ${commitLoad.error}`);
    }
    return EXIT_CODE.RUNTIME_ERROR;
  }

  const commits = commitLoad.commits;

  if (commits.length === 0) {
    if (options.format === 'json') {
      console.log(JSON.stringify({ status: 'PASS', summary: 'No commits to validate.' }, null, 2));
    } else {
      console.log('  No commits to validate.');
    }
    return EXIT_CODE.SUCCESS;
  }

  const result = validateCommits(commits, rangeInfo, config.git.trailerThreshold, {
    requireTrailers: config.git.requireTrailers,
    citationStrictness: config.validation.citationStrictness,
  });

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
  rangeInfo: {
    range: string;
    source: 'explicit' | 'branch-base' | 'recent-fallback';
  },
  threshold: 'LOW' | 'MEDIUM' | 'HIGH',
  policy: {
    requireTrailers: boolean;
    citationStrictness: 'FAIL' | 'STRICT' | 'WARN' | 'PERMISSIVE';
  }
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
  const trailerParsingWarnings = detectTrailerParsingWarnings(commits, parsed);
  if (trailerParsingWarnings.length > 0) {
    suggestions.push(
      'Governance trailer-like lines were found in commit bodies but not parsed as git trailers; keep trailers as one contiguous block at the end of the commit message.'
    );
  }
  const totalTrailers = parsed.governedBy.length + parsed.resolvesRequest.length;

  let status: 'PASS' | 'WARN' | 'FAIL';
  let summary: string;

  if (highRiskUnlinked > 0) {
    status = 'FAIL';
    summary = `${unlinked.length} commit(s) above ${threshold} risk threshold without governance trailers.`;
  } else if (policy.requireTrailers && totalTrailers === 0) {
    status = policy.citationStrictness === 'FAIL' || policy.citationStrictness === 'STRICT' ? 'FAIL' : 'WARN';
    summary = `No governance trailers found across ${commits.length} commit(s) in scope.`;
  } else if (unlinked.length > 0) {
    status = 'WARN';
    summary = `${unlinked.length} commit(s) above ${threshold} risk threshold without governance trailers.`;
  } else {
    status = 'PASS';
    summary = `All ${commits.length} commit(s) pass governance checks.`;
  }

  return {
    status,
    summary,
    commitRange: rangeInfo.range,
    effectiveRangeSource: rangeInfo.source,
    defaultCommitRange: rangeInfo.source === 'explicit' ? undefined : rangeInfo.range,
    commits: commits.length,
    trailersFound: totalTrailers,
    highRiskUnlinked,
    strictTrailerMode: {
      active: policy.requireTrailers && totalTrailers === 0,
      mode: policy.requireTrailers && totalTrailers === 0
        ? (unlinked.length > 0 ? 'STRICT_AND_RISK' : 'STRICT_ONLY')
        : (unlinked.length > 0 ? 'RISK_ONLY' : 'NONE'),
      reason: policy.requireTrailers && totalTrailers === 0
        ? `requireTrailers=true and no trailers found in range (${policy.citationStrictness}).`
        : 'strict trailer mode not triggered',
    },
    suggestions,
    trailerParsingWarnings,
    evidence: {
      policyOffenders: buildPolicyOffenders(
        commits,
        policy.requireTrailers && totalTrailers === 0
      ),
      riskOffenders: buildRiskOffenders(
        commits,
        unlinked,
        threshold
      ),
    },
  };
}

function buildPolicyOffenders(
  commits: GitCommit[],
  strictModeActive: boolean
): OffenderCommit[] {
  if (!strictModeActive) return [];
  return commits.map((commit) => {
    const filesChanged = commit.files_changed || [];
    const subject = commit.message.split('\n')[0].slice(0, 200);
    return {
      classification: 'policy',
      policyContextOnly: true,
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      subject,
      policyReason: 'Missing required governance trailers under strict trailer mode.',
      riskReason: 'Missing required governance trailers under strict trailer mode.',
      missingTrailers: ['Governed-By', 'Resolves-Request'],
      filesChangedCount: filesChanged.length,
    };
  });
}

function buildRiskOffenders(
  commits: GitCommit[],
  thresholdUnlinked: Array<{ sha: string; message: string; risk: string }>,
  threshold: 'LOW' | 'MEDIUM' | 'HIGH'
): OffenderCommit[] {
  const thresholdMap = new Map<string, { message: string; risk: string }>();
  for (const item of thresholdUnlinked) {
    thresholdMap.set(item.sha, item);
  }

  const targetCommits = commits.filter((commit) => thresholdMap.has(commit.sha));

  return targetCommits.map((commit) => {
    const thresholdHit = thresholdMap.get(commit.sha);
    const filesChanged = commit.files_changed || [];
    const subject = (thresholdHit?.message || commit.message.split('\n')[0]).slice(0, 200);
    const riskMeta = getRiskMeta(filesChanged, subject);
    const riskLevel = (thresholdHit?.risk as 'LOW' | 'MEDIUM' | 'HIGH') || assessCommitRisk(filesChanged, subject);

    return {
      classification: 'risk',
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      subject,
      riskLevel,
      riskRuleId: riskMeta.ruleId,
      matchedSignals: riskMeta.signals,
      thresholdSource: `config.git.trailerThreshold=${threshold}`,
      riskReason: riskMeta.reason,
      missingTrailers: ['Governed-By', 'Resolves-Request'],
      filesChangedCount: filesChanged.length,
    };
  });
}

function getRiskMeta(filesChanged: string[], subject: string): {
  ruleId: string;
  signals: string[];
  reason: string;
} {
  const lowered = `${subject}\n${filesChanged.join('\n')}`.toLowerCase();
  const signals: string[] = [];

  if (lowered.includes('migration') || lowered.includes('/migrations/')) {
    signals.push('migration-keyword-or-path');
  }
  if (lowered.includes('schema') || lowered.includes('model')) {
    signals.push('schema-or-model-keyword');
  }
  if (lowered.includes('auth') || lowered.includes('security')) {
    signals.push('auth-or-security-keyword');
  }
  if (filesChanged.length >= 10) {
    signals.push('large-change-footprint');
  }

  if (signals.length === 0) {
    return {
      ruleId: 'risk.generic.threshold',
      signals: ['generic-threshold-match'],
      reason: 'Exceeded configured governance risk threshold based on commit content.',
    };
  }

  if (signals.includes('migration-keyword-or-path')) {
    return {
      ruleId: 'risk.migration.path_or_keyword',
      signals,
      reason: 'Touches migration-related paths or message keywords.',
    };
  }
  if (signals.includes('schema-or-model-keyword')) {
    return {
      ruleId: 'risk.schema_or_model.keyword',
      signals,
      reason: 'Touches schema/model related changes.',
    };
  }
  if (signals.includes('auth-or-security-keyword')) {
    return {
      ruleId: 'risk.auth_or_security.keyword',
      signals,
      reason: 'Touches auth/security related code or message keywords.',
    };
  }
  if (signals.includes('large-change-footprint')) {
    return {
      ruleId: 'risk.change_footprint.large',
      signals,
      reason: 'Large change footprint by number of files changed.',
    };
  }

  return {
    ruleId: 'risk.generic.threshold',
    signals,
    reason: 'Exceeded configured governance risk threshold based on commit content.',
  };
}


function printResult(result: LocalValidationResult): void {
  const icon = result.status === 'PASS' ? '[ok]' : result.status === 'WARN' ? '[warn]' : '[fail]';

  console.log(`\n  ${icon} ${result.status}: ${result.summary}`);
  console.log(`     Commit range: ${result.commitRange}`);
  console.log(`     Range source: ${result.effectiveRangeSource}`);
  console.log(`     Commits: ${result.commits} | Trailers found: ${result.trailersFound}`);

  if (result.suggestions.length > 0) {
    console.log('');
    console.log('  Suggestions:');
    for (const s of result.suggestions) {
      console.log(`    - ${s}`);
    }
  }

  if (result.trailerParsingWarnings.length > 0) {
    console.log('');
    console.log('  Trailer parsing warnings:');
    for (const warning of result.trailerParsingWarnings.slice(0, 10)) {
      console.log(`    - ${warning.shortSha} ${warning.subject}`);
      console.log(`      ${warning.warning}`);
    }
  }

  if (result.evidence.policyOffenders.length > 0) {
    console.log('');
    console.log('  Policy offenders (strict trailer mode):');
    for (const commit of result.evidence.policyOffenders.slice(0, 10)) {
      console.log(`    - ${commit.shortSha} ${commit.subject}`);
      console.log(`      Reason: ${commit.policyReason || commit.riskReason}`);
    }
  }

  if (result.evidence.riskOffenders.length > 0) {
    console.log('');
    console.log('  Risk offenders (threshold-driven):');
    for (const commit of result.evidence.riskOffenders.slice(0, 10)) {
      console.log(`    - ${commit.shortSha} [${commit.riskLevel || 'N/A'}] ${commit.subject}`);
      console.log(`      Reason: ${commit.riskReason}`);
    }
  }

  console.log('');
}

function getCommitRangeInfo(args: string[]): { range: string; source: 'explicit' | 'branch-base' | 'recent-fallback' } {
  const rangeIdx = args.indexOf('--range');
  if (rangeIdx !== -1 && rangeIdx + 1 < args.length) {
    return {
      range: args[rangeIdx + 1],
      source: 'explicit',
    };
  }

  const recentRange = getRecentCommitRange();

  try {
    const currentBranch = runGit(['rev-parse', 'HEAD']).trim();
    let baseBranch = '';
    try {
      baseBranch = runGit(['rev-parse', '--verify', 'main']).trim();
    } catch {
      baseBranch = runGit(['rev-parse', '--verify', 'master']).trim();
    }

    if (!baseBranch || baseBranch === currentBranch) {
      return {
        range: recentRange,
        source: 'recent-fallback',
      };
    }

    return {
      range: `${baseBranch}..HEAD`,
      source: 'branch-base',
    };
  } catch {
    return {
      range: recentRange,
      source: 'recent-fallback',
    };
  }
}

function getGitCommits(range: string): GitCommitLoadResult {
  try {
    const metadataLog = runGit(['log', range, '--format=%H%x1f%an%x1f%aI%x1f%B%x1e']);
    const filesLog = runGit(['log', range, '--name-only', '--format=%H']);
    const filesBySha = parseChangedFilesByCommit(filesLog);
    const commits = parseCommitMetadata(metadataLog).map((commit) => ({
      ...commit,
      files_changed: filesBySha.get(commit.sha) || [],
    }));
    return { commits };
  } catch (error) {
    return {
      commits: [],
      error: getGitErrorMessage(error),
    };
  }
}

function detectTrailerParsingWarnings(
  commits: GitCommit[],
  parsed: ReturnType<typeof parseAllTrailers>
): TrailerParsingWarning[] {
  const parsedCountByCommit = new Map<string, number>();

  for (const trailer of parsed.governedBy) {
    parsedCountByCommit.set(trailer.commitSha, (parsedCountByCommit.get(trailer.commitSha) || 0) + 1);
  }
  for (const trailer of parsed.resolvesRequest) {
    parsedCountByCommit.set(trailer.commitSha, (parsedCountByCommit.get(trailer.commitSha) || 0) + 1);
  }

  const warnings: TrailerParsingWarning[] = [];
  const governanceLinePattern = /^(Governed-By|Resolves-Request):\s*(.+)$/i;

  for (const commit of commits) {
    const messageLines = commit.message.split(/\r?\n/);
    const governanceLinesDetected = messageLines.filter((line) => governanceLinePattern.test(line.trim())).length;
    if (governanceLinesDetected === 0) continue;

    const governanceTrailersParsed = parsedCountByCommit.get(commit.sha) || 0;
    if (governanceTrailersParsed >= governanceLinesDetected) continue;

    warnings.push({
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      subject: commit.message.split('\n')[0].slice(0, 200),
      governanceLinesDetected,
      governanceTrailersParsed,
      warning: `Detected ${governanceLinesDetected} governance trailer-like line(s), but parsed ${governanceTrailersParsed} as git trailers. Check for blank lines splitting the terminal trailer block.`,
    });
  }

  return warnings;
}

function parseCommitMetadata(logOutput: string): Array<Omit<GitCommit, 'files_changed'>> {
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

function parseChangedFilesByCommit(logOutput: string): Map<string, string[]> {
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

function hasCommits(): boolean {
  try {
    runGit(['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

function getRecentCommitRange(): string {
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

function getGitErrorMessage(error: unknown): string {
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

function runGit(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

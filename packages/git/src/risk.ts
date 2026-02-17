/**
 * Commit Risk Assessment
 *
 * Assesses the risk level of commits based on changed files and message content.
 * Used to determine which commits should have governance trailers.
 *
 * Extracted from Charter Cloud (RFC-2025-004).
 */

import type { CommitRiskLevel, GitValidationTrailers, UnlinkedCommit } from '@stackbilt/types';

// ============================================================================
// Risk Patterns (configurable per-project in future)
// ============================================================================

const HIGH_RISK_PATTERNS = [
  /^worker\/handlers\//,
  /^worker\/services\//,
  /^worker\/mcp\//,
  /^migrations\//,
  /\.sql$/
];

const MEDIUM_RISK_PATTERNS = [
  /^worker\/lib\//,
  /^worker\/utils\//,
  /^components\//,
  /^context\//,
  /^lib\//
];

const LOW_RISK_PATTERNS = [
  /^templates\//,
  /\.md$/,
  /\.json$/,
  /\.ya?ml$/,
  /^\.github\//,
  /^test/i,
  /\.test\./,
  /\.spec\./
];

/**
 * Assess the risk level of a commit based on changed files.
 * Falls back to commit message keyword analysis if no files provided.
 */
export function assessCommitRisk(
  filesChanged: string[] | undefined,
  commitMessage: string
): CommitRiskLevel {
  if (!filesChanged || filesChanged.length === 0) {
    const msg = commitMessage.toLowerCase();
    if (msg.includes('migration') || msg.includes('handler') || msg.includes('security')) {
      return 'HIGH';
    }
    if (msg.includes('component') || msg.includes('refactor') || msg.includes('lib')) {
      return 'MEDIUM';
    }
    return 'LOW';
  }

  let hasHigh = false;
  let hasMedium = false;

  for (const file of filesChanged) {
    if (HIGH_RISK_PATTERNS.some(p => p.test(file))) {
      hasHigh = true;
      break;
    }
    if (MEDIUM_RISK_PATTERNS.some(p => p.test(file))) {
      hasMedium = true;
    }
  }

  if (hasHigh) return 'HIGH';
  if (hasMedium) return 'MEDIUM';
  return 'LOW';
}

/**
 * Generate overall suggestions based on validation results.
 */
export function generateSuggestions(
  trailers: GitValidationTrailers,
  unlinkedCommits: UnlinkedCommit[],
  totalCommits: number
): string[] {
  const suggestions: string[] = [];

  const linkedCommits = new Set<string>();
  trailers.governed_by.forEach(t => linkedCommits.add(t.commit_sha));
  trailers.resolves_request.forEach(t => linkedCommits.add(t.commit_sha));

  const coverage = linkedCommits.size / totalCommits;

  if (coverage === 0) {
    suggestions.push('No commits have governance trailers. Consider linking significant changes to ADRs.');
  } else if (coverage < 0.5) {
    suggestions.push(`Only ${Math.round(coverage * 100)}% of commits have governance trailers.`);
  }

  const invalidGoverned = trailers.governed_by.filter(t => !t.valid);
  const invalidRequests = trailers.resolves_request.filter(t => !t.valid);

  if (invalidGoverned.length > 0) {
    suggestions.push(`${invalidGoverned.length} Governed-By reference(s) could not be resolved.`);
  }
  if (invalidRequests.length > 0) {
    suggestions.push(`${invalidRequests.length} Resolves-Request reference(s) could not be resolved.`);
  }

  const highRiskUnlinked = unlinkedCommits.filter(c => c.risk_level === 'HIGH');
  if (highRiskUnlinked.length > 0) {
    suggestions.push(`${highRiskUnlinked.length} HIGH-risk commit(s) lack governance trailers.`);
  }

  return suggestions;
}

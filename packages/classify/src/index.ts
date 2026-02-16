/**
 * Change Classification (Heuristic)
 *
 * Classifies changes as SURFACE/LOCAL/CROSS_CUTTING using pattern matching.
 * No LLM required — pure heuristics, runs in <5ms.
 *
 * Extracted from Charter Cloud (Operating Charter §6.1).
 */

import type {
  ChangeClass,
  GovernanceStatus,
  ChangeRecommendation,
  ChangeClassification,
} from '@charter/types';

// ============================================================================
// Classification Patterns
// ============================================================================

const SURFACE_PATTERNS = [
  /\b(readme|doc|comment|typo|spelling|label|text|copy|i18n|localization)\b/i,
  /\b(rename|naming|variable name|constant name)\b/i,
  /\.(md|txt|json)$/i,
];

const CROSS_CUTTING_PATTERNS = [
  /\b(schema|migration|data model|database)\b/i,
  /\b(api|endpoint|contract|interface change)\b/i,
  /\b(workflow|orchestration|pipeline|dag)\b/i,
  /\b(integration|third[- ]?party|external)\b/i,
  /\b(infrastructure|deploy|cicd|github action)\b/i,
  /\b(auth|security|permission|rbac|oauth)\b/i,
  /\b(multi[- ]?service|cross[- ]?cutting|system[- ]?wide)\b/i,
];

// ============================================================================
// Public API
// ============================================================================

/**
 * Heuristic classification based on subject content.
 * Returns a suggested classification with confidence and signal list.
 */
export function heuristicClassify(subject: string): {
  suggestedClass: ChangeClass;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  signals: string[];
} {
  const signals: string[] = [];

  for (const pattern of SURFACE_PATTERNS) {
    if (pattern.test(subject)) {
      signals.push(`Surface pattern: ${pattern.source}`);
    }
  }

  for (const pattern of CROSS_CUTTING_PATTERNS) {
    if (pattern.test(subject)) {
      signals.push(`Cross-cutting pattern: ${pattern.source}`);
    }
  }

  const surfaceSignals = signals.filter(s => s.startsWith('Surface'));
  const crossCuttingSignals = signals.filter(s => s.startsWith('Cross-cutting'));

  if (crossCuttingSignals.length > 0) {
    return {
      suggestedClass: 'CROSS_CUTTING',
      confidence: crossCuttingSignals.length >= 2 ? 'HIGH' : 'MEDIUM',
      signals,
    };
  }

  if (surfaceSignals.length > 0 && crossCuttingSignals.length === 0) {
    return {
      suggestedClass: 'SURFACE',
      confidence: surfaceSignals.length >= 2 ? 'HIGH' : 'MEDIUM',
      signals,
    };
  }

  return {
    suggestedClass: 'LOCAL',
    confidence: 'LOW',
    signals: ['No strong patterns detected - defaulting to LOCAL'],
  };
}

/**
 * Determine recommendation based on classification and governance status.
 */
export function determineRecommendation(
  changeClass: ChangeClass,
  governanceStatus: GovernanceStatus,
  mitigationsRequired: boolean
): ChangeRecommendation {
  if (governanceStatus === 'VIOLATION') return 'REJECT';
  if (governanceStatus === 'NEEDS_REVIEW') return 'ESCALATE';
  if (changeClass === 'CROSS_CUTTING') {
    return mitigationsRequired ? 'APPROVE_WITH_MITIGATIONS' : 'ESCALATE';
  }
  if (mitigationsRequired) return 'APPROVE_WITH_MITIGATIONS';
  return 'APPROVE';
}

/**
 * Format a change classification for human-readable display.
 */
export function formatChangeClassification(classification: ChangeClassification): string {
  const sections: string[] = [];

  const classBadge = classification.changeClass === 'CROSS_CUTTING' ? '🔴'
    : classification.changeClass === 'LOCAL' ? '🟡'
    : '🟢';

  sections.push(`## ${classBadge} Change Classification: ${classification.changeClass}`);
  sections.push(`**Subject:** ${classification.subjectSummary}`);
  sections.push(`**Type:** ${classification.subjectType} | **Created:** ${classification.createdAt.split('T')[0]}`);

  if (classification.affectedSystems.length > 0) {
    sections.push(`\n### Affected Systems (${classification.affectedCount})`);
    for (const system of classification.affectedSystems) {
      sections.push(`- ${system}`);
    }
  }

  const statusIcon = classification.governanceStatus === 'CLEAR' ? '✅'
    : classification.governanceStatus === 'VIOLATION' ? '❌'
    : '⚠️';
  sections.push(`\n### Governance Status: ${statusIcon} ${classification.governanceStatus}`);

  if (classification.policyViolations.length > 0) {
    sections.push('**Policy Violations:**');
    for (const violation of classification.policyViolations) {
      sections.push(`- ${violation}`);
    }
  }

  const recIcon = classification.recommendation === 'APPROVE' ? '✅'
    : classification.recommendation === 'APPROVE_WITH_MITIGATIONS' ? '⚠️'
    : classification.recommendation === 'REJECT' ? '❌'
    : '🔄';
  sections.push(`\n### Recommendation: ${recIcon} ${classification.recommendation}`);

  if (classification.rationale) {
    sections.push(`**Rationale:** ${classification.rationale}`);
  }

  if (classification.mitigations.length > 0) {
    sections.push('\n**Required Mitigations:**');
    for (const mitigation of classification.mitigations) {
      sections.push(`- ${mitigation}`);
    }
  }

  return sections.join('\n');
}

/**
 * classify/classifier — pattern scoring and selection
 *
 * Selects the best-matching pattern for a given intention string using
 * vocabulary scoring. Falls back to 'api' when no signal fires.
 */

import type { ClassifyResult, PatternName } from '../types';
import { SCORED_PATTERNS } from './patterns';

export { keywordScore } from './patterns';

/**
 * Choose the best pattern for the given intention string.
 *
 * Returns a full ClassifyResult with the matched PatternName, numeric
 * confidence (0–1), traits array, and a placeholder qualityProfile that
 * callers should override with inferQualityProfile().
 */
export function choosePattern(intention: string): ClassifyResult {
  const text = intention.toLowerCase();

  const scored = SCORED_PATTERNS
    .map((p) => ({ ...p, value: p.score(text) }))
    .sort((a, b) => {
      if (b.value !== a.value) return b.value - a.value;
      return b.priority - a.priority;
    });

  // When nothing matches, use api (rest-api) as the safe fallback rather
  // than letting a high-priority pattern win by priority alone.
  const winner = scored[0]!.value === 0
    ? { ...SCORED_PATTERNS.find((p) => p.traitMap['source_pattern'] === 'rest-api')!, value: 0 }
    : scored[0]!;

  const rawScore = winner.value;
  const confidenceLabel = rawScore >= 3 ? 'high' : rawScore >= 2 ? 'medium' : 'low';
  const confidenceNum = confidenceLabel === 'high' ? 0.9 : confidenceLabel === 'medium' ? 0.6 : 0.3;

  return {
    pattern: winner.name as PatternName,
    confidence: confidenceNum,
    traits: winner.traits,
    qualityProfile: {
      testingLevel: 'standard',
      observability: false,
      authentication: false,
      rateLimiting: false,
      piiHandling: false,
      complianceDomains: [],
    },
    enrichedIntention: intention,
  };
}

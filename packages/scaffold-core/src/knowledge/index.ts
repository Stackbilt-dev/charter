/**
 * knowledge — public API
 *
 * getKnowledge(pattern) → PatternKnowledge
 */

export type { PatternKnowledge, ThreatEntry } from '../types';
export { patternSpecificThreats, domainThreats } from './threats';
export { adrContextByPattern, adrDecisionByPattern } from './decisions';

import type { PatternKnowledge } from '../types';
import { patternSpecificThreats } from './threats';
import { adrContextByPattern, adrDecisionByPattern } from './decisions';

/**
 * Retrieve all knowledge (threats + ADR fragments) for a given pattern.
 */
export function getKnowledge(pattern: string): PatternKnowledge {
  return {
    threats: patternSpecificThreats(pattern),
    adrContext: adrContextByPattern(pattern),
    adrDecision: adrDecisionByPattern(pattern),
    domainThreats: [],
  };
}

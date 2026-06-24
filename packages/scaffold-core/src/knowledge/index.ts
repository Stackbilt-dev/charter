/**
 * knowledge — public API
 *
 * getKnowledge(pattern, complianceDomains?) → PatternKnowledge
 */

export type { PatternKnowledge, ThreatEntry } from '../types';
export { patternSpecificThreats, domainThreats } from './threats';
export { adrContextByPattern, adrDecisionByPattern } from './decisions';
export { rustWasmDecisions, rustWasmThreats } from './rust-wasm';
export type { RustWasmDecision, RustWasmThreat } from './rust-wasm.contract';

import type { PatternKnowledge } from '../types';
import { patternSpecificThreats, domainThreats } from './threats';
import { adrContextByPattern, adrDecisionByPattern } from './decisions';

/**
 * Retrieve all knowledge (threats + ADR fragments) for a given source pattern.
 *
 * @param pattern           Source pattern name (e.g. 'rest-api', 'stripe-webhook')
 * @param complianceDomains Optional compliance domains for domain-specific threats
 */
export function getKnowledge(
  pattern: string,
  complianceDomains?: Array<'PHI' | 'PCI' | 'PII' | 'telephony'>
): PatternKnowledge {
  return {
    threats: patternSpecificThreats(pattern),
    adrContext: adrContextByPattern(pattern),
    adrDecision: adrDecisionByPattern(pattern),
    domainThreats: complianceDomains ? domainThreats(complianceDomains) : [],
  };
}

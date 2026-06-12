/**
 * knowledge/threats — threat knowledge stubs
 *
 * Pattern-specific and domain-level threat catalogs.
 * @stub Implementation pending — see child issue for knowledge module.
 */

import type { ThreatEntry } from '../types';

/**
 * Retrieve pattern-specific threat entries for the given pattern name.
 *
 * @stub Returns empty array until the knowledge module implementation lands.
 */
export function patternSpecificThreats(_pattern: string): ThreatEntry[] {
  return [];
}

/**
 * Retrieve domain-level threat entries for the given compliance domains.
 *
 * @stub Returns empty array until the knowledge module implementation lands.
 */
export function domainThreats(
  _domains: Array<'PHI' | 'PCI' | 'PII' | 'telephony'>
): ThreatEntry[] {
  return [];
}

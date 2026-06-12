/**
 * classify — public API
 *
 * classify(intention) → ClassifyResult
 */

export type { ClassifyResult, QualityProfile, PatternDef } from '../types';
export { PATTERNS } from './patterns';
export { choosePattern } from './classifier';
export { extractEnrichedPrd, STACK_TOKENS, DOMAIN_ENTITY_PATTERNS } from './enricher';
export { inferBindings } from './bindings';
export { inferQualityProfile } from './quality';

import type { ClassifyResult } from '../types';
import { choosePattern } from './classifier';

/**
 * Classify an intention string and return a fully-populated ClassifyResult.
 *
 * @stub Delegates to choosePattern — throws until the classify module lands.
 */
export function classify(intention: string): ClassifyResult {
  return choosePattern(intention);
}

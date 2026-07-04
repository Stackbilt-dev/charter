/**
 * classify — public API
 *
 * classify(intention) → ClassifyResult
 *
 * Thin wrapper that calls choosePattern, then patches the result with
 * inferQualityProfile and extractEnrichedPrd so callers get a fully-
 * populated ClassifyResult in one call.
 */

export type { ClassifyResult, QualityProfile, PatternDef } from '../types';
export { PATTERNS } from './patterns';
export { choosePattern, keywordScore } from './classifier';
export { extractEnrichedPrd, injectPrdSections, STACK_TOKENS, DOMAIN_ENTITY_PATTERNS } from './enricher';
export { inferBindings } from './bindings';
export { inferQualityProfile } from './quality';

import type { ClassifyResult } from '../types';
import { choosePattern } from './classifier';
import { extractEnrichedPrd, injectPrdSections } from './enricher';
import { inferQualityProfile } from './quality';

/**
 * Classify an intention string and return a fully-populated ClassifyResult.
 *
 * Steps:
 * 1. choosePattern — vocabulary scoring → PatternName + traits + traitMap
 * 2. extractEnrichedPrd — stack/entity detection
 * 3. injectPrdSections — append Stack/Entities sections to intention
 * 4. inferQualityProfile — compliance + feature flags
 */
export function classify(intention: string): ClassifyResult {
  const base = choosePattern(intention);

  // source_pattern is the fine-grained key (e.g. 'stripe-webhook') codegen/knowledge
  // lookups need — distinct from the coarse `pattern` (PatternName) bucket.
  const sourcePattern = base.traitMap['source_pattern'] ?? base.pattern;

  const { stack, entities } = extractEnrichedPrd(intention);
  const enriched = injectPrdSections(intention, stack, entities);
  const qualityProfile = inferQualityProfile(enriched, sourcePattern, base.traits);

  return {
    ...base,
    qualityProfile,
    enrichedIntention: enriched,
  };
}

/**
 * classify/enricher — extractEnrichedPrd stub
 *
 * Expands a raw intention string into an enriched PRD fragment by detecting
 * stack tokens and domain entity patterns.
 * @stub Implementation pending — see child issue for classify module.
 */

/**
 * Known stack token keywords used to detect technology context.
 * @stub Empty until implementation lands.
 */
export const STACK_TOKENS: string[] = [];

/**
 * Domain entity pattern matchers used to detect compliance / PII signals.
 * @stub Empty until implementation lands.
 */
export const DOMAIN_ENTITY_PATTERNS: RegExp[] = [];

/**
 * Expand a raw intention string into an enriched PRD fragment.
 *
 * @stub Throws until the classify module implementation lands.
 */
export function extractEnrichedPrd(_intention: string): string {
  throw new Error(
    'Not implemented: use @stackbilt/scaffold-core@x.y when classify/ module lands'
  );
}

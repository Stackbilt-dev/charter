/**
 * classify/quality — QualityProfile type + inferQualityProfile stub
 *
 * Derives a QualityProfile from the enriched intention and detected traits.
 * @stub Implementation pending — see child issue for classify module.
 */

import type { QualityProfile } from '../types';

export type { QualityProfile };

/**
 * Infer a QualityProfile from the enriched intention string and traits.
 *
 * @stub Throws until the classify module implementation lands.
 */
export function inferQualityProfile(
  _enrichedIntention: string,
  _traits: string[]
): QualityProfile {
  throw new Error(
    'Not implemented: use @stackbilt/scaffold-core@x.y when classify/ module lands'
  );
}

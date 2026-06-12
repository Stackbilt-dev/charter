/**
 * codegen/routes — route generation stubs
 *
 * Generates route definitions and per-route file content.
 * @stub Implementation pending — see child issue for codegen module.
 */

import type { ScaffoldFacts, ScaffoldFile } from '../types';

/**
 * Build the list of route ScaffoldFiles for the given facts.
 *
 * @stub Throws until the codegen module implementation lands.
 */
export function buildRoutes(_facts: ScaffoldFacts): ScaffoldFile[] {
  throw new Error(
    'Not implemented: use @stackbilt/scaffold-core@x.y when codegen/ module lands'
  );
}

/**
 * Generate the source content for a single route handler.
 *
 * @stub Throws until the codegen module implementation lands.
 */
export function routeContent(_facts: ScaffoldFacts, _routePath: string): string {
  throw new Error(
    'Not implemented: use @stackbilt/scaffold-core@x.y when codegen/ module lands'
  );
}

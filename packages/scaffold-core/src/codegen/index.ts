/**
 * codegen — public API
 *
 * generateFiles(facts) → ScaffoldFile[]
 */

export type { ScaffoldFile, FileRole } from '../types';
export { buildRoutes, routeContent } from './routes';
export { baseFiles } from './files';
export { generateWranglerBindings } from './wrangler';

import type { ScaffoldFile, ScaffoldFacts } from '../types';
import { baseFiles } from './files';
import { buildRoutes } from './routes';

/**
 * Generate the full set of ScaffoldFiles for the given facts.
 *
 * @stub Delegates to baseFiles + buildRoutes — throws until codegen module lands.
 */
export function generateFiles(facts: ScaffoldFacts): ScaffoldFile[] {
  return [...baseFiles(facts), ...buildRoutes(facts)];
}

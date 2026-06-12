/**
 * codegen — public API
 *
 * generateFiles(facts) → ScaffoldFile[]
 */

export type { ScaffoldFile, FileRole } from '../types';
export { buildRoutes, routeContent } from './routes';
export { baseFiles, addGovernanceFiles } from './files';
export { generateWranglerBindings } from './wrangler';

import type { ScaffoldFile, ScaffoldFacts } from '../types';
import { baseFiles, addGovernanceFiles } from './files';
import { buildRoutes } from './routes';

/**
 * Generate the full set of ScaffoldFiles for the given facts.
 *
 * Produces base infrastructure files (wrangler.toml, package.json, etc.)
 * plus route handler files for each route in the pattern's default_routes trait.
 *
 * Note: governance docs (.ai/*.md) are added by the orchestrator after calling
 * buildGovernance(). Use addGovernanceFiles() to graft them in.
 */
export function generateFiles(facts: ScaffoldFacts): ScaffoldFile[] {
  return [...baseFiles(facts), ...buildRoutes(facts)];
}

/**
 * materializer — public API
 *
 * materializeScaffold(facts, rawFacts?) → MaterializerResult
 *
 * Combines ADF file generators (manifest.adf, core.adf, state.adf) with
 * project file generators (package.json, wrangler.toml, src/index.ts, etc.)
 * into a single deterministic result.
 *
 * Extracted from stackbilt-web/src/lib/scaffold-materializer.ts.
 * Pure — no CF Worker imports, no network calls.
 */

export type { MaterializerResult, ScaffoldFacts } from '../types';
export { generateAdfFiles } from './adf';
export { generateProjectFiles } from './project';

import type { MaterializerResult, ScaffoldFacts } from '../types';
import { generateAdfFiles, type Facts } from './adf';
import { generateProjectFiles } from './project';

/**
 * Materialize all scaffold output files (ADF + project) for the given facts.
 *
 * ADF files (.ai/*.adf) are placed first — governance before source.
 *
 * @param facts    - Structured scaffold facts from the classify pipeline
 * @param rawFacts - Optional raw key-value facts from scaffold-cast. When
 *                   provided, template renderers will draw card-level detail
 *                   (requirement_name, threat_mitigation, etc.) from this map.
 *                   If omitted, templates fall back to empty strings.
 */
export function materializeScaffold(
  facts: ScaffoldFacts,
  rawFacts: Facts = {},
): MaterializerResult {
  const adfFiles = generateAdfFiles(facts, rawFacts);
  const projectFiles = generateProjectFiles(facts, rawFacts);

  return {
    files: [...adfFiles, ...projectFiles],
    facts,
  };
}

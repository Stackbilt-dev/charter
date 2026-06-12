/**
 * materializer — public API
 *
 * materializeScaffold(facts) → MaterializerResult
 */

export type { MaterializerResult, ScaffoldFacts } from '../types';
export { generateAdfFiles } from './adf';
export { generateProjectFiles } from './project';

import type { MaterializerResult, ScaffoldFacts } from '../types';
import { generateAdfFiles } from './adf';
import { generateProjectFiles } from './project';

/**
 * Materialize all scaffold output files (ADF + project) for the given facts.
 *
 * @stub Delegates to generateAdfFiles + generateProjectFiles — throws until materializer module lands.
 */
export function materializeScaffold(facts: ScaffoldFacts): MaterializerResult {
  return {
    files: [...generateProjectFiles(facts), ...generateAdfFiles(facts)],
    facts,
  };
}

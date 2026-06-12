/**
 * @stackbilt/scaffold-core
 *
 * Zero-dependency, zero-inference, zero-network scaffold engine core.
 *
 * This package houses the extracted scaffold engine from stackbilt-web.
 * For v0.1.0 (experimental), all sub-module implementations are stubs —
 * implementations land in child issues per module.
 *
 * Entrypoint: buildScaffold(intention, options?) → LocalScaffoldResult
 */

// ============================================================================
// Types (re-export everything consumers might need)
// ============================================================================

export type {
  // Pattern types
  PatternName,
  PatternStatus,
  PatternCategory,
  PatternDef,
  // Classification types
  ClassifyResult,
  QualityProfile,
  // Binding types
  ScaffoldBinding,
  // Knowledge types
  ThreatEntry,
  PatternKnowledge,
  // Governance types
  GovernanceDocs,
  // Codegen types
  FileRole,
  ScaffoldFile,
  // Materializer types
  ScaffoldFacts,
  MaterializerResult,
  // Top-level types
  LocalScaffoldResult,
  ScaffoldOptions,
} from './types';

// ============================================================================
// Sub-module public APIs
// ============================================================================

export { classify } from './classify/index';
export { getKnowledge } from './knowledge/index';
export { buildGovernance } from './governance/index';
export { generateFiles } from './codegen/index';
export { materializeScaffold } from './materializer/index';

// ============================================================================
// Orchestrator
// ============================================================================

import type { LocalScaffoldResult, ScaffoldOptions } from './types';
import { classify } from './classify/index';
import { getKnowledge } from './knowledge/index';
import { buildGovernance } from './governance/index';
import { generateFiles } from './codegen/index';
import { materializeScaffold } from './materializer/index';
import { inferBindings } from './classify/bindings';

/**
 * Build a complete scaffold result from a plain-English intention string.
 *
 * Orchestrates: classify → knowledge → facts → governance → codegen → materialize.
 *
 * @stub Each sub-module throws until its implementation lands. This function
 * will propagate the first sub-module error encountered.
 *
 * @param intention - Plain-English description of what to build
 * @param options   - Optional overrides (projectName, oracle mode)
 * @returns         - LocalScaffoldResult with all scaffold artifacts
 */
export function buildScaffold(
  intention: string,
  options: ScaffoldOptions = {}
): LocalScaffoldResult {
  const classification = classify(intention);
  const knowledge = getKnowledge(classification.pattern);
  const bindings = inferBindings(classification.pattern, classification.traits);

  const facts = {
    pattern: classification.pattern,
    projectName: options.projectName ?? 'my-worker',
    intention,
    bindings,
    traits: classification.traits,
    qualityProfile: classification.qualityProfile,
  };

  const governance = buildGovernance(facts, knowledge);
  const codegenFiles = generateFiles(facts);
  const { files: materializedFiles } = materializeScaffold(facts);

  return {
    classification,
    knowledge,
    governance,
    files: [...codegenFiles, ...materializedFiles],
    facts,
  };
}

/**
 * @stackbilt/scaffold-core
 *
 * Zero-dependency, zero-inference, zero-network scaffold engine core.
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
export { generateFiles, addGovernanceFiles } from './codegen/index';
export { materializeScaffold } from './materializer/index';

// ============================================================================
// Orchestrator
// ============================================================================

import type { LocalScaffoldResult, ScaffoldOptions } from './types';
import { classify } from './classify/index';
import { getKnowledge } from './knowledge/index';
import { buildGovernance } from './governance/index';
import { generateFiles, addGovernanceFiles } from './codegen/index';
import { materializeScaffold } from './materializer/index';
import { inferBindings } from './classify/bindings';

/**
 * Build a complete scaffold result from a plain-English intention string.
 *
 * Orchestration order:
 *   1. classify(intention)        → ClassifyResult
 *   2. getKnowledge(pattern, ...) → PatternKnowledge
 *   3. buildGovernance(facts, ...) → GovernanceDocs
 *   4. generateFiles(facts)       → ScaffoldFile[] (base + routes)
 *   5. addGovernanceFiles(...)    → grafts .ai/*.md onto the file list
 *   6. materializeScaffold(facts) → ADF + project files (grafted in)
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
  const knowledge = getKnowledge(
    classification.pattern,
    classification.qualityProfile.complianceDomains
  );
  const bindings = inferBindings(classification.pattern, classification.traits);

  const facts = {
    pattern: classification.pattern,
    projectName: options.projectName ?? 'my-worker',
    intention: classification.enrichedIntention,
    bindings,
    traits: classification.traits,
    qualityProfile: classification.qualityProfile,
  };

  const governance = buildGovernance(facts, knowledge);

  // Generate base + route files, then graft governance docs on top
  const codegenFiles = generateFiles(facts);
  const filesWithGovernance = addGovernanceFiles(codegenFiles, governance);

  // Materialize ADF + project files; graft only ADF/contract files not already present
  let finalFiles = filesWithGovernance;
  try {
    const { files: materializedFiles } = materializeScaffold(facts);
    const existingPaths = new Set(finalFiles.map((f) => f.path));
    for (const mf of materializedFiles) {
      const isAdf = mf.path.startsWith('.ai/') && mf.path.endsWith('.adf');
      const isContract = mf.path.startsWith('src/contracts/');
      const isSchema = mf.path === 'schema.sql';
      if ((isAdf || isContract || isSchema) && !existingPaths.has(mf.path)) {
        finalFiles = [...finalFiles, mf];
      }
    }
  } catch {
    // Materializer failure is non-fatal — codegen output is still complete
  }

  return {
    classification,
    knowledge,
    governance,
    files: finalFiles,
    facts,
    traits: classification.traits,
    tier2Recommended: classification.confidence < 0.6,
  };
}

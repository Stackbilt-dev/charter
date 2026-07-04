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
  OracleContext,
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

import type { LocalScaffoldResult, OracleContext, ScaffoldOptions } from './types';
import { classify } from './classify/index';
import { getKnowledge } from './knowledge/index';
import { buildGovernance } from './governance/index';
import { generateFiles, addGovernanceFiles } from './codegen/index';
import { materializeScaffold } from './materializer/index';
import { inferBindings } from './classify/bindings';

const MAX_SLUG_LENGTH = 40;
const FALLBACK_SLUG = 'scaffold-app';

/**
 * Derive a kebab-case project slug from a free-form intention string.
 * Used as the default projectName when the caller does not supply one —
 * keeps wrangler.toml, package.json, contract filenames, and .ai/*.adf
 * headers consistent instead of falling back to a generic placeholder.
 */
export function deriveProjectSlug(intention: string): string {
  const slug = intention
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug || FALLBACK_SLUG;
}

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
  // source_pattern is the fine-grained key (e.g. 'stripe-webhook', 'cron-worker') that
  // knowledge/codegen lookups are keyed by — the coarse `classification.pattern` bucket
  // (e.g. 'worker') collapses multiple source patterns together and must not be used here.
  const sourcePattern = classification.traitMap['source_pattern'] ?? classification.pattern;
  const knowledge = getKnowledge(
    sourcePattern,
    classification.qualityProfile.complianceDomains
  );
  // NOTE: inferBindings's first param is documented as the intention text, but this
  // call passes the coarse pattern name instead — the "no signal detected" fallback
  // (D1+KV) masks it today because route codegen for D1-backed patterns hard-codes
  // `c.env.DB` regardless of what inferBindings actually returns. Passing the real
  // intention text here changes which bindings get inferred without changing what
  // routes assume exists, producing scaffolds whose routes reference undeclared env
  // bindings (e.g. `api`/file-upload intentions get R2-only bindings but resources.ts
  // still calls `c.env.DB`). Left as-is; fixing it requires reconciling binding
  // inference with each pattern's route-level DB/KV/R2 assumptions — out of scope here.
  const bindings = inferBindings(classification.pattern, classification.traits);

  const facts = {
    pattern: classification.pattern,
    sourcePattern,
    traitMap: classification.traitMap,
    projectName: options.projectName ?? deriveProjectSlug(intention),
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

    // Contract stubs import `zod` and `@stackbilt/contracts` directly, but the base
    // package.json from codegen/files.ts (generated before the contract file exists)
    // only declares `hono` — so a downloaded scaffold survives `npm install` and then
    // fails typecheck/build with missing modules. Backfill both dependencies whenever
    // a contract file is grafted in.
    if (finalFiles.some((f) => f.path.startsWith('src/contracts/'))) {
      finalFiles = finalFiles.map((f) => {
        if (f.path !== 'package.json') return f;
        try {
          const pkg = JSON.parse(f.content) as { dependencies?: Record<string, string> };
          pkg.dependencies = {
            ...pkg.dependencies,
            zod: '^4.3.6',
            '@stackbilt/contracts': '^0.8.0',
          };
          return { ...f, content: JSON.stringify(pkg, null, 2) };
        } catch {
          return f;
        }
      });
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

/**
 * Derive oracle context from a LocalScaffoldResult for use by an LLM polish pass.
 *
 * All fields are derived from the existing result — no additional inference or
 * network calls required. Consumers pass this to the oracle instead of the
 * old promptContext field that was stripped when migrating from the local shim.
 *
 * @see stackbilt-web oracle.ts
 * @see charter#224
 */
export function buildOracleContext(result: LocalScaffoldResult): OracleContext {
  const { classification, knowledge, governance, facts, files, tier2Recommended } = result;
  return {
    intention: facts.intention,
    pattern: classification.pattern,
    meta: {
      confidence: classification.confidence,
      tier2Recommended,
      testingLevel: classification.qualityProfile.testingLevel,
      complianceDomains: classification.qualityProfile.complianceDomains,
      observability: classification.qualityProfile.observability,
      authentication: classification.qualityProfile.authentication,
      rateLimiting: classification.qualityProfile.rateLimiting,
    },
    traits: classification.traits,
    runtime: {
      bindings: facts.bindings.map(b => ({ type: b.type, name: b.name, binding: b.binding })),
      piiHandling: classification.qualityProfile.piiHandling,
    },
    governance: {
      threatModel: governance.threatModel,
      adr001: governance.adr001,
      adr002: governance.adr002 ?? null,
      testPlan: governance.testPlan,
    },
    knowledge: {
      adrContext: knowledge.adrContext,
      adrDecision: knowledge.adrDecision,
      topThreats: knowledge.threats.slice(0, 5).map(t => ({
        id: t.id,
        description: t.description,
        mitigation: t.mitigation,
        severity: t.severity,
      })),
    },
    files: files.map(f => ({ path: f.path, content: f.content, role: f.role })),
  };
}

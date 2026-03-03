/**
 * ADF Evidence — unified evaluation combining constraint validation,
 * token analysis, and baseline staleness.
 *
 * Produces a single EvidenceReport from a BundleResult and optional
 * external metric context, replacing the need for consumers to manually
 * assemble evidence from multiple sources.
 */

import type {
  AdfDocument,
  BundleResult,
  EvidenceResult,
} from './types';
import { validateConstraints } from './validator';

// ============================================================================
// Types
// ============================================================================

export interface StaleBaselineWarning {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  ratio: number;
  recommendedCeiling: number;
  rationaleRequired: boolean;
}

export interface EvidenceReport extends EvidenceResult {
  tokenEstimate: number;
  tokenBudget: number | null;
  tokenUtilization: number | null;
  perModuleTokens: Record<string, number>;
  moduleBudgetOverruns: BundleResult['moduleBudgetOverruns'];
  advisoryOnlyModules: string[];
  staleBaselines: StaleBaselineWarning[];
}

// ============================================================================
// Evaluation
// ============================================================================

/**
 * Evaluate evidence from a bundle result and optional metric context.
 *
 * Combines constraint validation, token budget analysis, module budget
 * overruns, advisory-only module warnings, and stale baseline detection
 * into a single unified report.
 *
 * @param bundle - Result from bundleModules()
 * @param context - Optional external metric overrides (e.g., actual LOC counts)
 * @param staleThreshold - Ratio threshold for stale baseline detection (default 1.2)
 */
export function evaluateEvidence(
  bundle: BundleResult,
  context?: Record<string, number>,
  staleThreshold?: number,
): EvidenceReport {
  const evidence = validateConstraints(bundle.mergedDocument, context);
  const staleBaselines = detectStaleBaselines(
    bundle.mergedDocument,
    context,
    staleThreshold ?? 1.2,
  );

  return {
    ...evidence,
    tokenEstimate: bundle.tokenEstimate,
    tokenBudget: bundle.tokenBudget,
    tokenUtilization: bundle.tokenUtilization,
    perModuleTokens: bundle.perModuleTokens,
    moduleBudgetOverruns: bundle.moduleBudgetOverruns,
    advisoryOnlyModules: bundle.advisoryOnlyModules,
    staleBaselines,
  };
}

// ============================================================================
// Stale Baseline Detection
// ============================================================================

/**
 * Detect metrics whose current values have drifted significantly from
 * their ADF baselines, indicating the ceilings may need recalibration.
 */
function detectStaleBaselines(
  doc: AdfDocument,
  context: Record<string, number> | undefined,
  staleThreshold: number,
): StaleBaselineWarning[] {
  if (!context) return [];
  const warnings: StaleBaselineWarning[] = [];
  for (const section of doc.sections) {
    if (section.key !== 'METRICS' || section.content.type !== 'metric') continue;
    for (const entry of section.content.entries) {
      if (entry.value <= 0) continue;
      const key = entry.key.toLowerCase();
      const current = context[key];
      if (!Number.isFinite(current)) continue;
      const ratio = current / entry.value;
      if (ratio < staleThreshold) continue;
      warnings.push({
        metric: key,
        baseline: entry.value,
        current,
        delta: current - entry.value,
        ratio: Number(ratio.toFixed(2)),
        recommendedCeiling: Math.ceil(current * 1.15),
        rationaleRequired: true,
      });
    }
  }
  return warnings;
}

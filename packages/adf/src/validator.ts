/**
 * ADF constraint validator.
 *
 * Checks metric entries against their ceilings and produces
 * a structured evidence report.
 */

import type {
  AdfDocument,
  ConstraintResult,
  ConstraintStatus,
  WeightSummary,
  EvidenceResult,
} from './types';

/**
 * Validate all metric constraints in an ADF document.
 *
 * For each metric entry, compares value against ceiling:
 * - value < ceiling → pass
 * - value === ceiling → warn (at boundary)
 * - value > ceiling → fail
 *
 * @param doc - Parsed ADF document
 * @param context - Optional external metric overrides (e.g., actual LOC counts)
 */
export function validateConstraints(
  doc: AdfDocument,
  context?: Record<string, number>,
): EvidenceResult {
  const constraints: ConstraintResult[] = [];

  for (const section of doc.sections) {
    if (section.content.type !== 'metric') continue;

    for (const entry of section.content.entries) {
      const hasContext = context !== undefined && entry.key in context;
      const value = hasContext ? context[entry.key] : entry.value;
      const status = resolveStatus(value, entry.ceiling);
      const statusLabel = status.toUpperCase();

      constraints.push({
        section: section.key,
        metric: entry.key,
        value,
        ceiling: entry.ceiling,
        unit: entry.unit,
        status,
        message: `${entry.key}: ${value} / ${entry.ceiling} [${entry.unit}] -- ${statusLabel}`,
        source: hasContext ? 'context' : 'metric',
      });
    }
  }

  const failCount = constraints.filter(c => c.status === 'fail').length;
  const warnCount = constraints.filter(c => c.status === 'warn').length;

  return {
    constraints,
    weightSummary: computeWeightSummary(doc),
    allPassing: failCount === 0,
    failCount,
    warnCount,
  };
}

/**
 * Count sections by weight category.
 */
export function computeWeightSummary(doc: AdfDocument): WeightSummary {
  let loadBearing = 0;
  let advisory = 0;
  let unweighted = 0;

  for (const section of doc.sections) {
    if (section.weight === 'load-bearing') {
      loadBearing++;
    } else if (section.weight === 'advisory') {
      advisory++;
    } else {
      unweighted++;
    }
  }

  return {
    loadBearing,
    advisory,
    unweighted,
    total: doc.sections.length,
  };
}

function resolveStatus(value: number, ceiling: number): ConstraintStatus {
  if (value > ceiling) return 'fail';
  if (value === ceiling) return 'warn';
  return 'pass';
}

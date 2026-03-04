/**
 * Evaluator — grades actual tidy routing against expected routing.
 *
 * Scoring is lenient by design in early runs: we track direction (over/under)
 * not exact counts, so the data reveals systematic gaps vs. one-off misses.
 */

import type {
  Session,
  TidyOutput,
  SessionResult,
  ModuleEval,
  RouteVerdict,
} from './types';

/**
 * Grade a single session's tidy output against its expected routing.
 */
export function evaluateSession(
  session: Session,
  tidyOutput: TidyOutput,
): SessionResult {
  const actual = flattenRouting(tidyOutput);
  const expected = session.expected;

  const allModules = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const moduleEvals: ModuleEval[] = [];

  for (const module of allModules) {
    const exp = expected[module] ?? 0;
    const act = actual[module] ?? 0;
    moduleEvals.push({
      module,
      expected: exp,
      actual: act,
      verdict: grade(exp, act),
    });
  }

  const unexpectedModules = Object.keys(actual).filter(m => !(m in expected) && actual[m] > 0);

  const totalExpected = Object.values(expected).reduce((s, n) => s + n, 0);
  const totalActual = tidyOutput.totalExtracted;

  // Pass = no missing modules and no module is more than 50% off expected count
  const pass = moduleEvals.every(e => e.verdict === 'correct' || e.verdict === 'over') &&
    unexpectedModules.length === 0;

  return {
    sessionLabel: session.label,
    totalExpected,
    totalActual,
    moduleEvals,
    unexpectedModules,
    pass,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Flatten all file-level routing into a module → total count map.
 */
function flattenRouting(tidyOutput: TidyOutput): Record<string, number> {
  const result: Record<string, number> = {};
  for (const file of tidyOutput.files) {
    for (const [module, count] of Object.entries(file.routing)) {
      result[module] = (result[module] ?? 0) + count;
    }
  }
  return result;
}

function grade(expected: number, actual: number): RouteVerdict {
  if (expected === 0 && actual === 0) return 'correct';
  if (expected > 0 && actual === 0) return 'missing';
  if (expected === 0 && actual > 0) return 'over';
  // Within 1 item tolerance
  if (Math.abs(actual - expected) <= 1) return 'correct';
  if (actual > expected) return 'over';
  return 'under';
}

// ============================================================================
// Summary Printing
// ============================================================================

export function printSessionResult(result: SessionResult): void {
  const icon = result.pass ? '✓' : '✗';
  console.log(`    ${icon} ${result.sessionLabel}`);
  console.log(`      extracted: ${result.totalActual} / expected ~${result.totalExpected}`);

  for (const e of result.moduleEvals) {
    const flag = e.verdict === 'correct' ? '' :
      e.verdict === 'missing' ? ' ← MISS' :
      e.verdict === 'under' ? ' ← UNDER' : ' ← OVER';
    console.log(`      ${e.module}: got ${e.actual}, expected ${e.expected}${flag}`);
  }

  if (result.unexpectedModules.length > 0) {
    console.log(`      unexpected modules: ${result.unexpectedModules.join(', ')}`);
  }
}

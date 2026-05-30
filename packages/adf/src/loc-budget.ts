/**
 * Per-path source LOC budget evaluation.
 *
 * Extends the single-ceiling `entry_loc` constraint model (see validator.ts)
 * with per-path budgets carrying independent warn/fail ceilings, so teams can
 * catch god-object drift across arbitrary runtime source files — not just the
 * one entry file. Pure core: callers supply already-measured line counts; this
 * module does matching + status resolution only (no filesystem access).
 */

import type { ConstraintStatus, LocBudgetRule, LocBudgetResult } from './types';

/**
 * Resolve a budget status for a measured line count against warn/fail ceilings.
 *
 * Mirrors validator.ts `resolveStatus` semantics (a value strictly *exceeding*
 * a ceiling breaches it), generalized to two ceilings:
 * - lines > fail  → fail
 * - lines > warn  → warn
 * - otherwise     → pass
 *
 * A null ceiling is treated as "unset" (never breached at that level).
 */
export function resolveBudgetStatus(
  lines: number,
  warn: number | null,
  fail: number | null,
): ConstraintStatus {
  if (fail !== null && lines > fail) return 'fail';
  if (warn !== null && lines > warn) return 'warn';
  return 'pass';
}

/**
 * Match a repo-relative file path against a glob pattern.
 *
 * Minimal, dependency-free glob: `**` matches across path segments (including
 * none), `*` matches within a single segment, everything else is literal.
 * Backslashes are normalized to `/` so Windows paths match POSIX patterns.
 */
export function matchPath(filePath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(filePath.replace(/\\/g, '/'));
}

function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**` — match across segments. Consume a trailing slash so that
        // `src/**/x` matches `src/x` (zero intervening segments) as well as
        // `src/a/x`. Bare `**` (no following slash) matches anything.
        if (p[i + 2] === '/') {
          re += '(?:[^/]*/)*';
          i += 2; // skip second '*' and the '/'
        } else {
          re += '.*';
          i += 1; // skip second '*'
        }
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * Evaluate measured files against an ordered list of LOC budget rules.
 *
 * Each file is matched against the rules in order; the FIRST matching rule
 * applies (so list more specific patterns first). Files matching no rule are
 * omitted from the results. Per-rule ceilings fall back to the supplied
 * defaults when unset.
 *
 * @param files   Measured files (repo-relative path + line count).
 * @param rules   Ordered budget rules.
 * @param defaults Optional default warn/fail ceilings applied when a rule omits one.
 */
export function evaluateLocBudgets(
  files: Array<{ path: string; lines: number }>,
  rules: LocBudgetRule[],
  defaults?: { warn?: number; fail?: number },
): LocBudgetResult[] {
  const results: LocBudgetResult[] = [];
  for (const file of files) {
    const rule = rules.find(r => matchPath(file.path, r.pattern));
    if (!rule) continue;

    const warn = rule.warn ?? defaults?.warn ?? null;
    const fail = rule.fail ?? defaults?.fail ?? null;
    const status = resolveBudgetStatus(file.lines, warn, fail);
    const ceilingLabel = `warn ${warn ?? '—'}, fail ${fail ?? '—'}`;

    results.push({
      path: file.path,
      pattern: rule.pattern,
      lines: file.lines,
      warn,
      fail,
      status,
      reason: rule.reason,
      message: `${file.path}: ${file.lines} lines (${ceilingLabel}) -- ${status.toUpperCase()}`,
    });
  }
  return results;
}

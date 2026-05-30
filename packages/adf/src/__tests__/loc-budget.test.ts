import { describe, it, expect } from 'vitest';
import { evaluateLocBudgets, resolveBudgetStatus, matchPath } from '../loc-budget';
import type { LocBudgetRule } from '../types';

describe('resolveBudgetStatus', () => {
  it('fails when lines strictly exceed the fail ceiling', () => {
    expect(resolveBudgetStatus(501, 300, 500)).toBe('fail');
  });

  it('does not fail at the fail ceiling (boundary is not exceeded)', () => {
    expect(resolveBudgetStatus(500, 300, 500)).toBe('warn');
  });

  it('warns when lines exceed warn but not fail', () => {
    expect(resolveBudgetStatus(400, 300, 500)).toBe('warn');
  });

  it('passes when below all ceilings', () => {
    expect(resolveBudgetStatus(100, 300, 500)).toBe('pass');
  });

  it('treats null ceilings as unset', () => {
    expect(resolveBudgetStatus(10_000, null, null)).toBe('pass');
    expect(resolveBudgetStatus(10_000, null, 500)).toBe('fail');
    expect(resolveBudgetStatus(400, 300, null)).toBe('warn');
  });
});

describe('matchPath', () => {
  it('matches an exact path', () => {
    expect(matchPath('src/index.ts', 'src/index.ts')).toBe(true);
    expect(matchPath('src/other.ts', 'src/index.ts')).toBe(false);
  });

  it('* matches within a single segment only', () => {
    expect(matchPath('src/index.ts', 'src/*.ts')).toBe(true);
    expect(matchPath('src/a/index.ts', 'src/*.ts')).toBe(false);
  });

  it('** matches across segments, including zero', () => {
    expect(matchPath('src/index.ts', 'src/**/*.ts')).toBe(true);
    expect(matchPath('src/a/b/index.ts', 'src/**/*.ts')).toBe(true);
    expect(matchPath('lib/index.ts', 'src/**/*.ts')).toBe(false);
  });

  it('bare ** matches anything under a prefix', () => {
    expect(matchPath('packages/cli/src/x.ts', 'packages/**')).toBe(true);
  });

  it('normalizes Windows backslashes', () => {
    expect(matchPath('src\\commands\\run.ts', 'src/**/*.ts')).toBe(true);
  });

  it('escapes regex-special characters in the literal portion', () => {
    expect(matchPath('src/a.ts', 'src/a.ts')).toBe(true);
    expect(matchPath('src/axts', 'src/a.ts')).toBe(false); // '.' is literal, not "any char"
  });
});

describe('evaluateLocBudgets', () => {
  const rules: LocBudgetRule[] = [
    { pattern: 'src/index.ts', warn: 300, fail: 500, reason: 'entry should stay thin' },
    { pattern: 'src/**/*.ts', warn: 200, fail: 400 },
  ];

  it('applies the first matching rule (most specific listed first)', () => {
    const results = evaluateLocBudgets([{ path: 'src/index.ts', lines: 450 }], rules);
    expect(results).toHaveLength(1);
    expect(results[0].pattern).toBe('src/index.ts');
    expect(results[0].status).toBe('warn'); // 450 > 300 warn, <= 500 fail
    expect(results[0].reason).toBe('entry should stay thin');
  });

  it('flags a god-object that exceeds the fail ceiling', () => {
    const results = evaluateLocBudgets([{ path: 'src/index.ts', lines: 1600 }], rules);
    expect(results[0].status).toBe('fail');
    expect(results[0].message).toContain('1600 lines');
    expect(results[0].message).toContain('FAIL');
  });

  it('omits files that match no rule', () => {
    const results = evaluateLocBudgets([{ path: 'README.md', lines: 9000 }], rules);
    expect(results).toHaveLength(0);
  });

  it('falls back to defaults when a rule omits ceilings', () => {
    const results = evaluateLocBudgets(
      [{ path: 'src/util.ts', lines: 350 }],
      [{ pattern: 'src/util.ts' }],
      { warn: 100, fail: 300 },
    );
    expect(results[0].warn).toBe(100);
    expect(results[0].fail).toBe(300);
    expect(results[0].status).toBe('fail'); // 350 > 300 default fail
  });

  it('evaluates each matched file independently', () => {
    const results = evaluateLocBudgets(
      [
        { path: 'src/index.ts', lines: 100 },
        { path: 'src/big/service.ts', lines: 999 },
      ],
      rules,
    );
    expect(results.map(r => r.status)).toEqual(['pass', 'fail']);
  });
});

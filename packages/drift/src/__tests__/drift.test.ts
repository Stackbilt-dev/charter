import { describe, it, expect } from 'vitest';
import { scanForDrift, extractRules } from '../index';
import type { Pattern } from '@charter/types';

describe('extractRules', () => {
  it('parses regex literals', () => {
    const rules = extractRules('Avoid /console\\.log/g in production');
    expect(rules).toHaveLength(1);
    expect(rules[0].test('console.log("test")')).toBe(true);
  });

  it('parses regex with flags', () => {
    const rules = extractRules('Do not use /var\\s+/gi');
    expect(rules).toHaveLength(1);
    expect(rules[0].flags).toContain('g');
    expect(rules[0].flags).toContain('i');
  });

  it('parses backtick keywords', () => {
    const rules = extractRules('Do not use `eval` or `Function`');
    expect(rules).toHaveLength(2);
    expect(rules[0].test('eval("code")')).toBe(true);
    expect(rules[1].test('new Function("x")')).toBe(true);
  });

  it('escapes special regex characters in keywords', () => {
    const rules = extractRules('Avoid `foo.bar()`');
    expect(rules).toHaveLength(1);
    expect(rules[0].test('foo.bar()')).toBe(true);
    expect(rules[0].test('fooXbar()')).toBe(false);
  });

  it('returns empty array for text with no patterns', () => {
    const rules = extractRules('This is plain text advice');
    expect(rules).toEqual([]);
  });

  it('handles both regex and backtick patterns', () => {
    const rules = extractRules('Avoid /TODO/i and `FIXME`');
    expect(rules).toHaveLength(2);
  });
});

describe('scanForDrift', () => {
  const makePattern = (name: string, antiPatterns: string | null): Pattern => ({
    id: '1',
    name,
    category: 'SECURITY',
    blessedSolution: 'Use approved method',
    rationale: null,
    antiPatterns,
    documentationUrl: null,
    relatedLedgerId: null,
    status: 'ACTIVE',
    createdAt: '2025-01-01',
    projectId: null,
  });

  it('detects violations matching anti-patterns', () => {
    const pattern = makePattern('no-eval', 'Do not use `eval`');
    const files = { 'app.js': 'const result = eval("1+1");' };
    const report = scanForDrift(files, [pattern]);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].file).toBe('app.js');
    expect(report.violations[0].patternName).toBe('no-eval');
  });

  it('reports correct line numbers', () => {
    const pattern = makePattern('no-eval', 'Avoid `eval`');
    const files = { 'app.js': 'line1\nline2\neval("bad")\nline4' };
    const report = scanForDrift(files, [pattern]);
    expect(report.violations[0].line).toBe(3);
  });

  it('returns clean report when no violations found', () => {
    const pattern = makePattern('no-eval', 'Avoid `eval`');
    const files = { 'app.js': 'const x = 1 + 1;' };
    const report = scanForDrift(files, [pattern]);
    expect(report.violations).toEqual([]);
    expect(report.score).toBe(1.0);
  });

  it('skips files larger than 500K', () => {
    const pattern = makePattern('no-eval', 'Avoid `eval`');
    const largeContent = 'eval("bad")\n'.repeat(50000); // >500K
    const files = { 'big.js': largeContent };
    const report = scanForDrift(files, [pattern]);
    expect(report.violations).toEqual([]);
  });

  it('calculates score as 1 - (violations * 0.1)', () => {
    const pattern = makePattern('no-eval', 'Avoid `eval`');
    const files = { 'a.js': 'eval(1)\neval(2)\neval(3)' };
    const report = scanForDrift(files, [pattern]);
    expect(report.violations).toHaveLength(3);
    expect(report.score).toBeCloseTo(0.7);
  });

  it('clamps score at 0', () => {
    const pattern = makePattern('no-eval', 'Avoid `eval`');
    const lines = Array.from({ length: 15 }, () => 'eval("x")').join('\n');
    const files = { 'a.js': lines };
    const report = scanForDrift(files, [pattern]);
    expect(report.score).toBe(0);
  });

  it('skips patterns with null antiPatterns', () => {
    const pattern = makePattern('info-only', null);
    const files = { 'app.js': 'eval("anything")' };
    const report = scanForDrift(files, [pattern]);
    expect(report.violations).toEqual([]);
  });

  it('tracks scannedFiles and scannedPatterns', () => {
    const pattern = makePattern('test', 'Avoid `eval`');
    const files = { 'a.js': 'ok', 'b.js': 'fine' };
    const report = scanForDrift(files, [pattern]);
    expect(report.scannedFiles).toBe(2);
    expect(report.scannedPatterns).toBe(1);
  });
});

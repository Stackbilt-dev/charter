import { describe, expect, it } from 'vitest';
import type { Pattern } from '@stackbilt/types';
import { extractRules, scanForDrift } from '../index';

describe('anti-pattern regex literal delimiters (#410)', () => {
  it('retains escaped slashes in the reported import rule', () => {
    const text = String.raw`Avoid /from ['"][^'"]*test\/support/.`;
    const rules = extractRules(text);
    expect(rules).toHaveLength(1);
    expect(rules[0].test("import { x } from '../test/support/identity';")).toBe(true);
    expect(rules[0].test("import { x } from '../test/helpers/identity';")).toBe(false);
  });

  it('extracts a regex wrapped in backticks without losing keyword fallback', () => {
    const rules = extractRules('Avoid ' + '\x60' + String.raw`/test\/support/` + '\x60' + ' and ' + '\x60eval\x60');
    expect(rules).toHaveLength(3);
    expect(rules[0].test('../test/support/identity')).toBe(true);
    expect(rules[1].test(String.raw`/test\/support/`)).toBe(true);
    expect(rules[2].test('eval(1)')).toBe(true);
  });

  it('distinguishes an escaped delimiter from an escaped backslash', () => {
    const rules = extractRules(String.raw`Avoid /path\\/i and /path\\\/tail/`);
    expect(rules).toHaveLength(2);
    expect(rules[0].flags).toBe('i');
    expect(rules[0].test('PATH\\')).toBe(true);
    expect(rules[1].test(String.raw`path\/tail`)).toBe(true);
    expect(rules[1].test('path/tail')).toBe(false);
  });

  it('does not close at slashes inside a character class', () => {
    const rules = extractRules('Avoid /[a/b]+support/ and /[/]end/');
    expect(rules).toHaveLength(2);
    expect(rules[0].test('a/bsupport')).toBe(true);
    expect(rules[1].test('/end')).toBe(true);
    expect(rules[1].test('end')).toBe(false);
  });

  it('honors escaped brackets and slashes inside character classes', () => {
    const rules = extractRules(String.raw`Avoid /[\/\]]+\/end/`);
    expect(rules).toHaveLength(1);
    expect(rules[0].test(']/end')).toBe(true);
    expect(rules[0].test('x/end')).toBe(false);
  });

  it('retains flags and extracts multiple slash-containing literals', () => {
    const rules = extractRules(String.raw`Avoid /TEST\/SUPPORT/i and /other\/path/m`);
    expect(rules).toHaveLength(2);
    expect(rules[0].flags).toBe('i');
    expect(rules[0].test('test/support')).toBe(true);
    expect(rules[1].flags).toBe('m');
    expect(rules[1].test('other/path')).toBe(true);
  });

  it('keeps standalone code-token fallback and ignores invalid literal bodies', () => {
    const rules = extractRules('Avoid /(/ and ' + '\x60foo.bar()\x60');
    expect(rules).toHaveLength(1);
    expect(rules[0].test('foo.bar()')).toBe(true);
    expect(rules[0].test('fooXbar()')).toBe(false);
  });

  it('does not combine a literal body across a newline', () => {
    expect(extractRules('/first\nsecond/')).toEqual([]);
    expect(extractRules('/first\\\nsecond/')).toEqual([]);
  });

  it('does not turn separators after an unterminated class into policy rules', () => {
    const rules = extractRules('Avoid /[/ and /(/');
    expect(rules).toEqual([]);
    expect(rules.some(rule => rule.test('please and thank you'))).toBe(false);
  });

  it('retains earlier literals but discards the rest of a malformed literal line', () => {
    const rules = extractRules('Avoid /valid/i then /[/ and /other/');
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe('valid');
    expect(rules[0].flags).toBe('i');
    expect(rules[0].test('VALID')).toBe(true);
    expect(rules[0].test('please and other')).toBe(false);
  });

  it.each(['\n', '\r\n', '\r'])('recovers at a new line after malformed classes (%j)', newline => {
    const text = 'Avoid /[/ and /(/' + newline + String.raw`Avoid /test\/support/ and ` + '\x60eval\x60';
    const rules = extractRules(text);
    expect(rules).toHaveLength(2);
    expect(rules[0].test('test/support')).toBe(true);
    expect(rules[1].test('eval(1)')).toBe(true);
    expect(rules.some(rule => rule.test('please and thank you'))).toBe(false);
  });

  it('does not reuse an empty literal delimiter as a new opener', () => {
    const rules = extractRules('Avoid // and /valid/');
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe('valid');
  });

  it('reports the actual escaped-slash rule against matching files only', () => {
    const pattern: Pattern = {
      id: 'escaped-slash', name: 'No test support imports', category: 'SECURITY',
      blessedSolution: 'Use public modules', rationale: null,
      antiPatterns: 'Avoid ' + '\x60' + String.raw`/from ['"][^'"]*test\/support/` + '\x60' + '.',
      documentationUrl: null, relatedLedgerId: null, status: 'ACTIVE',
      createdAt: '2025-01-01', projectId: null,
    };
    const report = scanForDrift({
      'bad.ts': "import { x } from '../test/support/identity';",
      'good.ts': "import { x } from '../test/helpers/identity';",
    }, [pattern]);
    expect(report.violations).toEqual([expect.objectContaining({
      file: 'bad.ts', line: 1, patternName: pattern.name, severity: 'MAJOR',
    })]);
    expect(report.score).toBeCloseTo(0.9);
    expect(report.scannedFiles).toBe(2);
  });
});

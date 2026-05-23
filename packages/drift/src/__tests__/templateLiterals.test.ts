import { describe, it, expect } from 'vitest';
import { extractTemplateLiterals, scanForDrift } from '../index';
import type { Pattern } from '@stackbilt/types';

describe('extractTemplateLiterals', () => {
  it('returns empty map for non-TS/JS files', () => {
    const result = extractTemplateLiterals('const x = `hello world from template`;', 'config.yaml');
    expect(result).toEqual({});
  });

  it('returns empty map for .txt files', () => {
    const result = extractTemplateLiterals('`some long template content here`', 'readme.txt');
    expect(result).toEqual({});
  });

  it('returns empty map when file has no template literals', () => {
    const result = extractTemplateLiterals('const x = "hello"; const y = 42;', 'src/util.ts');
    expect(result).toEqual({});
  });

  it('skips template literals with 20 chars or fewer', () => {
    // 15 chars — should be skipped
    const result = extractTemplateLiterals('const x = `short15chars`;', 'src/util.ts');
    expect(result).toEqual({});
  });

  it('includes template literals longer than 20 chars', () => {
    // 100+ chars — should be included
    const body = 'this is a sufficiently long template literal body that exceeds the threshold';
    const result = extractTemplateLiterals(`const x = \`${body}\`;`, 'src/util.ts');
    expect(Object.keys(result)).toHaveLength(1);
    expect(Object.values(result)[0]).toBe(body);
  });

  it('uses virtual filename format filename[template:N]', () => {
    const body = 'this is a sufficiently long template literal body content';
    const result = extractTemplateLiterals(`const x = \`${body}\`;`, 'src/templates/hmac.ts');
    expect(Object.keys(result)[0]).toBe('src/templates/hmac.ts[template:0]');
  });

  it('indexes multiple template literals sequentially', () => {
    const body1 = 'first template literal body that is long enough to count';
    const body2 = 'second template literal body that is also long enough to count';
    const content = `const a = \`${body1}\`;\nconst b = \`${body2}\`;`;
    const result = extractTemplateLiterals(content, 'src/util.ts');
    expect(Object.keys(result)).toContain('src/util.ts[template:0]');
    expect(Object.keys(result)).toContain('src/util.ts[template:1]');
    expect(result['src/util.ts[template:0]']).toBe(body1);
    expect(result['src/util.ts[template:1]']).toBe(body2);
  });

  it('works for .js files', () => {
    const body = 'function body that is long enough to be extracted by scanner';
    const result = extractTemplateLiterals(`module.exports = \`${body}\`;`, 'lib/factory.js');
    expect(Object.keys(result)).toHaveLength(1);
    expect(Object.keys(result)[0]).toBe('lib/factory.js[template:0]');
  });

  it('works for .mjs files', () => {
    const body = 'export default template that is long enough to be extracted by scanner';
    const result = extractTemplateLiterals(`export default \`${body}\`;`, 'lib/factory.mjs');
    expect(Object.keys(result)).toHaveLength(1);
    expect(Object.keys(result)[0]).toBe('lib/factory.mjs[template:0]');
  });

  it('works for .tsx files', () => {
    const body = 'react template literal body that is long enough to be extracted';
    const result = extractTemplateLiterals(`const style = \`${body}\`;`, 'src/Component.tsx');
    expect(Object.keys(result)).toHaveLength(1);
    expect(Object.keys(result)[0]).toBe('src/Component.tsx[template:0]');
  });
});

describe('scanForDrift with template literal extraction', () => {
  const makePattern = (name: string, antiPatterns: string | null): Pattern => ({
    id: '1',
    name,
    category: 'SECURITY',
    blessedSolution: 'Use constant-time comparison',
    rationale: null,
    antiPatterns,
    documentationUrl: null,
    relatedLedgerId: null,
    status: 'ACTIVE',
    createdAt: '2025-01-01',
    projectId: null,
  });

  it('detects timing attack inside a template literal (code-factory pattern)', () => {
    // A function that returns a multi-line backtick string containing the vulnerable code
    const content = [
      'export function hmacVerifyFunction(): string {',
      '  return `',
      'function verify(a, b) {',
      '  return a === b;',
      '}',
      '`;',
      '}',
    ].join('\n');

    const pattern = makePattern('no-timing-attack', 'Avoid /a === b/');
    const files = { 'src/templates/hmac.ts': content };
    const report = scanForDrift(files, [pattern]);

    // Should find a violation attributed to the virtual template filename
    const templateViolations = report.violations.filter(v =>
      v.file.includes('[template:')
    );
    expect(templateViolations.length).toBeGreaterThan(0);
    expect(templateViolations[0].file).toMatch(/^src\/templates\/hmac\.ts\[template:\d+\]$/);
    expect(templateViolations[0].snippet).toContain('a === b');
  });

  it('attributes template violations to virtual filename, not original file', () => {
    const content = 'export const tmpl = `\nreturn inputA === inputB;\n`;';
    const pattern = makePattern('no-direct-compare', 'Avoid /inputA === inputB/');
    const files = { 'src/codegen/auth.ts': content };
    const report = scanForDrift(files, [pattern]);

    const templateViolations = report.violations.filter(v =>
      v.file.startsWith('src/codegen/auth.ts[template:')
    );
    expect(templateViolations.length).toBeGreaterThan(0);
    expect(templateViolations[0].file).toBe('src/codegen/auth.ts[template:0]');
  });

  it('does not template-scan non-TS/JS files', () => {
    // YAML file containing backtick-like content should not be template-scanned
    const content = 'pattern: |\n  return a === b;\n';
    const pattern = makePattern('no-timing-attack', 'Avoid /a === b/');
    const files = { 'config.yaml': content };
    const report = scanForDrift(files, [pattern]);

    const templateViolations = report.violations.filter(v =>
      v.file.includes('[template:')
    );
    expect(templateViolations).toHaveLength(0);
  });

  it('line numbers in template violations are 1-indexed relative to template body', () => {
    // Template body: line 1 is "// begin generated code" (padding to exceed 20 chars),
    // line 2 has the vulnerable pattern
    const content = 'const gen = `\n// begin generated code\nreturn x === y;\n`;';
    const pattern = makePattern('no-direct-eq', 'Avoid /x === y/');
    const files = { 'src/gen.ts': content };
    const report = scanForDrift(files, [pattern]);

    const templateViolations = report.violations.filter(v =>
      v.file.includes('[template:')
    );
    expect(templateViolations.length).toBeGreaterThan(0);
    // line 1 is "// begin generated code"
    // line 2 is "return x === y;"
    expect(templateViolations[0].line).toBe(3);
  });
});

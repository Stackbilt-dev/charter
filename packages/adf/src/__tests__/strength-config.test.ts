import { describe, it, expect } from 'vitest';
import { parseMarkdownSections } from '../markdown-parser';
import type { StrengthConfig } from '../markdown-parser';

describe('StrengthConfig', () => {
  const md = '## Rules\n- ALWAYS do X\n- prefer Y\n- do Z';

  it('uses default patterns when config omitted', () => {
    const sections = parseMarkdownSections(md);
    const rules = sections[0].elements;
    expect(rules[0].strength).toBe('imperative');
    expect(rules[1].strength).toBe('advisory');
    expect(rules[2].strength).toBe('neutral');
  });

  it('respects custom imperativePatterns', () => {
    const config: StrengthConfig = { imperativePatterns: [/\bdo Z\b/] };
    const sections = parseMarkdownSections(md, config);
    const rules = sections[0].elements;
    // "ALWAYS" no longer matches custom list → neutral
    expect(rules[0].strength).toBe('neutral');
    // "do Z" now matches imperative
    expect(rules[2].strength).toBe('imperative');
  });

  it('respects custom advisoryPatterns', () => {
    const config: StrengthConfig = { advisoryPatterns: [/\bdo Z\b/] };
    const sections = parseMarkdownSections(md, config);
    const rules = sections[0].elements;
    // "prefer" no longer matches custom list → neutral
    expect(rules[1].strength).toBe('neutral');
    // "do Z" now matches advisory
    expect(rules[2].strength).toBe('advisory');
  });
});

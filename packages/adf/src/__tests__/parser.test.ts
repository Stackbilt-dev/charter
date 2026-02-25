import { describe, it, expect } from 'vitest';
import { parseAdf } from '../parser';

describe('parseAdf', () => {
  it('parses a minimal document with version and one section', () => {
    const doc = parseAdf('ADF: 0.1\n\u{1F3AF} TASK: Do something\n');
    expect(doc.version).toBe('0.1');
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].key).toBe('TASK');
    expect(doc.sections[0].decoration).toBe('\u{1F3AF}');
    expect(doc.sections[0].content).toEqual({ type: 'text', value: 'Do something' });
  });

  it('strips emoji decoration from key', () => {
    const doc = parseAdf('\u{1F3AF} TASK: Build it\n');
    expect(doc.sections[0].key).toBe('TASK');
    expect(doc.sections[0].decoration).toBe('\u{1F3AF}');
  });

  it('parses without emoji decoration', () => {
    const doc = parseAdf('TASK: Build it\n');
    expect(doc.sections[0].key).toBe('TASK');
    expect(doc.sections[0].decoration).toBeNull();
  });

  it('defaults to version 0.1 when version line is missing', () => {
    const doc = parseAdf('TASK: Do something\n');
    expect(doc.version).toBe('0.1');
    expect(doc.sections).toHaveLength(1);
  });

  it('parses list content (dash-prefixed items)', () => {
    const input = 'CONSTRAINTS:\n  - No new deps\n  - Keep it simple\n';
    const doc = parseAdf(input);
    expect(doc.sections[0].content).toEqual({
      type: 'list',
      items: ['No new deps', 'Keep it simple'],
    });
  });

  it('parses map content (KEY: value pairs)', () => {
    const input = '\u{1F9E0} STATE:\n  CURRENT: Working on feature\n  NEXT: Deploy to staging\n';
    const doc = parseAdf(input);
    expect(doc.sections[0].content).toEqual({
      type: 'map',
      entries: [
        { key: 'CURRENT', value: 'Working on feature' },
        { key: 'NEXT', value: 'Deploy to staging' },
      ],
    });
  });

  it('parses multiple sections', () => {
    const input = [
      'ADF: 0.1',
      '\u{1F3AF} TASK: Build feature',
      '',
      '\u{26A0}\uFE0F CONSTRAINTS:',
      '  - Stay fast',
      '',
      '\u{1F9E0} STATE:',
      '  CURRENT: Starting',
    ].join('\n');
    const doc = parseAdf(input);
    expect(doc.sections).toHaveLength(3);
    expect(doc.sections[0].key).toBe('TASK');
    expect(doc.sections[1].key).toBe('CONSTRAINTS');
    expect(doc.sections[2].key).toBe('STATE');
  });

  it('handles empty document', () => {
    const doc = parseAdf('');
    expect(doc.version).toBe('0.1');
    expect(doc.sections).toEqual([]);
  });

  it('handles document with only version line', () => {
    const doc = parseAdf('ADF: 0.1\n');
    expect(doc.version).toBe('0.1');
    expect(doc.sections).toEqual([]);
  });

  it('tolerates \r\n line endings', () => {
    const doc = parseAdf('ADF: 0.1\r\nTASK: Build\r\n');
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].content).toEqual({ type: 'text', value: 'Build' });
  });

  it('tolerates trailing whitespace on lines', () => {
    const doc = parseAdf('TASK: Build   \n');
    expect(doc.sections[0].content).toEqual({ type: 'text', value: 'Build' });
  });

  it('throws on unsupported version', () => {
    expect(() => parseAdf('ADF: 2.0\nTASK: Nope\n')).toThrow('Unsupported ADF version');
  });

  it('handles section with empty content', () => {
    const doc = parseAdf('TASK:\n');
    expect(doc.sections[0].content).toEqual({ type: 'text', value: '' });
  });

  // --- Metric content type ---

  it('parses metric content (key: value / ceiling [unit])', () => {
    const input = [
      'STATE:',
      '  entry_loc: 142 / 200 [lines]',
      '  total_loc: 312 / 400 [lines]',
    ].join('\n');
    const doc = parseAdf(input);
    expect(doc.sections[0].content).toEqual({
      type: 'metric',
      entries: [
        { key: 'entry_loc', value: 142, ceiling: 200, unit: 'lines' },
        { key: 'total_loc', value: 312, ceiling: 400, unit: 'lines' },
      ],
    });
  });

  it('parses metric with decimal values', () => {
    const input = 'BUDGET:\n  summary_size: 1.8 / 2.0 [KB]\n';
    const doc = parseAdf(input);
    expect(doc.sections[0].content).toEqual({
      type: 'metric',
      entries: [
        { key: 'summary_size', value: 1.8, ceiling: 2.0, unit: 'KB' },
      ],
    });
  });

  it('parses metric with multi-word unit', () => {
    const input = 'STATE:\n  context_tokens: 2400 / 4000 [estimated tokens]\n';
    const doc = parseAdf(input);
    if (doc.sections[0].content.type === 'metric') {
      expect(doc.sections[0].content.entries[0].unit).toBe('estimated tokens');
    }
  });

  // --- Weight annotations ---

  it('parses [load-bearing] weight annotation', () => {
    const input = '\u{26A0}\u{FE0F} CONSTRAINTS [load-bearing]:\n  - Max 400 LOC\n';
    const doc = parseAdf(input);
    expect(doc.sections[0].weight).toBe('load-bearing');
    expect(doc.sections[0].key).toBe('CONSTRAINTS');
    expect(doc.sections[0].content).toEqual({
      type: 'list',
      items: ['Max 400 LOC'],
    });
  });

  it('parses [advisory] weight annotation', () => {
    const input = 'CONTEXT [advisory]: Background info\n';
    const doc = parseAdf(input);
    expect(doc.sections[0].weight).toBe('advisory');
    expect(doc.sections[0].content).toEqual({ type: 'text', value: 'Background info' });
  });

  it('omits weight when no annotation present', () => {
    const doc = parseAdf('TASK: Build it\n');
    expect(doc.sections[0].weight).toBeUndefined();
  });

  it('parses weight annotation without emoji', () => {
    const input = 'CONSTRAINTS [load-bearing]:\n  - Entry point < 200 LOC\n';
    const doc = parseAdf(input);
    expect(doc.sections[0].weight).toBe('load-bearing');
    expect(doc.sections[0].decoration).toBeNull();
  });
});

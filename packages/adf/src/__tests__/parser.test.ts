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
});

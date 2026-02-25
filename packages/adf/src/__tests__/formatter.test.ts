import { describe, it, expect } from 'vitest';
import { formatAdf } from '../formatter';
import { parseAdf } from '../parser';
import type { AdfDocument } from '../types';

describe('formatAdf', () => {
  it('emits version line', () => {
    const doc: AdfDocument = { version: '0.1', sections: [] };
    expect(formatAdf(doc)).toBe('ADF: 0.1\n');
  });

  it('sorts sections by canonical key order', () => {
    const doc: AdfDocument = {
      version: '0.1',
      sections: [
        { key: 'STATE', decoration: null, content: { type: 'text', value: 'Running' } },
        { key: 'TASK', decoration: null, content: { type: 'text', value: 'Build' } },
      ],
    };
    const output = formatAdf(doc);
    const taskIdx = output.indexOf('TASK:');
    const stateIdx = output.indexOf('STATE:');
    expect(taskIdx).toBeLessThan(stateIdx);
  });

  it('auto-injects standard emoji when decoration is null', () => {
    const doc: AdfDocument = {
      version: '0.1',
      sections: [
        { key: 'TASK', decoration: null, content: { type: 'text', value: 'Build it' } },
      ],
    };
    const output = formatAdf(doc);
    expect(output).toContain('\u{1F3AF} TASK: Build it');
  });

  it('preserves custom decoration', () => {
    const doc: AdfDocument = {
      version: '0.1',
      sections: [
        { key: 'CONTEXT', decoration: '\u{2699}\uFE0F', content: { type: 'text', value: 'Custom' } },
      ],
    };
    const output = formatAdf(doc);
    expect(output).toContain('\u{2699}\uFE0F CONTEXT: Custom');
  });

  it('formats list items with 2-space indent', () => {
    const doc: AdfDocument = {
      version: '0.1',
      sections: [
        {
          key: 'CONSTRAINTS',
          decoration: null,
          content: { type: 'list', items: ['No deps', 'Stay fast'] },
        },
      ],
    };
    const output = formatAdf(doc);
    expect(output).toContain('  - No deps');
    expect(output).toContain('  - Stay fast');
  });

  it('formats map entries with 2-space indent', () => {
    const doc: AdfDocument = {
      version: '0.1',
      sections: [
        {
          key: 'STATE',
          decoration: null,
          content: {
            type: 'map',
            entries: [
              { key: 'CURRENT', value: 'Working' },
              { key: 'NEXT', value: 'Deploy' },
            ],
          },
        },
      ],
    };
    const output = formatAdf(doc);
    expect(output).toContain('  CURRENT: Working');
    expect(output).toContain('  NEXT: Deploy');
  });

  it('appends unknown keys after canonical keys', () => {
    const doc: AdfDocument = {
      version: '0.1',
      sections: [
        { key: 'CUSTOM', decoration: null, content: { type: 'text', value: 'Extra' } },
        { key: 'TASK', decoration: null, content: { type: 'text', value: 'Build' } },
      ],
    };
    const output = formatAdf(doc);
    const taskIdx = output.indexOf('TASK:');
    const customIdx = output.indexOf('CUSTOM:');
    expect(taskIdx).toBeLessThan(customIdx);
  });

  it('roundtrip: parse then format is idempotent', () => {
    const input = [
      'ADF: 0.1',
      '',
      '\u{1F3AF} TASK: Build feature',
      '',
      '\u{26A0}\uFE0F CONSTRAINTS:',
      '  - No new deps',
      '  - Keep it simple',
      '',
      '\u{1F9E0} STATE:',
      '  CURRENT: Starting',
      '  NEXT: Continue',
      '',
    ].join('\n');
    const doc = parseAdf(input);
    const formatted = formatAdf(doc);
    const doc2 = parseAdf(formatted);
    const formatted2 = formatAdf(doc2);
    expect(formatted2).toBe(formatted);
  });

  // --- Metric content type ---

  it('formats metric entries as key: value / ceiling [unit]', () => {
    const doc: AdfDocument = {
      version: '0.1',
      sections: [
        {
          key: 'STATE',
          decoration: null,
          content: {
            type: 'metric',
            entries: [
              { key: 'entry_loc', value: 142, ceiling: 200, unit: 'lines' },
              { key: 'total_loc', value: 312, ceiling: 400, unit: 'lines' },
            ],
          },
        },
      ],
    };
    const output = formatAdf(doc);
    expect(output).toContain('  entry_loc: 142 / 200 [lines]');
    expect(output).toContain('  total_loc: 312 / 400 [lines]');
  });

  it('roundtrip: metric content is idempotent', () => {
    const input = [
      'ADF: 0.1',
      '',
      '\u{1F9E0} STATE:',
      '  entry_loc: 142 / 200 [lines]',
      '  total_loc: 312 / 400 [lines]',
      '',
    ].join('\n');
    const doc = parseAdf(input);
    const formatted = formatAdf(doc);
    const doc2 = parseAdf(formatted);
    const formatted2 = formatAdf(doc2);
    expect(formatted2).toBe(formatted);
  });

  // --- Weight annotations ---

  it('emits [load-bearing] weight annotation in header', () => {
    const doc: AdfDocument = {
      version: '0.1',
      sections: [
        {
          key: 'CONSTRAINTS',
          decoration: null,
          content: { type: 'list', items: ['Max 400 LOC'] },
          weight: 'load-bearing',
        },
      ],
    };
    const output = formatAdf(doc);
    expect(output).toContain('CONSTRAINTS [load-bearing]:');
  });

  it('emits [advisory] weight annotation in header', () => {
    const doc: AdfDocument = {
      version: '0.1',
      sections: [
        {
          key: 'CONTEXT',
          decoration: null,
          content: { type: 'text', value: 'Background' },
          weight: 'advisory',
        },
      ],
    };
    const output = formatAdf(doc);
    expect(output).toContain('CONTEXT [advisory]: Background');
  });

  it('omits weight annotation when not set', () => {
    const doc: AdfDocument = {
      version: '0.1',
      sections: [
        { key: 'TASK', decoration: null, content: { type: 'text', value: 'Build' } },
      ],
    };
    const output = formatAdf(doc);
    expect(output).not.toContain('[load-bearing]');
    expect(output).not.toContain('[advisory]');
  });

  it('roundtrip: weight annotation is idempotent', () => {
    const input = [
      'ADF: 0.1',
      '',
      '\u{26A0}\u{FE0F} CONSTRAINTS [load-bearing]:',
      '  - Entry point < 200 LOC',
      '',
    ].join('\n');
    const doc = parseAdf(input);
    const formatted = formatAdf(doc);
    const doc2 = parseAdf(formatted);
    const formatted2 = formatAdf(doc2);
    expect(formatted2).toBe(formatted);
  });
});

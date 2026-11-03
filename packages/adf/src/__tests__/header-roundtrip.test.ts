import { describe, expect, it } from 'vitest';
import { parseAdf } from '../parser';
import { formatAdf } from '../formatter';
import { validateConstraints } from '../validator';

describe('section headers that used to become body text (#389)', () => {
  it.each(['SENSITIVITY TIERS', 'DATA_AUTHORITY TIERS', 'TIER 2 RULES'])('keeps %s as a separate section', key => {
    const input = `\u{1F4D0} RULES:\n  - keep me\n\n\u{1F510} ${key} [load-bearing]:\n  - tier one\n`;
    const parsed = parseAdf(input);
    expect(parsed.sections.map(section => section.key)).toEqual(['RULES', key]);
    expect(parsed.sections[0].content).toEqual({ type: 'list', items: ['keep me'] });
    expect(parsed.sections[1]).toMatchObject({
      decoration: '\u{1F510}', weight: 'load-bearing', content: { type: 'list', items: ['tier one'] },
    });
    const formatted = formatAdf(parsed);
    expect(formatted).toContain(`\n\u{1F510} ${key} [load-bearing]:\n`);
    expect(parseAdf(formatted)).toEqual(parsed);
    expect(formatAdf(parseAdf(formatted))).toBe(formatted);
  });

  it('accepts an undecorated multi-word header with inline text and advisory weight', () => {
    const parsed = parseAdf('RULES:\n  - keep me\n\nSENSITIVITY TIERS [advisory]: internal only\n');
    expect(parsed.sections[1]).toEqual({
      key: 'SENSITIVITY TIERS', decoration: null, weight: 'advisory', content: { type: 'text', value: 'internal only' },
    });
    expect(formatAdf(parseAdf(formatAdf(parsed)))).toBe(formatAdf(parsed));
  });

  it.each([2, 3])('accepts %i variation selectors without losing a constraint section', count => {
    const input = `RULES:\n  - keep me\n\n\u26A0${'\uFE0F'.repeat(count)} CONSTRAINTS [load-bearing]:\n  entry_loc: 12 / 10 [lines]\n`;
    const parsed = parseAdf(input);
    expect(parsed.sections.map(section => section.key)).toEqual(['RULES', 'CONSTRAINTS']);
    const evidence = validateConstraints(parsed);
    expect(evidence.failCount).toBe(1);
    expect(evidence.constraints[0]).toMatchObject({ section: 'CONSTRAINTS', metric: 'entry_loc', value: 12 });
    const formatted = formatAdf(parsed);
    expect(formatted).toContain('\n\u26A0\uFE0F CONSTRAINTS [load-bearing]:\n');
    expect(validateConstraints(parseAdf(formatted))).toEqual(evidence);
    expect(formatAdf(parseAdf(formatted))).toBe(formatted);
  });

  it('does not turn indented entries, prose or list text into sections', () => {
    const input = 'RULES:\n  - SENSITIVITY TIERS: keep as a bullet\n  - \u26A0\uFE0F\uFE0F CONSTRAINTS: also a bullet\n\nSTATE:\n  CURRENT: working\n\nNOTES:\n  SENSITIVITY TIERS: an indented line\n  Ordinary prose: stays here\n';
    const parsed = parseAdf(input);
    expect(parsed.sections.map(section => section.key)).toEqual(['RULES', 'STATE', 'NOTES']);
    expect(parsed.sections[0].content.type).toBe('list');
    expect(parsed.sections[1].content).toEqual({ type: 'map', entries: [{ key: 'CURRENT', value: 'working' }] });
    expect(parsed.sections[2].content).toEqual({ type: 'text', value: 'SENSITIVITY TIERS: an indented line\nOrdinary prose: stays here' });
    expect(formatAdf(parseAdf(formatAdf(parsed)))).toBe(formatAdf(parsed));
  });
});

/**
 * VENDORS manifest section (#318): the vendor file mode record.
 *
 * parseManifest stays permissive (raw strings, never throws, INV-12), and the
 * section is never rendered into compiled output (INV-4).
 */

import { describe, it, expect } from 'vitest';
import { parseAdf } from '../parser';
import { parseManifest } from '../manifest';
import { formatAdf } from '../formatter';
import { compileAdf, COMPILE_TARGETS } from '../compiler';
import { STANDARD_DECORATIONS, CANONICAL_KEY_ORDER } from '../types';

const MANIFEST = `ADF: 0.1

📦 DEFAULT_LOAD:
  - core.adf

🏷️ VENDORS:
  - CLAUDE.md: pointer
  - AGENTS.md: compiled
  - .cursorrules:unmanaged
`;

describe('parseManifest VENDORS', () => {
  it('parses a 🏷️ VENDORS list into raw file/mode entries', () => {
    const doc = parseAdf(MANIFEST);
    const section = doc.sections.find(s => s.key === 'VENDORS');
    expect(section?.decoration).toBe('\u{1F3F7}');
    expect(parseManifest(doc).vendors).toEqual([
      { raw: 'CLAUDE.md: pointer', file: 'CLAUDE.md', mode: 'pointer' },
      { raw: 'AGENTS.md: compiled', file: 'AGENTS.md', mode: 'compiled' },
      { raw: '.cursorrules:unmanaged', file: '.cursorrules', mode: 'unmanaged' },
    ]);
  });

  it('defaults to an empty list when there is no VENDORS section', () => {
    expect(parseManifest(parseAdf('ADF: 0.1\n\n📦 DEFAULT_LOAD:\n  - core.adf\n')).vendors).toEqual([]);
  });

  it('keeps malformed, unknown-file, mode-not-allowed and duplicate entries without throwing (INV-12)', () => {
    const text = `ADF: 0.1
🏷️ VENDORS:
  - CLAUDE.md pointer
  - CLAUDE.md: pointr
  - README.md: pointer
  - copilot-instructions.md: compiled
  - CLAUDE.md: pointer
  - CLAUDE.md: compiled
  - : pointer
`;
    let vendors: ReturnType<typeof parseManifest>['vendors'] = [];
    expect(() => { vendors = parseManifest(parseAdf(text)).vendors; }).not.toThrow();
    expect(vendors).toEqual([
      { raw: 'CLAUDE.md pointer', file: null, mode: null },
      { raw: 'CLAUDE.md: pointr', file: null, mode: null },
      // The parser knows no file names or allowed modes; the CLI validates.
      { raw: 'README.md: pointer', file: 'README.md', mode: 'pointer' },
      { raw: 'copilot-instructions.md: compiled', file: 'copilot-instructions.md', mode: 'compiled' },
      { raw: 'CLAUDE.md: pointer', file: 'CLAUDE.md', mode: 'pointer' },
      { raw: 'CLAUDE.md: compiled', file: 'CLAUDE.md', mode: 'compiled' },
      { raw: ': pointer', file: null, mode: null },
    ]);
  });

  it('ignores a VENDORS section that is not a list, without throwing (INV-12)', () => {
    for (const body of ['🏷️ VENDORS: CLAUDE.md pointer\n', '🏷️ VENDORS:\n  CLAUDE: pointer\n', '🏷️ VENDORS:\n']) {
      expect(() => parseManifest(parseAdf(`ADF: 0.1\n${body}`))).not.toThrow();
      expect(parseManifest(parseAdf(`ADF: 0.1\n${body}`)).vendors).toEqual([]);
    }
  });

  it('leaves every other manifest field unchanged', () => {
    const without = parseManifest(parseAdf(MANIFEST.replace(/🏷️ VENDORS:[\s\S]*$/, '')));
    const withVendors = parseManifest(parseAdf(MANIFEST));
    expect({ ...withVendors, vendors: [] }).toEqual(without);
  });
});

describe('VENDORS decoration and ordering', () => {
  it('has the label decoration and sorts right after SYNC', () => {
    expect(STANDARD_DECORATIONS.VENDORS).toBe('\u{1F3F7}\u{FE0F}');
    expect(CANONICAL_KEY_ORDER.indexOf('VENDORS')).toBe(CANONICAL_KEY_ORDER.indexOf('SYNC') + 1);
    const formatted = formatAdf(parseAdf('ADF: 0.1\n🏷️ VENDORS:\n  - CLAUDE.md: pointer\n🔄 SYNC:\n  - core.adf -> CLAUDE.md\n'));
    expect(formatted.indexOf('SYNC:')).toBeLessThan(formatted.indexOf('VENDORS:'));
  });
});

describe('compileAdf never renders VENDORS (INV-4)', () => {
  const files: Record<string, string> = {
    '/ai/manifest.adf': MANIFEST,
    // A module that declares VENDORS itself: MANIFEST_PLUMBING_KEYS keeps it out.
    '/ai/core.adf': 'ADF: 0.1\n\n📋 CONTEXT:\n  - TypeScript monorepo\n\n🏷️ VENDORS:\n  - GEMINI.md: compiled\n',
  };
  const readFile = (p: string): string => {
    const content = files[p];
    if (content === undefined) throw new Error(`File not found: ${p}`);
    return content;
  };

  for (const target of COMPILE_TARGETS) {
    it(`omits VENDORS from the ${target} output`, () => {
      const { output } = compileAdf({ target, aiDir: '/ai', displayAiDir: '.ai', readFile });
      expect(output).toContain('TypeScript monorepo');
      expect(output).not.toContain('VENDORS');
      expect(output).not.toContain('GEMINI.md: compiled');
    });
  }
});

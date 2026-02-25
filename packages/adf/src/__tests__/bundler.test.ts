import { describe, it, expect } from 'vitest';
import { parseManifest, resolveModules, bundleModules } from '../bundler';
import { parseAdf } from '../parser';

const MANIFEST_ADF = `ADF: 0.1
ROLE: Repo context router

DEFAULT_LOAD:
  - core.adf
  - state.adf

ON_DEMAND:
  - frontend.adf (Triggers on: React, CSS, UI)
  - backend.adf (Triggers on: API, Node, DB)

RULES:
  - Prefer smallest relevant module set.
  - Never assume unseen modules were loaded.
`;

const MANIFEST_WITH_BUDGET = `ADF: 0.1
ROLE: Repo context router

DEFAULT_LOAD:
  - core.adf
  - state.adf

ON_DEMAND:
  - frontend.adf (Triggers on: React, CSS, UI)

BUDGET:
  MAX_TOKENS: 4000

RULES:
  - Prefer smallest relevant module set.
`;

describe('parseManifest', () => {
  it('extracts defaultLoad modules', () => {
    const doc = parseAdf(MANIFEST_ADF);
    const manifest = parseManifest(doc);
    expect(manifest.defaultLoad).toEqual(['core.adf', 'state.adf']);
  });

  it('extracts onDemand modules with triggers', () => {
    const doc = parseAdf(MANIFEST_ADF);
    const manifest = parseManifest(doc);
    expect(manifest.onDemand).toHaveLength(2);
    expect(manifest.onDemand[0].path).toBe('frontend.adf');
    expect(manifest.onDemand[0].triggers).toEqual(['React', 'CSS', 'UI']);
    expect(manifest.onDemand[1].path).toBe('backend.adf');
  });

  it('extracts role', () => {
    const doc = parseAdf(MANIFEST_ADF);
    const manifest = parseManifest(doc);
    expect(manifest.role).toBe('Repo context router');
  });

  it('extracts rules', () => {
    const doc = parseAdf(MANIFEST_ADF);
    const manifest = parseManifest(doc);
    expect(manifest.rules).toHaveLength(2);
  });

  it('extracts tokenBudget from BUDGET section', () => {
    const doc = parseAdf(MANIFEST_WITH_BUDGET);
    const manifest = parseManifest(doc);
    expect(manifest.tokenBudget).toBe(4000);
  });

  it('omits tokenBudget when no BUDGET section', () => {
    const doc = parseAdf(MANIFEST_ADF);
    const manifest = parseManifest(doc);
    expect(manifest.tokenBudget).toBeUndefined();
  });
});

describe('resolveModules', () => {
  const doc = parseAdf(MANIFEST_ADF);
  const manifest = parseManifest(doc);

  it('always includes defaultLoad modules', () => {
    const resolved = resolveModules(manifest, []);
    expect(resolved).toContain('core.adf');
    expect(resolved).toContain('state.adf');
  });

  it('includes on-demand module when trigger matches', () => {
    const resolved = resolveModules(manifest, ['React']);
    expect(resolved).toContain('frontend.adf');
    expect(resolved).not.toContain('backend.adf');
  });

  it('trigger matching is case-insensitive', () => {
    const resolved = resolveModules(manifest, ['react']);
    expect(resolved).toContain('frontend.adf');
  });

  it('does not false-match partial keywords', () => {
    const resolved = resolveModules(manifest, ['Reactive']);
    expect(resolved).not.toContain('frontend.adf');
  });

  it('resolves multiple on-demand modules', () => {
    const resolved = resolveModules(manifest, ['React', 'API']);
    expect(resolved).toContain('frontend.adf');
    expect(resolved).toContain('backend.adf');
  });
});

describe('bundleModules', () => {
  const FILES: Record<string, string> = {
    '/ai/manifest.adf': MANIFEST_ADF,
    '/ai/core.adf': `ADF: 0.1\nCONSTRAINTS:\n  - No secrets\n`,
    '/ai/state.adf': `ADF: 0.1\nSTATE:\n  CURRENT: Working\n`,
    '/ai/frontend.adf': `ADF: 0.1\nCONSTRAINTS:\n  - Use React hooks\n`,
  };

  const readFile = (p: string): string => {
    const content = FILES[p];
    if (!content) throw new Error(`File not found: ${p}`);
    return content;
  };

  it('merges sections from multiple modules', () => {
    const result = bundleModules('/ai', ['core.adf', 'state.adf', 'frontend.adf'], readFile);
    const constraints = result.mergedDocument.sections.find(s => s.key === 'CONSTRAINTS');
    expect(constraints).toBeDefined();
    if (constraints && constraints.content.type === 'list') {
      expect(constraints.content.items).toEqual(['No secrets', 'Use React hooks']);
    }
  });

  it('returns token estimate > 0', () => {
    const result = bundleModules('/ai', ['core.adf'], readFile);
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it('throws on missing module', () => {
    expect(() =>
      bundleModules('/ai', ['nonexistent.adf'], readFile)
    ).toThrow('Module not found');
  });

  it('includes manifest in result', () => {
    const result = bundleModules('/ai', ['core.adf'], readFile);
    expect(result.manifest.defaultLoad).toEqual(['core.adf', 'state.adf']);
  });

  // --- Token budget ---

  it('reports tokenBudget as null when manifest has no BUDGET', () => {
    const result = bundleModules('/ai', ['core.adf'], readFile);
    expect(result.tokenBudget).toBeNull();
    expect(result.tokenUtilization).toBeNull();
  });

  it('reports tokenBudget and tokenUtilization when manifest has BUDGET', () => {
    const filesWithBudget: Record<string, string> = {
      '/ai/manifest.adf': MANIFEST_WITH_BUDGET,
      '/ai/core.adf': `ADF: 0.1\nCONSTRAINTS:\n  - No secrets\n`,
      '/ai/state.adf': `ADF: 0.1\nSTATE:\n  CURRENT: Working\n`,
    };
    const read = (p: string): string => {
      const content = filesWithBudget[p];
      if (!content) throw new Error(`File not found: ${p}`);
      return content;
    };

    const result = bundleModules('/ai', ['core.adf', 'state.adf'], read);
    expect(result.tokenBudget).toBe(4000);
    expect(result.tokenUtilization).toBeGreaterThan(0);
    expect(result.tokenUtilization).toBeLessThan(1);
  });

  // --- Per-module token tracking ---

  it('reports perModuleTokens for each loaded module', () => {
    const result = bundleModules('/ai', ['core.adf', 'state.adf', 'frontend.adf'], readFile);
    expect(result.perModuleTokens['core.adf']).toBeGreaterThan(0);
    expect(result.perModuleTokens['state.adf']).toBeGreaterThan(0);
    expect(result.perModuleTokens['frontend.adf']).toBeGreaterThan(0);
  });

  // --- Metric merge ---

  it('merges metric sections by concatenating entries', () => {
    const metricFiles: Record<string, string> = {
      '/ai/manifest.adf': MANIFEST_ADF,
      '/ai/mod1.adf': `ADF: 0.1\nMETRICS:\n  entry_loc: 142 / 200 [lines]\n`,
      '/ai/mod2.adf': `ADF: 0.1\nMETRICS:\n  total_loc: 312 / 400 [lines]\n`,
    };
    const read = (p: string): string => {
      const content = metricFiles[p];
      if (!content) throw new Error(`File not found: ${p}`);
      return content;
    };

    const result = bundleModules('/ai', ['mod1.adf', 'mod2.adf'], read);
    const metrics = result.mergedDocument.sections.find(s => s.key === 'METRICS');
    expect(metrics).toBeDefined();
    if (metrics && metrics.content.type === 'metric') {
      expect(metrics.content.entries).toHaveLength(2);
      expect(metrics.content.entries[0].key).toBe('entry_loc');
      expect(metrics.content.entries[1].key).toBe('total_loc');
    }
  });
});

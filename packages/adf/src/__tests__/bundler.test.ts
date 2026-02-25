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

const MANIFEST_WITH_MODULE_BUDGETS = `ADF: 0.1
DEFAULT_LOAD:
  - core.adf

ON_DEMAND:
  - frontend.adf (Triggers on: React, CSS) [budget: 1200]
  - backend.adf (Triggers on: API, Node) [budget: 800]
  - utils.adf [budget: 500]
`;

const MANIFEST_WITH_CADENCE = `ADF: 0.1
DEFAULT_LOAD:
  - core.adf

CADENCE:
  LINT_PASS: every commit
  TEST_COVERAGE: weekly
  DEPENDENCY_AUDIT: monthly
`;

const MANIFEST_FULL = `ADF: 0.1
ROLE: Full context router

DEFAULT_LOAD:
  - core.adf

ON_DEMAND:
  - frontend.adf (Triggers on: React) [budget: 50]

BUDGET:
  MAX_TOKENS: 4000

CADENCE:
  LINT_PASS: every commit
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

  // --- Per-module budget parsing ---

  it('extracts per-module tokenBudget from [budget: N] suffix', () => {
    const doc = parseAdf(MANIFEST_WITH_MODULE_BUDGETS);
    const manifest = parseManifest(doc);
    expect(manifest.onDemand).toHaveLength(3);
    expect(manifest.onDemand[0].path).toBe('frontend.adf');
    expect(manifest.onDemand[0].triggers).toEqual(['React', 'CSS']);
    expect(manifest.onDemand[0].tokenBudget).toBe(1200);
    expect(manifest.onDemand[1].path).toBe('backend.adf');
    expect(manifest.onDemand[1].tokenBudget).toBe(800);
  });

  it('parses [budget: N] on modules without triggers', () => {
    const doc = parseAdf(MANIFEST_WITH_MODULE_BUDGETS);
    const manifest = parseManifest(doc);
    expect(manifest.onDemand[2].path).toBe('utils.adf');
    expect(manifest.onDemand[2].triggers).toEqual([]);
    expect(manifest.onDemand[2].tokenBudget).toBe(500);
  });

  it('omits per-module tokenBudget when not specified', () => {
    const doc = parseAdf(MANIFEST_ADF);
    const manifest = parseManifest(doc);
    expect(manifest.onDemand[0].tokenBudget).toBeUndefined();
  });

  // --- CADENCE parsing ---

  it('extracts cadence entries from CADENCE section', () => {
    const doc = parseAdf(MANIFEST_WITH_CADENCE);
    const manifest = parseManifest(doc);
    expect(manifest.cadence).toHaveLength(3);
    expect(manifest.cadence[0]).toEqual({ check: 'LINT_PASS', frequency: 'every commit' });
    expect(manifest.cadence[1]).toEqual({ check: 'TEST_COVERAGE', frequency: 'weekly' });
    expect(manifest.cadence[2]).toEqual({ check: 'DEPENDENCY_AUDIT', frequency: 'monthly' });
  });

  it('defaults cadence to empty array when not present', () => {
    const doc = parseAdf(MANIFEST_ADF);
    const manifest = parseManifest(doc);
    expect(manifest.cadence).toEqual([]);
  });

  // --- METRICS source parsing ---

  it('extracts metric sources from METRICS section', () => {
    const manifestWithMetrics = `ADF: 0.1
DEFAULT_LOAD:
  - core.adf

METRICS:
  ENTRY_LOC: src/index.ts
  HANDLER_LOC: src/handler.ts
`;
    const doc = parseAdf(manifestWithMetrics);
    const manifest = parseManifest(doc);
    expect(manifest.metrics).toHaveLength(2);
    expect(manifest.metrics[0]).toEqual({ key: 'ENTRY_LOC', path: 'src/index.ts' });
    expect(manifest.metrics[1]).toEqual({ key: 'HANDLER_LOC', path: 'src/handler.ts' });
  });

  it('defaults metrics to empty array when not present', () => {
    const doc = parseAdf(MANIFEST_ADF);
    const manifest = parseManifest(doc);
    expect(manifest.metrics).toEqual([]);
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

  // --- Module budget overruns ---

  it('detects module budget overruns', () => {
    const overrunManifest = `ADF: 0.1
DEFAULT_LOAD:
  - core.adf

ON_DEMAND:
  - frontend.adf (Triggers on: React) [budget: 5]
`;
    const filesOverrun: Record<string, string> = {
      '/ai/manifest.adf': overrunManifest,
      '/ai/core.adf': `ADF: 0.1\nCONSTRAINTS:\n  - No secrets\n`,
      '/ai/frontend.adf': `ADF: 0.1\nCONSTRAINTS:\n  - Use React hooks\n  - Follow component patterns\n  - Keep bundles small\n  - Prefer server components\n  - Use suspense boundaries\n`,
    };
    const read = (p: string): string => {
      const content = filesOverrun[p];
      if (!content) throw new Error(`File not found: ${p}`);
      return content;
    };

    const result = bundleModules('/ai', ['core.adf', 'frontend.adf'], read);
    expect(result.moduleBudgetOverruns.length).toBeGreaterThan(0);
    expect(result.moduleBudgetOverruns[0].module).toBe('frontend.adf');
    expect(result.moduleBudgetOverruns[0].budget).toBe(5);
    expect(result.moduleBudgetOverruns[0].tokens).toBeGreaterThan(5);
  });

  it('reports no overruns when modules are within budget', () => {
    const withinBudgetManifest = `ADF: 0.1
DEFAULT_LOAD:
  - core.adf

ON_DEMAND:
  - frontend.adf (Triggers on: React) [budget: 99999]
`;
    const filesWithin: Record<string, string> = {
      '/ai/manifest.adf': withinBudgetManifest,
      '/ai/core.adf': `ADF: 0.1\nCONSTRAINTS:\n  - No secrets\n`,
      '/ai/frontend.adf': `ADF: 0.1\nCONSTRAINTS:\n  - Use React hooks\n`,
    };
    const read = (p: string): string => {
      const content = filesWithin[p];
      if (!content) throw new Error(`File not found: ${p}`);
      return content;
    };

    const result = bundleModules('/ai', ['core.adf', 'frontend.adf'], read);
    expect(result.moduleBudgetOverruns).toEqual([]);
  });

  it('only checks budget for modules that are actually loaded', () => {
    const partialManifest = `ADF: 0.1
DEFAULT_LOAD:
  - core.adf

ON_DEMAND:
  - frontend.adf (Triggers on: React) [budget: 1]
`;
    const filesPartial: Record<string, string> = {
      '/ai/manifest.adf': partialManifest,
      '/ai/core.adf': `ADF: 0.1\nCONSTRAINTS:\n  - No secrets\n`,
    };
    const read = (p: string): string => {
      const content = filesPartial[p];
      if (!content) throw new Error(`File not found: ${p}`);
      return content;
    };

    // frontend.adf not loaded, so no overrun even though budget is 1
    const result = bundleModules('/ai', ['core.adf'], read);
    expect(result.moduleBudgetOverruns).toEqual([]);
  });

  // --- Advisory-only module detection ---

  it('flags on-demand module with no load-bearing sections', () => {
    const files: Record<string, string> = {
      '/ai/manifest.adf': MANIFEST_ADF,
      '/ai/core.adf': `ADF: 0.1\nCONSTRAINTS [load-bearing]:\n  - No secrets\n`,
      '/ai/state.adf': `ADF: 0.1\nSTATE:\n  CURRENT: Working\n`,
      '/ai/frontend.adf': `ADF: 0.1\nCONTEXT [advisory]:\n  - Use React hooks\n`,
    };
    const read = (p: string): string => {
      const content = files[p];
      if (!content) throw new Error(`File not found: ${p}`);
      return content;
    };

    const result = bundleModules('/ai', ['core.adf', 'state.adf', 'frontend.adf'], read);
    expect(result.advisoryOnlyModules).toEqual(['frontend.adf']);
  });

  it('does not flag on-demand module with load-bearing section', () => {
    const files: Record<string, string> = {
      '/ai/manifest.adf': MANIFEST_ADF,
      '/ai/core.adf': `ADF: 0.1\nCONSTRAINTS:\n  - No secrets\n`,
      '/ai/state.adf': `ADF: 0.1\nSTATE:\n  CURRENT: Working\n`,
      '/ai/frontend.adf': `ADF: 0.1\nCONSTRAINTS [load-bearing]:\n  - Max 300 LOC\n`,
    };
    const read = (p: string): string => {
      const content = files[p];
      if (!content) throw new Error(`File not found: ${p}`);
      return content;
    };

    const result = bundleModules('/ai', ['core.adf', 'state.adf', 'frontend.adf'], read);
    expect(result.advisoryOnlyModules).toEqual([]);
  });

  it('does not flag default-load modules even without load-bearing', () => {
    const result = bundleModules('/ai', ['core.adf', 'state.adf'], readFile);
    // core.adf and state.adf are defaultLoad — never flagged
    expect(result.advisoryOnlyModules).toEqual([]);
  });

  it('flags on-demand module with no weight annotations', () => {
    const files: Record<string, string> = {
      '/ai/manifest.adf': MANIFEST_ADF,
      '/ai/core.adf': `ADF: 0.1\nCONSTRAINTS:\n  - No secrets\n`,
      '/ai/state.adf': `ADF: 0.1\nSTATE:\n  CURRENT: Working\n`,
      '/ai/frontend.adf': `ADF: 0.1\nCONTEXT:\n  - Use React hooks\n`,
    };
    const read = (p: string): string => {
      const content = files[p];
      if (!content) throw new Error(`File not found: ${p}`);
      return content;
    };

    const result = bundleModules('/ai', ['core.adf', 'state.adf', 'frontend.adf'], read);
    expect(result.advisoryOnlyModules).toEqual(['frontend.adf']);
  });

  it('reports multiple advisory-only modules', () => {
    const files: Record<string, string> = {
      '/ai/manifest.adf': MANIFEST_ADF,
      '/ai/core.adf': `ADF: 0.1\nCONSTRAINTS [load-bearing]:\n  - No secrets\n`,
      '/ai/state.adf': `ADF: 0.1\nSTATE:\n  CURRENT: Working\n`,
      '/ai/frontend.adf': `ADF: 0.1\nCONTEXT:\n  - Use React hooks\n`,
      '/ai/backend.adf': `ADF: 0.1\nCONTEXT:\n  - Use Express\n`,
    };
    const read = (p: string): string => {
      const content = files[p];
      if (!content) throw new Error(`File not found: ${p}`);
      return content;
    };

    const result = bundleModules('/ai', ['core.adf', 'state.adf', 'frontend.adf', 'backend.adf'], read);
    expect(result.advisoryOnlyModules).toEqual(['frontend.adf', 'backend.adf']);
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

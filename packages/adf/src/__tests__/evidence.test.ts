import { describe, it, expect } from 'vitest';
import { evaluateEvidence } from '../evidence';
import type { BundleResult } from '../types';

function makeBundleResult(overrides: Partial<BundleResult> = {}): BundleResult {
  return {
    manifest: {
      version: '0.1',
      defaultLoad: ['core.adf'],
      onDemand: [],
      rules: [],
      sync: [],
      cadence: [],
      metrics: [],
    },
    resolvedModules: ['core.adf'],
    mergedDocument: {
      version: '0.1',
      sections: [
        {
          key: 'CONSTRAINTS',
          decoration: null,
          content: { type: 'list', items: ['No secrets'] },
          weight: 'load-bearing',
        },
      ],
    },
    tokenEstimate: 50,
    tokenBudget: 4000,
    tokenUtilization: 0.0125,
    perModuleTokens: { 'core.adf': 50 },
    moduleBudgetOverruns: [],
    triggerMatches: [],
    unmatchedModules: [],
    advisoryOnlyModules: [],
    ...overrides,
  };
}

describe('evaluateEvidence', () => {
  it('forwards constraint results from validateConstraints', () => {
    const bundle = makeBundleResult({
      mergedDocument: {
        version: '0.1',
        sections: [
          {
            key: 'METRICS',
            decoration: null,
            content: {
              type: 'metric',
              entries: [{ key: 'loc', value: 100, ceiling: 200, unit: 'lines' }],
            },
            weight: 'load-bearing',
          },
        ],
      },
    });
    const report = evaluateEvidence(bundle, { loc: 150 });
    expect(report.constraints).toHaveLength(1);
    expect(report.constraints[0].status).toBe('pass');
    expect(report.constraints[0].value).toBe(150);
    expect(report.allPassing).toBe(true);
  });

  it('reports failing constraints', () => {
    const bundle = makeBundleResult({
      mergedDocument: {
        version: '0.1',
        sections: [
          {
            key: 'METRICS',
            decoration: null,
            content: {
              type: 'metric',
              entries: [{ key: 'loc', value: 100, ceiling: 200, unit: 'lines' }],
            },
          },
        ],
      },
    });
    const report = evaluateEvidence(bundle, { loc: 250 });
    expect(report.constraints[0].status).toBe('fail');
    expect(report.allPassing).toBe(false);
    expect(report.failCount).toBe(1);
  });

  it('reports warn status at ceiling boundary', () => {
    const bundle = makeBundleResult({
      mergedDocument: {
        version: '0.1',
        sections: [
          {
            key: 'METRICS',
            decoration: null,
            content: {
              type: 'metric',
              entries: [{ key: 'loc', value: 100, ceiling: 200, unit: 'lines' }],
            },
          },
        ],
      },
    });
    const report = evaluateEvidence(bundle, { loc: 200 });
    expect(report.constraints[0].status).toBe('warn');
    expect(report.warnCount).toBe(1);
  });

  it('forwards token data from bundle', () => {
    const bundle = makeBundleResult({
      tokenEstimate: 500,
      tokenBudget: 4000,
      tokenUtilization: 0.125,
      perModuleTokens: { 'core.adf': 300, 'frontend.adf': 200 },
    });
    const report = evaluateEvidence(bundle);
    expect(report.tokenEstimate).toBe(500);
    expect(report.tokenBudget).toBe(4000);
    expect(report.tokenUtilization).toBe(0.125);
    expect(report.perModuleTokens).toEqual({ 'core.adf': 300, 'frontend.adf': 200 });
  });

  it('forwards module budget overruns', () => {
    const overruns = [{ module: 'frontend.adf', tokens: 150, budget: 100 }];
    const bundle = makeBundleResult({ moduleBudgetOverruns: overruns });
    const report = evaluateEvidence(bundle);
    expect(report.moduleBudgetOverruns).toEqual(overruns);
  });

  it('forwards advisory-only modules', () => {
    const bundle = makeBundleResult({ advisoryOnlyModules: ['frontend.adf'] });
    const report = evaluateEvidence(bundle);
    expect(report.advisoryOnlyModules).toEqual(['frontend.adf']);
  });

  it('includes weight summary', () => {
    const report = evaluateEvidence(makeBundleResult());
    expect(report.weightSummary).toBeDefined();
    expect(report.weightSummary.total).toBeGreaterThan(0);
  });

  it('detects stale baselines when context drifts beyond threshold', () => {
    const bundle = makeBundleResult({
      mergedDocument: {
        version: '0.1',
        sections: [
          {
            key: 'METRICS',
            decoration: null,
            content: {
              type: 'metric',
              entries: [{ key: 'loc', value: 100, ceiling: 200, unit: 'lines' }],
            },
          },
        ],
      },
    });
    // current 150, baseline 100 → ratio 1.5 > default threshold 1.2
    const report = evaluateEvidence(bundle, { loc: 150 });
    expect(report.staleBaselines).toHaveLength(1);
    expect(report.staleBaselines[0].metric).toBe('loc');
    expect(report.staleBaselines[0].baseline).toBe(100);
    expect(report.staleBaselines[0].current).toBe(150);
    expect(report.staleBaselines[0].rationaleRequired).toBe(true);
  });

  it('respects custom stale threshold', () => {
    const bundle = makeBundleResult({
      mergedDocument: {
        version: '0.1',
        sections: [
          {
            key: 'METRICS',
            decoration: null,
            content: {
              type: 'metric',
              entries: [{ key: 'loc', value: 100, ceiling: 200, unit: 'lines' }],
            },
          },
        ],
      },
    });
    // ratio 1.5, threshold 2.0 → not stale
    const report = evaluateEvidence(bundle, { loc: 150 }, 2.0);
    expect(report.staleBaselines).toHaveLength(0);
  });

  it('returns empty stale baselines when no context provided', () => {
    const report = evaluateEvidence(makeBundleResult());
    expect(report.staleBaselines).toEqual([]);
  });
});

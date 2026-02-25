import { describe, it, expect } from 'vitest';
import { validateConstraints, computeWeightSummary } from '../validator';
import { parseAdf } from '../parser';
import type { AdfDocument } from '../types';

const DOC_ALL_PASSING = `ADF: 0.1
METRICS:
  entry_loc: 142 / 200 [lines]
  total_loc: 312 / 400 [lines]
`;

const DOC_ONE_FAIL = `ADF: 0.1
METRICS:
  entry_loc: 142 / 200 [lines]
  total_loc: 450 / 400 [lines]
`;

const DOC_AT_BOUNDARY = `ADF: 0.1
METRICS:
  entry_loc: 200 / 200 [lines]
`;

const DOC_NO_METRICS = `ADF: 0.1
CONSTRAINTS:
  - No secrets
  - Stay fast
`;

const DOC_MULTIPLE_METRIC_SECTIONS = `ADF: 0.1
METRICS:
  entry_loc: 142 / 200 [lines]
PERF [load-bearing]:
  p99_latency: 80 / 100 [ms]
`;

const DOC_MIXED_WEIGHTS = `ADF: 0.1
CONSTRAINTS [load-bearing]:
  - TypeScript strict mode
METRICS [advisory]:
  entry_loc: 142 / 200 [lines]
STATE:
  CURRENT: Working
CONTEXT:
  - Some context
`;

const DOC_DECIMAL = `ADF: 0.1
METRICS:
  coverage: 85 / 80 [pct]
`;

describe('validateConstraints', () => {
  it('all metrics within ceiling → allPassing true', () => {
    const doc = parseAdf(DOC_ALL_PASSING);
    const result = validateConstraints(doc);
    expect(result.allPassing).toBe(true);
    expect(result.failCount).toBe(0);
    expect(result.warnCount).toBe(0);
    expect(result.constraints).toHaveLength(2);
    expect(result.constraints[0].status).toBe('pass');
    expect(result.constraints[1].status).toBe('pass');
    expect(result.constraints[0].source).toBe('metric');
  });

  it('one metric breaches ceiling → allPassing false, failCount 1', () => {
    const doc = parseAdf(DOC_ONE_FAIL);
    const result = validateConstraints(doc);
    expect(result.allPassing).toBe(false);
    expect(result.failCount).toBe(1);
    const failed = result.constraints.find(c => c.status === 'fail');
    expect(failed).toBeDefined();
    expect(failed!.metric).toBe('total_loc');
    expect(failed!.value).toBe(450);
    expect(failed!.ceiling).toBe(400);
    expect(failed!.message).toContain('FAIL');
  });

  it('value equals ceiling → warn status, allPassing true', () => {
    const doc = parseAdf(DOC_AT_BOUNDARY);
    const result = validateConstraints(doc);
    expect(result.allPassing).toBe(true);
    expect(result.warnCount).toBe(1);
    expect(result.failCount).toBe(0);
    expect(result.constraints[0].status).toBe('warn');
    expect(result.constraints[0].message).toContain('WARN');
  });

  it('no metric sections → empty constraints, allPassing true', () => {
    const doc = parseAdf(DOC_NO_METRICS);
    const result = validateConstraints(doc);
    expect(result.constraints).toEqual([]);
    expect(result.allPassing).toBe(true);
    expect(result.failCount).toBe(0);
    expect(result.warnCount).toBe(0);
  });

  it('empty document → graceful handling', () => {
    const doc: AdfDocument = { version: '0.1', sections: [] };
    const result = validateConstraints(doc);
    expect(result.constraints).toEqual([]);
    expect(result.allPassing).toBe(true);
    expect(result.failCount).toBe(0);
    expect(result.warnCount).toBe(0);
    expect(result.weightSummary.total).toBe(0);
  });

  it('multiple metric sections → validates across all', () => {
    const doc = parseAdf(DOC_MULTIPLE_METRIC_SECTIONS);
    const result = validateConstraints(doc);
    expect(result.constraints).toHaveLength(2);
    expect(result.constraints[0].section).toBe('METRICS');
    expect(result.constraints[1].section).toBe('PERF');
    expect(result.allPassing).toBe(true);
  });

  it('context override: inject value that causes fail', () => {
    const doc = parseAdf(DOC_ALL_PASSING);
    const result = validateConstraints(doc, { entry_loc: 999 });
    expect(result.allPassing).toBe(false);
    expect(result.failCount).toBe(1);
    const overridden = result.constraints.find(c => c.metric === 'entry_loc');
    expect(overridden!.value).toBe(999);
    expect(overridden!.source).toBe('context');
    expect(overridden!.status).toBe('fail');
  });

  it('context override: turn existing fail into pass', () => {
    const doc = parseAdf(DOC_ONE_FAIL);
    const result = validateConstraints(doc, { total_loc: 350 });
    expect(result.allPassing).toBe(true);
    const overridden = result.constraints.find(c => c.metric === 'total_loc');
    expect(overridden!.value).toBe(350);
    expect(overridden!.source).toBe('context');
    expect(overridden!.status).toBe('pass');
  });

  it('context with unknown keys → ignored', () => {
    const doc = parseAdf(DOC_ALL_PASSING);
    const result = validateConstraints(doc, { nonexistent_metric: 999 });
    expect(result.constraints).toHaveLength(2);
    expect(result.constraints.every(c => c.source === 'metric')).toBe(true);
  });

  it('weight summary computed correctly in result', () => {
    const doc = parseAdf(DOC_MULTIPLE_METRIC_SECTIONS);
    const result = validateConstraints(doc);
    expect(result.weightSummary.loadBearing).toBe(1);
    expect(result.weightSummary.unweighted).toBe(1);
    expect(result.weightSummary.total).toBe(2);
  });

  it('decimal metric values handled', () => {
    const doc = parseAdf(DOC_DECIMAL);
    const result = validateConstraints(doc);
    expect(result.constraints).toHaveLength(1);
    expect(result.constraints[0].status).toBe('fail');
    expect(result.constraints[0].value).toBe(85);
    expect(result.constraints[0].ceiling).toBe(80);
  });

  it('message format includes metric key, values, unit, and status', () => {
    const doc = parseAdf(DOC_ALL_PASSING);
    const result = validateConstraints(doc);
    expect(result.constraints[0].message).toBe('entry_loc: 142 / 200 [lines] -- PASS');
  });
});

describe('computeWeightSummary', () => {
  it('mixed weights counted correctly', () => {
    const doc = parseAdf(DOC_MIXED_WEIGHTS);
    const summary = computeWeightSummary(doc);
    expect(summary.loadBearing).toBe(1);
    expect(summary.advisory).toBe(1);
    expect(summary.unweighted).toBe(2);
    expect(summary.total).toBe(4);
  });

  it('empty document → all zeros', () => {
    const doc: AdfDocument = { version: '0.1', sections: [] };
    const summary = computeWeightSummary(doc);
    expect(summary.loadBearing).toBe(0);
    expect(summary.advisory).toBe(0);
    expect(summary.unweighted).toBe(0);
    expect(summary.total).toBe(0);
  });

  it('all-unweighted document', () => {
    const doc = parseAdf(DOC_NO_METRICS);
    const summary = computeWeightSummary(doc);
    expect(summary.loadBearing).toBe(0);
    expect(summary.advisory).toBe(0);
    expect(summary.unweighted).toBe(1);
    expect(summary.total).toBe(1);
  });
});

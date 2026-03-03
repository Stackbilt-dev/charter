import { describe, it, expect } from 'vitest';
import { isKeywordMatch, buildTriggerReport } from '../manifest';
import type { Manifest } from '../types';

describe('isKeywordMatch', () => {
  it('matches exact keywords', () => {
    expect(isKeywordMatch('react', 'react')).toBe(true);
  });

  it('rejects different keywords', () => {
    expect(isKeywordMatch('react', 'vue')).toBe(false);
  });

  it('matches prefix stem when trigger is prefix of keyword', () => {
    // "react" (5 chars) is prefix of "reacting" (8 chars), ratio 5/8 = 0.625 < 0.66 → no match
    expect(isKeywordMatch('react', 'reacting')).toBe(false);
    // "node" (4 chars) is prefix of "nodes" (5 chars), ratio 4/5 = 0.80 >= 0.66 → match
    expect(isKeywordMatch('node', 'nodes')).toBe(true);
  });

  it('matches prefix stem when keyword is prefix of trigger', () => {
    // "data" (4 chars) is prefix of "database" (8 chars), ratio 4/8 = 0.50 < 0.66 → no match
    expect(isKeywordMatch('database', 'data')).toBe(false);
    // "api" (3 chars) — too short (<4), no prefix match
    expect(isKeywordMatch('apis', 'api')).toBe(false);
  });

  it('requires minimum 4 chars for prefix matching', () => {
    // "css" (3 chars) prefix of "cssx" — too short
    expect(isKeywordMatch('css', 'cssx')).toBe(false);
  });

  it('rejects when length ratio is below 66%', () => {
    // "test" (4 chars) prefix of "testing123" (10 chars), ratio 4/10 = 0.40 < 0.66
    expect(isKeywordMatch('test', 'testing123')).toBe(false);
  });
});

describe('buildTriggerReport', () => {
  const manifest: Manifest = {
    version: '0.1',
    defaultLoad: ['core.adf'],
    onDemand: [
      { path: 'frontend.adf', triggers: ['React', 'CSS'], loadPolicy: 'ON_DEMAND' },
      { path: 'backend.adf', triggers: ['API', 'Node'], loadPolicy: 'ON_DEMAND' },
    ],
    rules: [],
    sync: [],
    cadence: [],
    metrics: [],
  };

  it('reports matched triggers with keywords', () => {
    const report = buildTriggerReport(manifest, ['core.adf', 'frontend.adf'], ['React']);
    const reactEntry = report.find(r => r.trigger === 'React');
    expect(reactEntry).toBeDefined();
    expect(reactEntry!.matched).toBe(true);
    expect(reactEntry!.matchedKeywords).toEqual(['react']);
    expect(reactEntry!.loadReason).toBe('trigger');
  });

  it('reports unmatched triggers with empty keywords', () => {
    const report = buildTriggerReport(manifest, ['core.adf'], ['React']);
    const apiEntry = report.find(r => r.trigger === 'API');
    expect(apiEntry).toBeDefined();
    expect(apiEntry!.matched).toBe(false);
    expect(apiEntry!.matchedKeywords).toEqual([]);
  });

  it('includes all triggers from all on-demand modules', () => {
    const report = buildTriggerReport(manifest, ['core.adf'], []);
    expect(report).toHaveLength(4); // React, CSS, API, Node
  });
});

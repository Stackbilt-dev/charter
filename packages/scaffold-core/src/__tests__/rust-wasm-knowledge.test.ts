/**
 * rust-wasm-knowledge.test.ts — Rust/WASM governance knowledge module
 *
 * Verifies the decision and threat catalogs are non-empty and match the
 * published contract shape (RustWasmDecisionSchema / RustWasmThreatSchema).
 */

import { describe, it, expect } from 'vitest';
import { rustWasmDecisions, rustWasmThreats } from '../knowledge/index';

const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

describe('rust-wasm decisions', () => {
  const decisions = rustWasmDecisions();

  it('exports a non-empty array', () => {
    expect(Array.isArray(decisions)).toBe(true);
    expect(decisions.length).toBeGreaterThan(0);
  });

  it('each decision has required fields', () => {
    for (const d of decisions) {
      expect(typeof d.id).toBe('string');
      expect(d.id.length).toBeGreaterThan(0);
      expect(typeof d.title).toBe('string');
      expect(d.title.length).toBeGreaterThan(0);
      expect(typeof d.recommendation).toBe('string');
      expect(d.recommendation.length).toBeGreaterThan(0);
    }
  });

  it('decision ids are unique', () => {
    const ids = decisions.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('rust-wasm threats', () => {
  const threats = rustWasmThreats();

  it('exports a non-empty array', () => {
    expect(Array.isArray(threats)).toBe(true);
    expect(threats.length).toBeGreaterThan(0);
  });

  it('each threat has a valid severity', () => {
    for (const t of threats) {
      expect(SEVERITIES).toContain(t.severity);
    }
  });

  it('threat ids are unique', () => {
    const ids = threats.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

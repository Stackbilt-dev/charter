/**
 * Tests for the tiered execution contract (#201).
 *
 * Verifies that each TierDefinition constant is structurally complete:
 * - Every type value in the union appears in tiers[]
 * - Every tier has a non-empty description and constraint description
 * - mode is a valid value
 * - tiers[] contains no duplicates
 */

import { describe, it, expect } from 'vitest';
import type { TierDefinition } from '../index';
import {
  APP_MODE_TIERS,
  URGENCY_TIERS,
  COMPLEXITY_TIERS,
  CHANGE_CLASS_TIERS,
  COMMIT_RISK_TIERS,
} from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertTierDefinitionComplete<T extends string>(def: TierDefinition<T>): void {
  expect(def.name.length).toBeGreaterThan(0);
  expect(def.tiers.length).toBeGreaterThan(0);
  expect(['additive', 'absolute']).toContain(def.mode);

  // No duplicate tiers
  const unique = new Set(def.tiers);
  expect(unique.size).toBe(def.tiers.length);

  // Every tier has a description and a constraint description
  for (const tier of def.tiers) {
    expect(def.descriptions[tier]).toBeTruthy();
    expect(def.constraints[tier]).toBeDefined();
    expect(def.constraints[tier].description.length).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------
// Structural completeness
// ---------------------------------------------------------------------------

describe('APP_MODE_TIERS', () => {
  it('is structurally complete', () => assertTierDefinitionComplete(APP_MODE_TIERS));

  it('contains all AppMode values', () => {
    const values: string[] = ['GOVERNANCE', 'STRATEGY', 'DRAFTER', 'RED_TEAM', 'BRIEF'];
    for (const v of values) {
      expect(APP_MODE_TIERS.tiers).toContain(v);
    }
  });

  it('is absolute mode', () => expect(APP_MODE_TIERS.mode).toBe('absolute'));
});

describe('URGENCY_TIERS', () => {
  it('is structurally complete', () => assertTierDefinitionComplete(URGENCY_TIERS));

  it('contains all Urgency values in ascending severity order', () => {
    expect(URGENCY_TIERS.tiers).toEqual(['LOW', 'STANDARD', 'ELEVATED', 'CRITICAL']);
  });

  it('CRITICAL has the most restrictive constraint', () => {
    expect(URGENCY_TIERS.constraints.CRITICAL.description).toContain('escalation');
  });
});

describe('COMPLEXITY_TIERS', () => {
  it('is structurally complete', () => assertTierDefinitionComplete(COMPLEXITY_TIERS));

  it('contains all Complexity values in ascending severity order', () => {
    expect(COMPLEXITY_TIERS.tiers).toEqual(['TRIVIAL', 'SIMPLE', 'MODERATE', 'COMPLEX', 'EPIC']);
  });

  it('EPIC requires architecture review', () => {
    expect(COMPLEXITY_TIERS.constraints.EPIC.description).toContain('Architecture review');
  });
});

describe('CHANGE_CLASS_TIERS', () => {
  it('is structurally complete', () => assertTierDefinitionComplete(CHANGE_CLASS_TIERS));

  it('contains all ChangeClass values', () => {
    const values: string[] = ['SURFACE', 'LOCAL', 'CROSS_CUTTING'];
    for (const v of values) {
      expect(CHANGE_CLASS_TIERS.tiers).toContain(v);
    }
  });

  it('CROSS_CUTTING requires committee review', () => {
    expect(CHANGE_CLASS_TIERS.constraints.CROSS_CUTTING.description).toContain('Committee review');
  });
});

describe('COMMIT_RISK_TIERS', () => {
  it('is structurally complete', () => assertTierDefinitionComplete(COMMIT_RISK_TIERS));

  it('contains all CommitRiskLevel values in ascending severity order', () => {
    expect(COMMIT_RISK_TIERS.tiers).toEqual(['LOW', 'MEDIUM', 'HIGH']);
  });

  it('HIGH requires human review', () => {
    expect(COMMIT_RISK_TIERS.constraints.HIGH.description).toContain('human review');
  });

  it('LOW trailer is optional', () => {
    expect(COMMIT_RISK_TIERS.constraints.LOW.description).toContain('optional');
  });
});

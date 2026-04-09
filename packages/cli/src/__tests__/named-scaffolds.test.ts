import { describe, it, expect } from 'vitest';
import {
  NAMED_MODULE_SCAFFOLDS,
  NAMED_MODULE_DEFAULT_TRIGGERS,
  TYPED_DATA_ACCESS_SCAFFOLD,
} from '../commands/adf';

describe('NAMED_MODULE_SCAFFOLDS registry', () => {
  it('contains typed-data-access scaffold entry', () => {
    expect(NAMED_MODULE_SCAFFOLDS['typed-data-access']).toBeDefined();
    expect(NAMED_MODULE_SCAFFOLDS['typed-data-access']).toBe(TYPED_DATA_ACCESS_SCAFFOLD);
  });

  it('typed-data-access scaffold is valid ADF 0.1', () => {
    const scaffold = NAMED_MODULE_SCAFFOLDS['typed-data-access'];
    expect(scaffold).toMatch(/^ADF: 0\.1/);
  });

  it('typed-data-access scaffold declares the six sensitivity tiers', () => {
    const scaffold = NAMED_MODULE_SCAFFOLDS['typed-data-access'];
    expect(scaffold).toContain('public');
    expect(scaffold).toContain('service_internal');
    expect(scaffold).toContain('cross_service_rpc');
    expect(scaffold).toContain('pii_scoped');
    expect(scaffold).toContain('billing_critical');
    expect(scaffold).toContain('secrets');
  });

  it('typed-data-access scaffold references the canonical registry path', () => {
    const scaffold = NAMED_MODULE_SCAFFOLDS['typed-data-access'];
    expect(scaffold).toContain('stackbilt_llc/policies/data-registry.yaml');
  });

  it('typed-data-access scaffold includes load-bearing disambiguation constraint', () => {
    const scaffold = NAMED_MODULE_SCAFFOLDS['typed-data-access'];
    expect(scaffold).toMatch(/CONSTRAINTS \[load-bearing\]/);
    expect(scaffold).toContain('HALT and ask');
  });
});

describe('NAMED_MODULE_DEFAULT_TRIGGERS registry', () => {
  it('contains typed-data-access trigger keywords', () => {
    expect(NAMED_MODULE_DEFAULT_TRIGGERS['typed-data-access']).toBeDefined();
    expect(Array.isArray(NAMED_MODULE_DEFAULT_TRIGGERS['typed-data-access'])).toBe(true);
  });

  it('typed-data-access triggers include canonical business concept names', () => {
    const triggers = NAMED_MODULE_DEFAULT_TRIGGERS['typed-data-access'];
    expect(triggers).toContain('tenant');
    expect(triggers).toContain('user');
    expect(triggers).toContain('subscription');
    expect(triggers).toContain('quota');
  });

  it('typed-data-access triggers include sensitivity and policy keywords', () => {
    const triggers = NAMED_MODULE_DEFAULT_TRIGGERS['typed-data-access'];
    expect(triggers).toContain('sensitivity');
    expect(triggers).toContain('DATA_AUTHORITY');
    expect(triggers).toContain('disambiguation');
  });

  it('every named scaffold has default triggers registered', () => {
    for (const name of Object.keys(NAMED_MODULE_SCAFFOLDS)) {
      expect(NAMED_MODULE_DEFAULT_TRIGGERS[name]).toBeDefined();
      expect(NAMED_MODULE_DEFAULT_TRIGGERS[name].length).toBeGreaterThan(0);
    }
  });
});

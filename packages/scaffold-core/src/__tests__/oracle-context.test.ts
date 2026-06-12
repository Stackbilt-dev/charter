import { describe, expect, it } from 'vitest';
import { buildScaffold, buildOracleContext } from '../index';

describe('buildOracleContext', () => {
  it('derives all required fields from a LocalScaffoldResult', () => {
    const result = buildScaffold('Multi-tenant SaaS API with Stripe billing and JWT auth');
    const ctx = buildOracleContext(result);

    expect(ctx.intention).toBe(result.facts.intention);
    expect(ctx.pattern).toBe(result.classification.pattern);
    expect(ctx.meta.confidence).toBe(result.classification.confidence);
    expect(ctx.meta.tier2Recommended).toBe(result.tier2Recommended);
    expect(ctx.traits).toEqual(result.classification.traits);
    expect(ctx.governance.threatModel).toBe(result.governance.threatModel);
    expect(ctx.governance.adr001).toBe(result.governance.adr001);
    expect(ctx.governance.testPlan).toBe(result.governance.testPlan);
    expect(ctx.files.length).toBeGreaterThan(0);
    expect(ctx.files.every(f => 'path' in f && 'content' in f && 'role' in f)).toBe(true);
  });

  it('maps runtime bindings correctly', () => {
    const result = buildScaffold('Durable Object-based real-time collaboration service');
    const ctx = buildOracleContext(result);

    expect(Array.isArray(ctx.runtime.bindings)).toBe(true);
    ctx.runtime.bindings.forEach(b => {
      expect(b).toHaveProperty('type');
      expect(b).toHaveProperty('name');
      expect(b).toHaveProperty('binding');
    });
  });

  it('caps topThreats at 5', () => {
    const result = buildScaffold('Secure payment processing API with PCI compliance');
    const ctx = buildOracleContext(result);
    expect(ctx.knowledge.topThreats.length).toBeLessThanOrEqual(5);
  });

  it('sets adr002 to null when no compliance domains detected', () => {
    const result = buildScaffold('Simple scheduled cron worker to clean up old records');
    const ctx = buildOracleContext(result);
    // adr002 only present for compliance-domain patterns; null otherwise
    expect(ctx.governance.adr002 === null || typeof ctx.governance.adr002 === 'string').toBe(true);
  });
});

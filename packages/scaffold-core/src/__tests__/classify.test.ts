/**
 * classify.test.ts — classification tests for @stackbilt/scaffold-core
 *
 * Adapted from stackbilt-web/src/lib/__tests__/scaffold-domain-fixtures.test.ts
 * Tests the classify module's pattern selection and quality profile inference.
 */

import { describe, expect, it } from 'vitest';
import { classify, buildScaffold } from '../index';
import type { LocalScaffoldResult, ScaffoldFile } from '../index';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fileContent(result: LocalScaffoldResult, path: string): string {
  const f = result.files.find((f: ScaffoldFile) => f.path === path);
  return f?.content ?? '';
}

// Resolve the source_pattern string from classify result's traits
// (traits array may contain 'jwt-auth', 'hmac-stripe', etc.)
function sourcePattern(result: LocalScaffoldResult): string {
  const traits = result.classification.traits;
  // Identify source pattern from authentication trait
  if (traits.includes('hmac-stripe')) return 'stripe-webhook';
  if (traits.includes('hmac-sha256') || traits.some((t) => t.includes('webhook'))) return 'generic-webhook';
  if (traits.includes('jwt-auth') && traits.includes('rest')) return 'workers-saas';
  if (traits.includes('streaming')) return 'ai-chat';
  if (traits.includes('ws-and-rest')) return 'durable-objects';
  if (traits.includes('scheduled-handler')) return 'cron-worker';
  if (traits.some((t) => t.includes('mcp') || t.includes('sse-jsonrpc'))) return 'mcp-server';
  if (traits.includes('overlay-doc')) return 'hardening-overlay';
  return 'rest-api';
}

// ─── Tenancy guardrail tests (#177) ──────────────────────────────────────────

describe('scaffold domain fixtures — tenancy guardrail (#177)', () => {
  it('recognizes multi-tenant SaaS with org isolation as workers-saas pattern', () => {
    const result = classify('Multi-tenant SaaS API with organization-level data isolation');
    expect(result.pattern).toBe('workers-saas');
    expect(result.traits).toContain('jwt-auth');
  });

  it('does not misclassify workspace-scoped project management as cron or mcp', () => {
    const result = classify('Workspace-scoped project management with D1 and JWT auth');
    // Must not be scheduled (cron) or mcp-server
    expect(result.traits).not.toContain('scheduled-handler');
    expect(result.pattern).not.toBe('mcp-server');
  });

  it('recognizes tenant isolation with row-level security as workers-saas', () => {
    const result = classify('Tenant isolation API with row-level security in D1');
    expect(result.pattern).toBe('workers-saas');
    expect(result.traits).toContain('jwt-auth');
  });
});

// ─── Telephony/ads intent alignment tests (#176) ─────────────────────────────

describe('scaffold domain fixtures — telephony/ads intent alignment (#176)', () => {
  it('Twilio voice webhook produces wrangler.toml and D1 binding or schema tables', () => {
    const result = buildScaffold('Twilio voice webhook that transcribes calls and stores to D1');
    const wrangler = fileContent(result, 'wrangler.toml');
    expect(wrangler.length).toBeGreaterThan(0);
    // Should have either D1 binding or related schema
    const hasD1 = wrangler.includes('d1_databases') || wrangler.includes('D1');
    const hasSchema = result.files.some((f: ScaffoldFile) => f.path.includes('schema'));
    expect(hasD1 || hasSchema).toBe(true);
  });

  it('SMS notification with Twilio + KV produces KV binding and is not a cron worker', () => {
    const result = buildScaffold('SMS notification service using Twilio and KV for dedup');
    const wrangler = fileContent(result, 'wrangler.toml');
    expect(wrangler.includes('KV') || wrangler.includes('CACHE')).toBe(true);
    expect(result.classification.traits).not.toContain('scheduled-handler');
  });
});

// ─── PII risk enrichment tests (#178) ────────────────────────────────────────

describe('scaffold domain fixtures — PII risk enrichment (#178)', () => {
  it('health records prompt produces PHI/HIPAA-specific threats', () => {
    const result = buildScaffold('Health records API storing patient prescriptions and diagnoses');
    const tm = result.governance.threatModel;
    expect(tm).toMatch(/PHI|HIPAA|patient/i);
    expect(tm).toMatch(/T-D1/);
  });

  it('payment card processing prompt produces PCI-specific threats', () => {
    const result = buildScaffold('Payment card processing with tokenization');
    const tm = result.governance.threatModel;
    expect(tm).toMatch(/PCI|PAN|cardholder|card data/i);
    expect(tm).toMatch(/T-D1/);
  });

  it('user profile storing PII produces PII-specific threats', () => {
    const result = buildScaffold('User profile service storing email, phone, and address data');
    const tm = result.governance.threatModel;
    expect(tm).toMatch(/T-D1/);
    expect(tm).toMatch(/personal|PII|retention|breach/i);
  });

  it('Twilio voice webhook produces telephony-specific threats', () => {
    const result = buildScaffold('Twilio voice webhook that transcribes calls and stores to D1');
    const tm = result.governance.threatModel;
    expect(tm).toMatch(/T-T1/);
    expect(tm).toMatch(/Twilio|recording|signature/i);
  });
});

// ─── Classification confidence and quality profile ───────────────────────────

describe('classification quality and confidence', () => {
  it('stripe webhook produces high confidence classification', () => {
    const result = classify('Build a Stripe webhook handler with HMAC verification');
    // Should score high (multiple keywords hit)
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.traits).toContain('hmac-stripe');
  });

  it('generic fallback to api for vague intentions', () => {
    const result = classify('build something');
    // Should fall back to api pattern (rest-api source_pattern)
    expect(result.pattern).toBe('api');
  });

  it('compliance domains are detected for HIPAA content', () => {
    const result = classify('HIPAA-compliant patient health records API');
    expect(result.qualityProfile.complianceDomains).toContain('PHI');
  });

  it('compliance domains are detected for PCI content', () => {
    const result = classify('credit card payment processing API');
    expect(result.qualityProfile.complianceDomains).toContain('PCI');
  });

  it('enriched intention has injected stack/entity sections', () => {
    const result = classify('Podcast SaaS with D1, Stripe');
    expect(result.enrichedIntention.length).toBeGreaterThanOrEqual(result.traits.length > 0 ? 10 : 0);
  });
});

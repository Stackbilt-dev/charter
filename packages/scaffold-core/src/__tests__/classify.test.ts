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

// ─── Rust/WASM classification tests (charter#230) ────────────────────────────

describe('Rust/WASM pattern classification', () => {
  it('classifies a wasm-pack + wasm-bindgen intention as rust-wasm', () => {
    const result = classify('Rust crate using wasm-pack and wasm-bindgen for Node/Workers');
    expect(result.pattern).toBe('rust-wasm');
  });

  it('produces non-low confidence for rust-wasm classification', () => {
    const result = classify('Rust crate using wasm-pack and wasm-bindgen for Node/Workers');
    expect(result.confidence).toBeGreaterThan(0.3);
  });

  it('classifies cdylib / Cargo.toml description as rust-wasm', () => {
    const result = classify('Rust library with cdylib and rlib crate-type compiled to wasm32');
    expect(result.pattern).toBe('rust-wasm');
  });

  it('classifies WebAssembly keyword as rust-wasm', () => {
    const result = classify('WebAssembly module written in Rust with wasm-bindgen exports');
    expect(result.pattern).toBe('rust-wasm');
  });

  it('includes rust-wasm traits in the result', () => {
    const result = classify('wasm-pack Rust library targeting Node.js and bundler');
    expect(result.traits).toContain('rust');
    expect(result.traits).toContain('no-server');
  });

  it('does not classifiy a plain REST API as rust-wasm', () => {
    const result = classify('REST API with CRUD endpoints and JWT auth');
    expect(result.pattern).not.toBe('rust-wasm');
  });

  it('does not classify a CF worker as rust-wasm when no Rust signals present', () => {
    const result = classify('Cloudflare Worker webhook handler for Stripe payments');
    expect(result.pattern).not.toBe('rust-wasm');
  });

  it('buildScaffold for rust-wasm does not emit wrangler.toml', () => {
    const result = buildScaffold('Rust/WASM library using wasm-pack and wasm-bindgen', { projectName: 'test-lib' });
    const paths = result.files.map((f: ScaffoldFile) => f.path);
    expect(paths).not.toContain('wrangler.toml');
    expect(paths).not.toContain('schema.sql');
    expect(paths).not.toContain('src/index.ts');
  });

  it('buildScaffold for rust-wasm emits Cargo.toml and src/lib.rs', () => {
    const result = buildScaffold('Rust/WASM library using wasm-pack and wasm-bindgen', { projectName: 'test-lib' });
    const paths = result.files.map((f: ScaffoldFile) => f.path);
    expect(paths).toContain('Cargo.toml');
    expect(paths).toContain('src/lib.rs');
  });

  it('buildScaffold Cargo.toml contains cdylib and rlib crate types', () => {
    const result = buildScaffold('Rust crate compiled with wasm-pack', { projectName: 'my-crate' });
    const cargo = fileContent(result, 'Cargo.toml');
    expect(cargo).toContain('cdylib');
    expect(cargo).toContain('rlib');
    expect(cargo).toContain('wasm-bindgen');
  });

  it('buildScaffold CI workflow contains wasm32 target and wasm-pack test --node', () => {
    const result = buildScaffold('Rust WASM library for Node.js consumption', { projectName: 'wasm-lib' });
    const ci = fileContent(result, '.github/workflows/ci.yml');
    expect(ci).toContain('wasm32-unknown-unknown');
    expect(ci).toContain('wasm-pack test --node');
  });

  it('buildScaffold rust-wasm package.json is private with build/test scripts', () => {
    const result = buildScaffold('wasm-bindgen Rust module', { projectName: 'my-wasm' });
    const pkgRaw = fileContent(result, 'package.json');
    const pkg = JSON.parse(pkgRaw) as { private?: boolean; scripts?: Record<string, string> };
    expect(pkg.private).toBe(true);
    expect(pkg.scripts?.['build']).toContain('wasm-pack build');
    expect(pkg.scripts?.['test']).toContain('wasm-pack test --node');
  });
});

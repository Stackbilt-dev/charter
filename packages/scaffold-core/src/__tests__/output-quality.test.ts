/**
 * output-quality.test.ts — regression tests for the hero scaffold demo defects
 * (charter fix/scaffold-core-output-quality; see tarotscript#427, stackbilt-web#151)
 *
 * The stackbilder.com public hero demo calls buildScaffold() directly and ships the
 * result to every visitor. These tests lock in the fixes for:
 *   1. src/worker.ts always registers at least one real route (traitMap['default_routes']
 *      was being dropped between classify() and codegen, so worker.ts was always empty).
 *   2. No zero-byte files (`.ai/adr-002.md` was emitted empty via `governance.adr002 ?? ''`).
 *   3. Project name is derived from the intention and consistent across wrangler.toml,
 *      package.json, and the contract filename — no 'my-worker' / 'stackbilder-generated'
 *      / 'stackbilder-scaffold' placeholder remnants.
 *   4. Generated contract stubs never import '@stackbilt/contracts' (not published —
 *      that import broke `npm install` for every downloaded scaffold).
 */

import { describe, expect, it } from 'vitest';
import { buildScaffold, deriveProjectSlug } from '../index';
import type { LocalScaffoldResult, ScaffoldFile } from '../index';

function fileContent(result: LocalScaffoldResult, path: string): string {
  const f = result.files.find((f: ScaffoldFile) => f.path === path);
  return f?.content ?? '';
}

// A representative cross-section of patterns — including the exact hero-demo
// intention (SaaS billing dashboard) plus a Stripe webhook and a cron worker,
// which exercise the two source-pattern-specific codegen branches (webhook
// signature verification flavor, wrangler cron trigger) that were also silently
// broken by the same underlying bug.
const REPRESENTATIVE_INTENTIONS = [
  'SaaS billing dashboard with Stripe integration, user management, usage analytics',
  'Build a Stripe webhook handler with HMAC verification and event routing',
  'Nightly cron job that aggregates usage data daily',
];

describe('scaffold-core output quality — worker.ts route registration', () => {
  it.each(REPRESENTATIVE_INTENTIONS)('registers at least one route for: %s', (intention) => {
    const result = buildScaffold(intention);
    const worker = fileContent(result, 'src/worker.ts');
    expect(worker.length).toBeGreaterThan(0);
    const registeredRoutes = worker.match(/register\w+Route\(app\);/g) ?? [];
    expect(registeredRoutes.length).toBeGreaterThanOrEqual(1);
    // The unconditional service-metadata route is a defense-in-depth guarantee
    // independent of pattern-specific route registration.
    expect(worker).toMatch(/app\.get\("\/",/);
  });

  it('dispatches the Stripe-specific webhook handler for stripe-webhook, not generic HMAC', () => {
    const result = buildScaffold('Build a Stripe webhook handler with HMAC verification and event routing');
    const route = fileContent(result, 'src/routes/webhook.ts');
    expect(route).toContain('stripe-signature');
    expect(route).not.toContain('x-hub-signature');
  });

  it('dispatches the generic HMAC webhook handler for generic-webhook, not Stripe', () => {
    const result = buildScaffold('GitHub webhook handler with x-hub-signature verification');
    const route = fileContent(result, 'src/routes/webhook.ts');
    expect(route).toContain('x-hub-signature');
    expect(route).not.toContain('stripe-signature');
  });

  it('emits a [triggers] crons stanza in wrangler.toml for cron-worker scaffolds', () => {
    const result = buildScaffold('Nightly cron job that aggregates usage data daily');
    const wrangler = fileContent(result, 'wrangler.toml');
    expect(wrangler).toContain('[triggers]');
    const worker = fileContent(result, 'src/worker.ts');
    expect(worker).toContain('scheduled: handleScheduled');
  });
});

describe('scaffold-core output quality — no zero-byte files', () => {
  it.each(REPRESENTATIVE_INTENTIONS)('has no empty files for: %s', (intention) => {
    const result = buildScaffold(intention);
    const empty = result.files.filter((f: ScaffoldFile) => f.content.length === 0);
    expect(empty.map((f: ScaffoldFile) => f.path)).toEqual([]);
  });

  it('omits .ai/adr-002.md entirely when there are no compliance domains', () => {
    const result = buildScaffold('SaaS billing dashboard with Stripe integration, user management, usage analytics');
    expect(result.facts.qualityProfile.complianceDomains).toEqual([]);
    expect(result.files.some((f: ScaffoldFile) => f.path === '.ai/adr-002.md')).toBe(false);
  });

  it('emits a populated .ai/adr-002.md when compliance domains are present', () => {
    const result = buildScaffold('HIPAA-compliant patient health records API');
    const adr002 = result.files.find((f: ScaffoldFile) => f.path === '.ai/adr-002.md');
    expect(adr002).toBeDefined();
    expect(adr002!.content.length).toBeGreaterThan(0);
  });
});

describe('scaffold-core output quality — consistent project naming', () => {
  it.each(REPRESENTATIVE_INTENTIONS)('uses one consistent derived slug for: %s', (intention) => {
    const result = buildScaffold(intention);
    const expectedSlug = deriveProjectSlug(intention);
    expect(result.facts.projectName).toBe(expectedSlug);

    const wrangler = fileContent(result, 'wrangler.toml');
    expect(wrangler).toContain(`name = "${expectedSlug}"`);

    const pkg = JSON.parse(fileContent(result, 'package.json')) as { name: string };
    expect(pkg.name).toBe(expectedSlug);

    const contract = result.files.find((f: ScaffoldFile) => f.path.startsWith('src/contracts/'));
    expect(contract?.path).toBe(`src/contracts/${expectedSlug}.contract.ts`);

    // No placeholder remnants anywhere in the output.
    for (const f of result.files) {
      expect(f.content).not.toContain('my-worker');
      expect(f.content).not.toContain('stackbilder-generated');
      expect(f.content).not.toContain('stackbilder-scaffold');
    }
  });

  it('respects an explicit projectName option instead of deriving one', () => {
    const result = buildScaffold('Any old intention', { projectName: 'custom-name' });
    expect(result.facts.projectName).toBe('custom-name');
    expect(fileContent(result, 'wrangler.toml')).toContain('name = "custom-name"');
  });

  it('falls back to scaffold-app when the intention has no alphanumeric content', () => {
    expect(deriveProjectSlug('!!! ??? ---')).toBe('scaffold-app');
  });

  it('caps derived slugs at 40 characters', () => {
    const slug = deriveProjectSlug(
      'a'.repeat(100) + ' billing dashboard with a very long description of features',
    );
    expect(slug.length).toBeLessThanOrEqual(40);
  });
});

describe('scaffold-core output quality — no unpublished @stackbilt/contracts import', () => {
  it.each(REPRESENTATIVE_INTENTIONS)('never imports @stackbilt/contracts for: %s', (intention) => {
    const result = buildScaffold(intention);
    for (const f of result.files) {
      // A comment noting the future package (once published) is fine and expected —
      // what must never appear is an actual import/require of the unpublished package.
      expect(f.content).not.toMatch(/(?:import|require)\s*\(?[^\n]*['"]@stackbilt\/contracts['"]/);
    }
  });

  it('declares zod as a dependency whenever a contract stub is emitted', () => {
    const result = buildScaffold('SaaS billing dashboard with Stripe integration, user management, usage analytics');
    const hasContract = result.files.some((f: ScaffoldFile) => f.path.startsWith('src/contracts/'));
    expect(hasContract).toBe(true);
    const pkg = JSON.parse(fileContent(result, 'package.json')) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.zod).toBeDefined();
  });

  it('contract stub is plain-object Zod, not a defineContract() call', () => {
    const result = buildScaffold('SaaS billing dashboard with Stripe integration, user management, usage analytics');
    const contract = result.files.find((f: ScaffoldFile) => f.path.startsWith('src/contracts/'));
    expect(contract).toBeDefined();
    expect(contract!.content).toContain("import { z } from 'zod';");
    // "defineContract" may appear in an explanatory TODO comment (future package),
    // but must never be invoked as a function call.
    expect(contract!.content).not.toMatch(/defineContract\(/);
  });
});

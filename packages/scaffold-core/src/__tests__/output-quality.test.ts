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
 *   4. Every module imported by a generated file is declared in the generated
 *      package.json. `@stackbilt/contracts` IS published (0.8.0) — the original
 *      "unpublished package" premise from tarotscript#427 was stale — so the fix is
 *      NOT to drop the import. The real defect: the contract stub imports `zod` and
 *      `@stackbilt/contracts`, but the base package.json (generated before the
 *      contract file exists) only declared `hono`, so a downloaded scaffold survived
 *      `npm install` and then failed typecheck/build with missing modules.
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

// Extracts the bare package name(s) referenced by import/export-from/require
// specifiers in a source file, excluding relative paths and node: builtins.
// Scoped packages (@scope/name) are returned as the full "@scope/name" —
// everything after that is a subpath import of the same package.
function importedPackageNames(content: string): string[] {
  const specifiers = new Set<string>();
  const fromRe = /(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [fromRe, requireRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) specifiers.add(m[1]!);
  }

  const packages: string[] = [];
  for (const spec of specifiers) {
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
    const parts = spec.split('/');
    packages.push(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!);
  }
  return packages;
}

describe('scaffold-core output quality — every generated import is a declared dependency', () => {
  // Class-invariant check: whatever a generated .ts file imports, the generated
  // package.json must declare (deps or devDeps) — otherwise the scaffold survives
  // `npm install` and only fails later at typecheck/build. Covers the whole defect
  // family (today's zod/@stackbilt/contracts gap, and any future one), not just the
  // specific package that was missing when this test was written.
  const PATTERN_SWEEP = [
    ...REPRESENTATIVE_INTENTIONS,
    'MCP tool server exposing agent tools via SSE',
    'Real-time collaborative editor using durable objects and websockets',
    'Chatbot API using LLM streaming responses',
    'Multi-tenant SaaS API with organization-level data isolation',
    'GitHub webhook handler with x-hub-signature verification',
  ];

  it.each(PATTERN_SWEEP)('has no undeclared imports for: %s', (intention) => {
    const result = buildScaffold(intention);
    const pkgFile = result.files.find((f: ScaffoldFile) => f.path === 'package.json');
    expect(pkgFile).toBeDefined();
    const pkg = JSON.parse(pkgFile!.content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);

    const undeclared: string[] = [];
    for (const f of result.files) {
      if (!f.path.endsWith('.ts')) continue;
      for (const pkgName of importedPackageNames(f.content)) {
        if (!declared.has(pkgName)) undeclared.push(`${f.path} -> ${pkgName}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('contract stub imports @stackbilt/contracts (published — do not strip this)', () => {
    const result = buildScaffold('SaaS billing dashboard with Stripe integration, user management, usage analytics');
    const contract = result.files.find((f: ScaffoldFile) => f.path.startsWith('src/contracts/'));
    expect(contract).toBeDefined();
    expect(contract!.content).toContain("import { z } from 'zod';");
    expect(contract!.content).toContain("import { defineContract } from '@stackbilt/contracts';");
  });

  it('declares both zod and @stackbilt/contracts whenever a contract stub is emitted', () => {
    const result = buildScaffold('SaaS billing dashboard with Stripe integration, user management, usage analytics');
    const hasContract = result.files.some((f: ScaffoldFile) => f.path.startsWith('src/contracts/'));
    expect(hasContract).toBe(true);
    const pkg = JSON.parse(fileContent(result, 'package.json')) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.zod).toBeDefined();
    expect(pkg.dependencies?.['@stackbilt/contracts']).toBeDefined();
  });

  it('never injects the unpublished @stackbilt/worker-observability package', () => {
    // Regression guard for the disabled FIRST_PARTY_DEPS entry in materializer/project.ts —
    // that package 404s on the npm registry (same defect class as the tarotscript twin).
    for (const intention of PATTERN_SWEEP) {
      const result = buildScaffold(intention);
      for (const f of result.files) {
        expect(f.content).not.toContain('@stackbilt/worker-observability');
      }
    }
  });
});

/**
 * codegen/files — baseFiles
 *
 * Generates the base set of files common to all scaffold patterns.
 * Extracted from stackbilt-web/src/lib/scaffold-core.ts.
 */

import type { ScaffoldFacts, ScaffoldFile } from '../types';
import { generateWranglerBindings } from './wrangler';
import { routeToFile, registerFnName, routeContent } from './routes';

// ─── Schema by pattern ────────────────────────────────────────────────────────

const SCHEMA_BY_PATTERN: Record<string, string> = {
  'workers-saas': [
    '-- workers-saas baseline schema',
    'CREATE TABLE IF NOT EXISTS tenants (',
    '  id TEXT PRIMARY KEY,',
    '  name TEXT NOT NULL,',
    '  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS users (',
    '  id TEXT PRIMARY KEY,',
    '  tenant_id TEXT NOT NULL REFERENCES tenants(id),',
    '  email TEXT NOT NULL,',
    '  role TEXT NOT NULL DEFAULT \'member\',',
    '  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '  UNIQUE(tenant_id, email)',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);',
    '',
    'CREATE TABLE IF NOT EXISTS audit_events (',
    '  id TEXT PRIMARY KEY,',
    '  tenant_id TEXT NOT NULL REFERENCES tenants(id),',
    '  actor_user_id TEXT,',
    '  event_type TEXT NOT NULL,',
    '  payload TEXT,',
    '  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_events(tenant_id, created_at);',
  ].join('\n'),
  'stripe-webhook': [
    '-- stripe-webhook baseline schema',
    'CREATE TABLE IF NOT EXISTS processed_events (',
    '  id TEXT PRIMARY KEY,',
    '  event_type TEXT NOT NULL,',
    '  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '  processed_at TEXT',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_processed_received ON processed_events(received_at);',
    '',
    'CREATE TABLE IF NOT EXISTS billing_audit (',
    '  id TEXT PRIMARY KEY,',
    '  stripe_event_id TEXT NOT NULL REFERENCES processed_events(id),',
    '  customer_id TEXT,',
    '  amount_cents INTEGER,',
    '  currency TEXT,',
    '  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ');',
  ].join('\n'),
  'generic-webhook': [
    '-- generic-webhook baseline schema',
    'CREATE TABLE IF NOT EXISTS processed_events (',
    '  id TEXT PRIMARY KEY,',
    '  provider TEXT NOT NULL,',
    '  event_type TEXT NOT NULL,',
    '  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ');',
  ].join('\n'),
  'ai-chat': [
    '-- ai-chat baseline schema',
    'CREATE TABLE IF NOT EXISTS sessions (',
    '  id TEXT PRIMARY KEY,',
    '  user_id TEXT NOT NULL,',
    '  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '  last_active_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS messages (',
    '  id TEXT PRIMARY KEY,',
    '  session_id TEXT NOT NULL REFERENCES sessions(id),',
    '  role TEXT NOT NULL,',
    '  content TEXT NOT NULL,',
    '  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);',
  ].join('\n'),
  'durable-objects': [
    '-- durable-objects baseline schema (rooms metadata; per-room state lives in DO storage)',
    'CREATE TABLE IF NOT EXISTS rooms (',
    '  id TEXT PRIMARY KEY,',
    '  owner_id TEXT NOT NULL,',
    '  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '  last_active_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_rooms_owner ON rooms(owner_id);',
  ].join('\n'),
  'cron-worker': [
    '-- cron-worker baseline schema (processed cursor + run log)',
    'CREATE TABLE IF NOT EXISTS cron_cursor (',
    '  job_name TEXT PRIMARY KEY,',
    '  last_processed_id TEXT,',
    '  last_processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS cron_runs (',
    '  id TEXT PRIMARY KEY,',
    '  job_name TEXT NOT NULL,',
    '  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '  finished_at TEXT,',
    '  rows_processed INTEGER DEFAULT 0,',
    '  status TEXT NOT NULL DEFAULT \'running\'',
    ');',
  ].join('\n'),
  'rest-api': [
    '-- rest-api baseline schema',
    'CREATE TABLE IF NOT EXISTS resources (',
    '  id TEXT PRIMARY KEY,',
    '  name TEXT NOT NULL,',
    '  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ');',
  ].join('\n'),
};

// ─── Index file generator ─────────────────────────────────────────────────────

function generateIndexFile(routes: string[], pattern: string): string {
  const routeImports = routes
    .map((route) => {
      const moduleName = routeToFile(route).replace('src/', './').replace(/\.ts$/, '');
      return `import { ${registerFnName(route)} } from "${moduleName}";`;
    })
    .join('\n');

  const registrations = routes.map((route) => `  ${registerFnName(route)}(app);`).join('\n');

  let content = [
    'import { Hono } from "hono";',
    'import type { Env } from "./types/env";',
    'import { HttpError } from "./lib/http-error";',
    routeImports,
    '',
    'const app = new Hono<{ Bindings: Env }>();',
    '',
    registrations,
    '',
    'app.onError((err, c) => {',
    '  if (err instanceof HttpError) {',
    '    return c.json({ error: err.message }, err.status);',
    '  }',
    '  console.error(err);',
    '  return c.json({ error: "internal_error" }, 500);',
    '});',
    '',
    'export default app;',
    '',
  ].join('\n');

  if (pattern === 'cron-worker') {
    content = content.replace(
      'export default app;',
      [
        'async function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {',
        '  // Idempotent aggregation tick. Keep work bounded by a row limit and a cursor.',
        '  ctx.waitUntil((async () => {',
        '    try {',
        '      console.log(JSON.stringify({ kind: "cron_tick", scheduledTime: event.scheduledTime }));',
        '      // TODO: read cursor → process bounded batch → advance cursor',
        '    } catch (err) {',
        '      console.error(JSON.stringify({ kind: "cron_error", error: String(err) }));',
        '    }',
        '  })());',
        '}',
        '',
        'export default {',
        '  fetch: app.fetch,',
        '  scheduled: handleScheduled,',
        '};',
      ].join('\n'),
    );
  }

  return content;
}

// ─── Rust/WASM base files ─────────────────────────────────────────────────────

function rustWasmBaseFiles(facts: ScaffoldFacts): ScaffoldFile[] {
  const slug = facts.projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-wasm-lib';
  const fnName = slug.replace(/-/g, '_');

  return [
    {
      path: 'Cargo.toml',
      role: 'config',
      content: `[package]
name = "${slug}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"

[dev-dependencies]
wasm-bindgen-test = "0.3"
`,
    },
    {
      path: 'src/lib.rs',
      role: 'entry',
      content: `use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn greet(name: &str) -> String {
    format!("Hello from ${fnName}, {}!", name)
}
`,
    },
    {
      path: 'tests/integration.rs',
      role: 'test',
      content: `use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_node_experimental);

#[wasm_bindgen_test]
fn test_greet() {
    let result = ${fnName}::greet("world");
    assert!(result.contains("world"));
}
`,
    },
    {
      path: 'package.json',
      role: 'config',
      content: JSON.stringify({
        name: slug,
        version: '0.1.0',
        private: true,
        scripts: {
          build: 'wasm-pack build --target bundler --out-dir pkg',
          'build:node': 'wasm-pack build --target nodejs --out-dir pkg-node',
          test: 'cargo test && wasm-pack test --node',
        },
        devDependencies: {
          'wasm-pack': '^0.13.0',
        },
      }, null, 2),
    },
    {
      path: '.gitignore',
      role: 'config',
      content: `/target
/pkg
/pkg-node
`,
    },
    {
      path: '.github/workflows/ci.yml',
      role: 'test',
      content: `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32-unknown-unknown
      - uses: Swatinem/rust-cache@v2
      - name: Install wasm-pack
        run: curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
      - name: Cargo tests
        run: cargo test
      - name: WASM node tests
        run: wasm-pack test --node
      - name: WASM build
        run: wasm-pack build --target bundler --out-dir pkg
`,
    },
    {
      path: 'README.md',
      role: 'readme',
      content: `# ${facts.projectName}

${facts.intention}

## Requirements

- [Rust](https://rustup.rs/) stable
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)

## Development

\`\`\`bash
npm test          # cargo test + wasm-pack test --node
npm run build     # wasm-pack build --target bundler --out-dir pkg
\`\`\`

## Publishing

The publishable artifact is \`pkg/\` (generated by wasm-pack). Do not publish the root package.

\`\`\`bash
npm run build
cd pkg && npm publish
\`\`\`
`,
    },
  ];
}

/**
 * Generate the base set of ScaffoldFiles for the given facts.
 *
 * Returns all non-route files: wrangler.toml, package.json, tsconfig.json,
 * src/worker.ts, src/types/env.ts, middleware, lib, tests, and governance docs.
 *
 * Route files are generated separately by buildRoutes().
 */
export function baseFiles(facts: ScaffoldFacts): ScaffoldFile[] {
  const pattern = facts.pattern as string;

  // Rust/WASM library: completely different file set — no CF Worker infrastructure.
  if (pattern === 'rust-wasm') {
    return rustWasmBaseFiles(facts);
  }
  const bindings = facts.bindings;
  const qp = facts.qualityProfile;
  const intention = facts.intention;

  // Extract traits map
  const traitsMap: Record<string, string> = {};
  for (const t of facts.traits) {
    const idx = t.indexOf(':');
    if (idx > 0) {
      traitsMap[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
  }

  const routes = (traitsMap['default_routes'] ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

  const bindingTypes = bindings.map((b) => b.type.toLowerCase());
  const hasD1 = bindingTypes.includes('d1');
  const hasKv = bindingTypes.includes('kv');
  const hasR2 = bindingTypes.includes('r2');
  const hasDo = bindingTypes.includes('do');
  const hasAi = bindingTypes.includes('ai');

  const profile = {
    needsTenancy: pattern === 'workers-saas' || qp.piiHandling,
    needsPayments: pattern === 'stripe-webhook',
    needsStreaming: pattern === 'ai-chat',
    needsStorage: hasR2,
    needsJwt: qp.authentication && intention.toLowerCase().includes('jwt'),
    needsOAuth: intention.toLowerCase().includes('oauth'),
    needsRateLimit: qp.rateLimiting,
  };

  const files: ScaffoldFile[] = [
    {
      path: 'wrangler.toml',
      role: 'config',
      content: [
        'name = "stackbilder-generated"',
        'main = "src/worker.ts"',
        'compatibility_date = "2026-05-24"',
        '',
        generateWranglerBindings(bindings, pattern),
      ].join('\n'),
    },
    {
      path: 'package.json',
      role: 'config',
      content: JSON.stringify(
        {
          name: 'stackbilder-scaffold',
          private: true,
          type: 'module',
          scripts: {
            dev: 'wrangler dev',
            deploy: 'wrangler deploy',
            test: 'vitest run',
            typecheck: 'tsc --noEmit',
          },
          dependencies: {
            hono: '^4.9.0',
            ...(pattern === 'mcp-server' ? { '@modelcontextprotocol/sdk': '^1.0.0' } : {}),
          },
          devDependencies: {
            '@cloudflare/workers-types': '^4.20260405.1',
            typescript: '^5.8.0',
            vitest: '^4.1.4',
            wrangler: '^4.80.0',
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'tsconfig.json',
      role: 'config',
      content: JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            types: ['@cloudflare/workers-types', 'vitest/globals'],
          },
          include: ['src', 'tests'],
        },
        null,
        2,
      ),
    },
    {
      path: '.github/workflows/ci.yml',
      role: 'test',
      content: [
        'name: ci',
        '',
        'on:',
        '  pull_request:',
        '  push:',
        '    branches: [main]',
        '',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 22',
        '      - run: npm ci',
        '      - run: npm run test',
        '      - run: npm run typecheck',
      ].join('\n'),
    },
    {
      path: 'README.md',
      role: 'readme',
      content: [
        '# Stackbilder Scaffold',
        '',
        `Generated from intention: ${intention}`,
        '',
        '## Quality Gates',
        '1. npm install',
        '2. npm run test',
        '3. npm run typecheck',
        '4. npm run deploy',
        '',
      ].join('\n'),
    },
    {
      path: 'src/worker.ts',
      role: 'entry',
      content: generateIndexFile(routes, pattern),
    },
    {
      path: 'src/types/env.ts',
      role: 'entry',
      content: [
        'export interface Env {',
        ...(hasD1 ? ['  DB: D1Database;'] : []),
        ...(hasKv ? ['  CACHE: KVNamespace;'] : []),
        ...(hasR2 ? ['  ASSETS: R2Bucket;'] : []),
        ...(hasDo ? ['  ROOM: DurableObjectNamespace;'] : []),
        ...(hasAi ? ['  AI: Ai;'] : []),
        '  AUTH_BEARER_TOKEN?: string;',
        '  STRIPE_WEBHOOK_SECRET?: string;',
        ...(pattern === 'generic-webhook'
          ? ['  WEBHOOK_SECRET?: string;', '  WEBHOOK_SIGNATURE_HEADER?: string;']
          : []),
        ...(profile.needsJwt ? ['  JWT_SECRET?: string;'] : []),
        ...(profile.needsOAuth
          ? [
              '  OAUTH_CLIENT_ID?: string;',
              '  OAUTH_CLIENT_SECRET?: string;',
              '  OAUTH_AUTHORIZE_URL?: string;',
            ]
          : []),
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/lib/http-error.ts',
      role: 'entry',
      content: [
        'export class HttpError extends Error {',
        '  status: number;',
        '',
        '  constructor(status: number, message: string) {',
        '    super(message);',
        '    this.status = status;',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/middleware/auth.ts',
      role: 'entry',
      content: [
        'import type { Context } from "hono";',
        'import { HttpError } from "../lib/http-error";',
        '',
        'export async function requireBearerAuth(c: Context): Promise<void> {',
        '  const auth = c.req.header("authorization") ?? "";',
        '  if (!auth.startsWith("Bearer ")) throw new HttpError(401, "missing bearer token");',
        '  const token = auth.slice(7).trim();',
        '  if (!token) throw new HttpError(401, "empty bearer token");',
        '',
        '  const expected = c.env.AUTH_BEARER_TOKEN;',
        '  if (expected && token !== expected) throw new HttpError(403, "invalid bearer token");',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/middleware/tenant.ts',
      role: 'entry',
      content: [
        'import type { Context } from "hono";',
        'import { HttpError } from "../lib/http-error";',
        '',
        'export function requireTenant(c: Context): string {',
        '  const tenantId = c.req.header("x-tenant-id")?.trim();',
        '  if (!tenantId) throw new HttpError(400, "missing x-tenant-id");',
        '  return tenantId;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/lib/security.ts',
      role: 'entry',
      content: [
        'export function sanitizeIdentifier(input: string): string {',
        '  return input.toLowerCase().replace(/[^a-z0-9_-]/g, "");',
        '}',
        '',
        'export function isLikelySecret(value: string): boolean {',
        '  return /sk_live|secret|token|apikey/i.test(value);',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'tests/security.test.ts',
      role: 'test',
      content: [
        'import { describe, expect, it } from "vitest";',
        'import { isLikelySecret, sanitizeIdentifier } from "../src/lib/security";',
        '',
        'describe("security helpers", () => {',
        '  it("normalizes identifiers", () => {',
        '    expect(sanitizeIdentifier("Acme Org #1")).toBe("acmeorg1");',
        '  });',
        '',
        '  it("detects likely secrets", () => {',
        '    expect(isLikelySecret("sk_live_abc123")).toBe(true);',
        '    expect(isLikelySecret("public-name")).toBe(false);',
        '  });',
        '});',
        '',
      ].join('\n'),
    },
  ];

  // D1 schema and migration
  if (hasD1) {
    const schema = SCHEMA_BY_PATTERN[pattern] ?? SCHEMA_BY_PATTERN['rest-api']!;
    files.push({ path: 'src/db/schema.sql', role: 'migration', content: schema + '\n' });
    files.push({ path: 'migrations/0001_initial.sql', role: 'migration', content: schema + '\n' });
  }

  // KV helper
  if (hasKv) {
    files.push({
      path: 'src/lib/kv.ts',
      role: 'entry',
      content: 'export function cacheKey(key: string) { return `cache:${key}`; }\n',
    });
  }

  // R2 storage helper
  if (profile.needsStorage || hasR2) {
    files.push({
      path: 'src/lib/storage.ts',
      role: 'entry',
      content: 'export const bucketName = "ASSETS";\n',
    });
  }

  // Durable Object stub
  if (pattern === 'durable-objects' || hasDo) {
    files.push({
      path: 'src/objects/room.ts',
      role: 'entry',
      content: [
        'export class RoomDO {',
        '  state: DurableObjectState;',
        '  sessions: Set<WebSocket> = new Set();',
        '',
        '  constructor(state: DurableObjectState) {',
        '    this.state = state;',
        '  }',
        '',
        '  async fetch(request: Request): Promise<Response> {',
        '    const upgrade = request.headers.get("upgrade");',
        '    if (upgrade !== "websocket") {',
        '      return new Response("expected websocket", { status: 426 });',
        '    }',
        '    const pair = new WebSocketPair();',
        '    const client = pair[0];',
        '    const server = pair[1];',
        '    server.accept();',
        '    this.sessions.add(server);',
        '    server.addEventListener("message", (ev) => {',
        '      const data = typeof ev.data === "string" ? ev.data : "";',
        '      if (data.length > 16_384) return;',
        '      for (const peer of this.sessions) {',
        '        if (peer !== server && peer.readyState === WebSocket.OPEN) peer.send(data);',
        '      }',
        '    });',
        '    server.addEventListener("close", () => this.sessions.delete(server));',
        '    return new Response(null, { status: 101, webSocket: client });',
        '  }',
        '}',
        '',
      ].join('\n'),
    });
  }

  // JWT middleware
  if (profile.needsJwt) {
    files.push({
      path: 'src/middleware/jwt.ts',
      role: 'entry',
      content: [
        'import type { Context } from "hono";',
        'import { HttpError } from "../lib/http-error";',
        '',
        'function base64UrlDecode(input: string): Uint8Array {',
        '  const pad = input.length % 4 === 0 ? 0 : 4 - (input.length % 4);',
        '  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);',
        '  const bin = atob(b64);',
        '  const out = new Uint8Array(bin.length);',
        '  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);',
        '  return out;',
        '}',
        '',
        'export async function verifyJwtHS256(token: string, secret: string): Promise<Record<string, unknown>> {',
        '  const parts = token.split(".");',
        '  if (parts.length !== 3) throw new HttpError(401, "malformed jwt");',
        '  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];',
        '  const enc = new TextEncoder();',
        '  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);',
        '  const ok = await crypto.subtle.verify("HMAC", key, base64UrlDecode(sigB64), enc.encode(`${headerB64}.${payloadB64}`));',
        '  if (!ok) throw new HttpError(401, "invalid jwt signature");',
        '  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as Record<string, unknown>;',
        '  const exp = typeof payload.exp === "number" ? payload.exp : 0;',
        '  if (exp && exp * 1000 < Date.now()) throw new HttpError(401, "jwt expired");',
        '  return payload;',
        '}',
        '',
        'export async function requireJwt(c: Context): Promise<Record<string, unknown>> {',
        '  const auth = c.req.header("authorization") ?? "";',
        '  if (!auth.startsWith("Bearer ")) throw new HttpError(401, "missing bearer token");',
        '  const secret = c.env.JWT_SECRET;',
        '  if (!secret) throw new HttpError(500, "JWT_SECRET not configured");',
        '  return verifyJwtHS256(auth.slice(7).trim(), secret);',
        '}',
        '',
      ].join('\n'),
    });
  }

  // Rate limiter middleware
  if (profile.needsRateLimit) {
    files.push({
      path: 'src/middleware/rate-limit.ts',
      role: 'entry',
      content: [
        'import type { Context } from "hono";',
        'import { HttpError } from "../lib/http-error";',
        '',
        '// Simple fixed-window rate limiter backed by KV. Resolution is 60s.',
        'export async function rateLimit(c: Context, opts: { key: string; limit: number; windowSeconds?: number }): Promise<void> {',
        '  const window = opts.windowSeconds ?? 60;',
        '  const bucket = Math.floor(Date.now() / 1000 / window);',
        '  const key = `rl:${opts.key}:${bucket}`;',
        '  const current = Number((await c.env.CACHE.get(key)) ?? "0");',
        '  if (current >= opts.limit) {',
        '    const reset = (bucket + 1) * window - Math.floor(Date.now() / 1000);',
        '    c.header("Retry-After", String(reset));',
        '    throw new HttpError(429, "rate limit exceeded");',
        '  }',
        '  await c.env.CACHE.put(key, String(current + 1), { expirationTtl: window + 5 });',
        '}',
        '',
      ].join('\n'),
    });
  }

  // Hardening overlay
  if (pattern === 'hardening-overlay') {
    files.push({
      path: '.ai/hardening-checklist.md',
      role: 'adf',
      content: [
        '# Hardening Checklist for AI-Generated Stack',
        '',
        `Source intention: ${intention}`,
        '',
        'This checklist enumerates the four most common failure modes that ship with AI-generated apps (Lovable, Bolt, Cursor, v0, Supabase). Local scaffolding cannot read your existing code — every item is a control the operator must verify.',
        '',
        '## 1. Exposed credentials',
        '- [ ] No service-role / secret keys committed to the repo (`git grep -E \'sk_live|service_role|supabase_secret\'`).',
        '- [ ] `.env`, `.env.local`, `.env.production` listed in `.gitignore` and never committed.',
        '- [ ] Public anon keys (Supabase, Firebase) confirmed safe to expose — and row-level security is enforced.',
        '',
        '## 2. Data-access surface',
        '- [ ] Row-Level Security (RLS) enabled on every Supabase / Postgres table referenced by the client.',
        '- [ ] No direct client-to-database fetch for privileged reads/writes — route through an edge gateway.',
        '- [ ] All write paths validate input schemas server-side, not only in client forms.',
        '',
        '## 3. Form and CSRF posture',
        '- [ ] State-changing POST routes require a CSRF token or use SameSite=Lax/Strict cookies.',
        '- [ ] Generator-emitted forms verified to include CSRF defense (Bolt/Lovable often skip this).',
        '- [ ] File-upload endpoints validate MIME type, size, and store outside the executable root.',
        '',
        '## 4. AI-endpoint abuse controls',
        '- [ ] Per-user rate limits on any LLM-backed endpoint (token budget + request count).',
        '- [ ] Provider API keys held server-side only — never exposed in client bundles.',
        '- [ ] System prompts include explicit instructions not to reveal configuration.',
        '',
        '## Tier-2 handoff',
        'This checklist surfaces the controls — verifying they actually landed in your codebase requires a code audit. Book a Stackbilt managed-consult to complete the hardening cycle.',
        '',
      ].join('\n'),
    });
  }

  // Governance docs as files (using fact-level governance if available)
  // Note: governance files are added by the orchestrator in index.ts

  return files;
}

/**
 * Build route ScaffoldFiles from facts and append governance docs.
 * Used internally by baseFiles callers that also have governance.
 */
export function addGovernanceFiles(
  files: ScaffoldFile[],
  governance: { threatModel: string; adr001: string; adr002?: string; testPlan: string },
): ScaffoldFile[] {
  return [
    ...files,
    { path: '.ai/threat-model.md', role: 'adf', content: governance.threatModel },
    { path: '.ai/adr-001.md', role: 'adf', content: governance.adr001 },
    { path: '.ai/adr-002.md', role: 'adf', content: governance.adr002 ?? '' },
    { path: '.ai/test-plan.md', role: 'test', content: governance.testPlan },
    {
      path: '.ai/constraints.yaml',
      role: 'adf',
      content: [
        'runtime: cloudflare-workers',
        'framework: hono',
        'enforcement:',
        '  - authentication on protected routes',
        '  - tenant scoping on data queries',
        '  - typed env bindings',
        '  - centralized HttpError mapping',
      ].join('\n'),
    },
  ];
}

/**
 * Cloudflare Worker archetype — realistic CLAUDE.md bloat scenarios.
 *
 * Each scenario simulates one or more "sessions" where an AI assistant
 * or developer adds content to CLAUDE.md despite the thin pointer rules.
 * Sessions are applied sequentially to the same repo to simulate accumulation.
 */

import type { Scenario } from '../types';

export const workerScenarios: Scenario[] = [
  {
    id: 'worker-basic-deployment',
    archetype: 'worker',
    description: 'Dev adds deployment notes after first deploy confusion',
    manifest: {
      onDemand: [
        { path: 'infra.adf', triggers: ['wrangler', 'cloudflare', 'deploy', 'worker', 'kv', 'd1', 'r2'] },
        { path: 'backend.adf', triggers: ['api', 'fetch', 'route', 'handler', 'middleware'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: deployment notes',
        inject: `
## Deployment

- Deploy with \`wrangler deploy\`
- Set secrets with \`wrangler secret put NAME\`
- Use \`wrangler dev\` for local development
- Always run type-check before deploying
`,
        expected: { 'infra.adf': 4 },
      },
      {
        label: 'session-2: API patterns added later',
        inject: `
## API Design

- All routes must validate the Authorization header
- Return JSON with \`{ error: string }\` shape on failure
- Use \`ctx.waitUntil()\` for fire-and-forget operations
`,
        expected: { 'backend.adf': 3 },
      },
    ],
  },

  {
    id: 'worker-kv-and-d1',
    archetype: 'worker',
    description: 'Data layer rules accumulate across multiple AI sessions',
    manifest: {
      onDemand: [
        { path: 'infra.adf', triggers: ['wrangler', 'cloudflare', 'kv', 'd1', 'r2', 'deploy', 'binding'] },
        { path: 'backend.adf', triggers: ['api', 'fetch', 'handler', 'query', 'sql', 'database'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: KV usage notes',
        inject: `
## KV Store

- Namespace bound as \`KV\` in wrangler.toml
- Keys use colon-delimited hierarchy: \`user:id:profile\`
- TTL set to 3600 for session data
- KV is eventually consistent — do not rely on it for financial data
`,
        // heading "KV Store" now matches kv → infra.adf; all items route there
        expected: { 'infra.adf': 4 },
      },
      {
        label: 'session-2: D1 patterns',
        inject: `
## Database

- D1 bound as \`DB\` in wrangler.toml
- All queries go through \`db/queries.ts\` — no raw SQL in handlers
- Run migrations with \`wrangler d1 migrations apply\`
- Schema changes require a new migration file
`,
        // heading "Database" → backend.adf; heading-based routing wins over content keywords
        // wrangler items stay in backend.adf despite having infra triggers — known limitation
        expected: { 'backend.adf': 4 },
      },
    ],
  },

  {
    id: 'worker-architecture-dump',
    archetype: 'worker',
    description: 'AI assistant dumps full architecture overview into CLAUDE.md',
    manifest: {
      onDemand: [
        { path: 'infra.adf', triggers: ['wrangler', 'cloudflare', 'worker', 'deploy', 'binding', 'env'] },
        { path: 'backend.adf', triggers: ['api', 'route', 'handler', 'middleware', 'auth', 'fetch'] },
        { path: 'core.adf', triggers: [] },
      ],
    },
    sessions: [
      {
        label: 'session-1: architecture overview injected',
        inject: `
## Architecture

The worker handles all routing via Hono. Requests flow through auth middleware
before reaching business logic. All external calls use the fetch API directly.

## Auth

- Bearer token validated on every request except /health
- Token stored as WORKER_SECRET wrangler secret
- Return 401 with \`{ error: "Unauthorized" }\` on failure

## Conventions

- Use TypeScript strict mode
- No any types except at Cloudflare binding boundaries
- All handlers must be async
`,
        // ## Auth heading → security.adf; ## Conventions → core.adf except "handlers" → backend.adf
        // ## Architecture prose gets content-based routing (routes→backend, cloudflare→infra)
        expected: { 'security.adf': 3, 'infra.adf': 2, 'backend.adf': 1, 'core.adf': 1 },
      },
    ],
  },
];

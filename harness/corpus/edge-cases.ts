/**
 * Edge cases — ambiguous content, mis-attribution traps, and classifier stress tests.
 *
 * These are the scenarios most likely to reveal classifier weaknesses:
 * - Topically ambiguous content that could route to multiple modules
 * - Content that LOOKS like a rule but is actually prose/context
 * - Sections with misleading headings
 * - Content with no obvious trigger keywords (falls to core.adf catch-all)
 * - Imperative rules disguised as soft suggestions
 */

import type { Scenario } from '../types';

export const edgeCaseScenarios: Scenario[] = [
  {
    id: 'edge-env-vars-ambiguous',
    archetype: 'backend',
    description: 'Env var rules — ambiguous between infra and backend',
    manifest: {
      onDemand: [
        { path: 'infra.adf', triggers: ['deploy', 'env', 'docker', 'ci', 'environment', 'secret'] },
        { path: 'backend.adf', triggers: ['api', 'config', 'handler', 'middleware'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: env var conventions',
        inject: `
## Configuration

- All config comes from environment variables — no hardcoded values
- Use \`process.env.VAR_NAME\` with a validation layer at startup
- Prefix internal secrets with \`SECRET_\`
- Never commit .env files — use .env.example with placeholder values
`,
        // Ambiguous: could be infra (deploy/env) or core (conventions)
        // We expect infra due to 'env' and 'secret' triggers, but it's debatable
        expected: { 'infra.adf': 4 },
      },
    ],
  },

  {
    id: 'edge-misleading-heading',
    archetype: 'fullstack',
    description: 'Heading says "Architecture" but content is all deployment ops',
    manifest: {
      onDemand: [
        { path: 'infra.adf', triggers: ['deploy', 'ci', 'docker', 'build', 'pipeline', 'wrangler', 'cloudflare'] },
        { path: 'backend.adf', triggers: ['api', 'database', 'handler', 'route'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: misleading heading',
        inject: `
## Architecture

- Deploy to Cloudflare Workers via \`wrangler deploy\`
- CI pipeline runs on GitHub Actions — merge to main triggers deploy
- Build artifacts stored in \`dist/\` — never commit dist
- Rollback by deploying previous Worker version from dashboard
`,
        // Heading says Architecture but content is all infra ops
        // Classifier should catch infra triggers in content despite heading mismatch
        expected: { 'infra.adf': 4 },
      },
    ],
  },

  {
    id: 'edge-soft-rule-imperative',
    archetype: 'backend',
    description: 'Content that uses soft language but encodes hard constraints',
    manifest: {
      onDemand: [
        { path: 'core.adf', triggers: [] },
        { path: 'backend.adf', triggers: ['api', 'database', 'query', 'endpoint', 'auth'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: soft language hard constraints',
        inject: `
## Conventions

- It would be good to add tests for all new endpoints
- Try to use conventional commits where possible
- Consider validating all API inputs with Zod
- It might be worth checking auth on every endpoint
`,
        // These read as advisory but encode real constraints
        // classifier should mark as advisory weight, route to core/backend
        expected: { 'core.adf': 2, 'backend.adf': 2 },
      },
    ],
  },

  {
    id: 'edge-prose-not-rules',
    archetype: 'worker',
    description: 'Architecture prose that is context/background, not actionable rules',
    manifest: {
      onDemand: [
        { path: 'core.adf', triggers: [] },
        { path: 'backend.adf', triggers: ['api', 'handler', 'route', 'fetch'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: prose background context',
        inject: `
## Overview

This worker handles webhook delivery for the platform. It receives events from
the upstream service, validates signatures, and fans out to subscriber endpoints.
The retry logic uses exponential backoff with jitter. We chose Workers because
the latency requirements are under 50ms globally.
`,
        // Pure prose/context — should classify as CONTEXT section, not CONSTRAINTS
        expected: { 'core.adf': 1 },
      },
    ],
  },

  {
    id: 'edge-duplicate-injection',
    archetype: 'backend',
    description: 'Same rules injected twice across sessions — dedup must fire',
    manifest: {
      onDemand: [
        { path: 'backend.adf', triggers: ['api', 'database', 'query', 'migration', 'auth'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: initial rules',
        inject: `
## Database

- All queries go through the repository layer
- Migrations must be reversible
`,
        expected: { 'backend.adf': 2 },
      },
      {
        label: 'session-2: same rules re-injected (AI forgot it already added them)',
        inject: `
## Database Rules

- All queries go through the repository layer
- Migrations must be reversible
- Schema changes require a migration file
`,
        // First two are duplicates — only the third should be new
        expected: { 'backend.adf': 1 },
      },
    ],
  },

  {
    id: 'edge-no-trigger-keywords',
    archetype: 'backend',
    description: 'Valid rules with no domain-specific keywords — must land in core.adf',
    manifest: {
      onDemand: [
        { path: 'backend.adf', triggers: ['api', 'database', 'sql'] },
        { path: 'infra.adf', triggers: ['deploy', 'docker', 'ci'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: generic rules no keywords',
        inject: `
## Conventions

- Use conventional commits
- All PRs require at least one reviewer
- Tests must pass before merging
- Keep functions under 50 lines
`,
        // No trigger keywords — everything falls to core.adf catch-all
        expected: { 'core.adf': 4 },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // Dedup sensitivity — rephrased duplicates
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'edge-dedup-rephrased',
    archetype: 'backend',
    description: 'Rephrased duplicates — Jaccard may miss, but exact content should dedup',
    manifest: {
      onDemand: [
        { path: 'backend.adf', triggers: ['api', 'database', 'query', 'auth'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: original rules',
        inject: `
## API Rules

- Never commit secrets or credentials to the repo
- All queries go through the repository layer
- Validate all API inputs before processing
`,
        expected: { 'backend.adf': 3 },
      },
      {
        label: 'session-2: rephrased versions of the same rules + one new',
        inject: `
## API Rules

- Do not commit secrets to the repository under any circumstances
- All database queries must use the repository pattern
- Always validate incoming API payloads
- Log all 5xx errors with request context
`,
        // Rephrased duplicates fall below Jaccard 0.8 threshold — current behavior extracts all 4.
        // This test documents the known gap: rephrased duplicates bypass dedup.
        // When semantic dedup is added, update to { 'backend.adf': 1 }.
        expected: { 'backend.adf': 4 },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // Dedup sensitivity — partial overlap (2 of 3 already exist)
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'edge-dedup-partial-overlap',
    archetype: 'backend',
    description: 'Session-2 has 3 rules; 2 already in ADF — only 1 should migrate',
    manifest: {
      onDemand: [
        { path: 'backend.adf', triggers: ['api', 'database', 'query', 'migration'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: two baseline rules',
        inject: `
## Database

- All queries go through the repository layer
- Migrations must be reversible
`,
        expected: { 'backend.adf': 2 },
      },
      {
        label: 'session-2: 2 duplicates + 1 new',
        inject: `
## Database Rules

- All queries go through the repository layer
- Migrations must be reversible
- Schema changes require a migration file
`,
        // First two are exact duplicates — only the third should migrate
        expected: { 'backend.adf': 1 },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // Multi-module section splitting — heading dominates
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'edge-heading-dominates-cross-module',
    archetype: 'backend',
    description: 'Heading routes to backend but one item clearly belongs in infra — heading wins',
    manifest: {
      onDemand: [
        { path: 'backend.adf', triggers: ['api', 'database', 'query', 'migration', 'db'] },
        { path: 'infra.adf', triggers: ['deploy', 'wrangler', 'ci', 'pipeline', 'migrate'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: mixed database + infra items under DB heading',
        inject: `
## Database

- D1 bound as \`DB\` in wrangler.toml
- All queries use the \`DB\` binding via Drizzle ORM
- Run migrations with \`wrangler d1 migrate\`
- Never query D1 outside the repository layer
`,
        // Heading "Database" routes to backend.adf — all 4 items go there
        // even though "wrangler d1 migrate" is arguably infra.
        // This documents the known heading-dominates behavior.
        expected: { 'backend.adf': 4 },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // Security boundary — auth implementation vs security policy
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'edge-auth-implementation-vs-policy',
    archetype: 'fullstack',
    description: 'Auth heading: implementation items vs security policy items — all routed to security.adf',
    manifest: {
      onDemand: [
        { path: 'security.adf', triggers: ['auth', 'jwt', 'oauth', 'token', 'permission', 'security'] },
        { path: 'backend.adf', triggers: ['api', 'handler', 'middleware', 'route', 'endpoint'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: mixed auth implementation and policy rules',
        inject: `
## Auth

- Use Clerk for authentication — never roll custom auth
- JWT tokens expire after 24 hours
- Every API route must check auth before running handler logic
- Rotate secrets quarterly
- Never log JWT payloads or auth tokens
`,
        // "## Auth" heading routes all to security.adf — even implementation items.
        // This documents the known single-module heading-routing behavior.
        expected: { 'security.adf': 5 },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // Trigger prefix collision — short triggers over-matching
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'edge-trigger-prefix-collision',
    archetype: 'backend',
    description: 'Short triggers (auth, api) should not match unrelated words like "author" or "apiary"',
    manifest: {
      onDemand: [
        { path: 'security.adf', triggers: ['auth', 'token', 'permission'] },
        { path: 'backend.adf', triggers: ['api', 'database', 'handler'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: content with trigger-prefix false positives',
        inject: `
## Project Background

- The author of this library is Jane Smith
- Apiary endpoints are documented at apiary.io
- Authentic feedback from users drives our roadmap
- Authority for release decisions rests with the tech lead
`,
        // "author", "apiary", "authentic", "authority" should NOT match short triggers "auth"/"api".
        // Fixed: suffix-aware word-boundary regex blocks these false matches.
        // All items are generic prose — route to core.adf catch-all.
        expected: { 'core.adf': 4 },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // Large injection — 25+ items stress test
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'edge-large-injection',
    archetype: 'fullstack',
    description: '25+ items across multiple modules — routing accuracy and write correctness at scale',
    manifest: {
      onDemand: [
        { path: 'backend.adf', triggers: ['api', 'database', 'query', 'handler', 'endpoint'] },
        { path: 'security.adf', triggers: ['auth', 'token', 'permission', 'secret', 'cors'] },
        { path: 'infra.adf', triggers: ['deploy', 'ci', 'docker', 'pipeline', 'wrangler', 'cloudflare'] },
        { path: 'frontend.adf', triggers: ['react', 'component', 'ui', 'css', 'design'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: large mixed-domain injection',
        inject: `
## API Design

- All endpoints follow REST conventions
- Use Zod for request validation on every handler
- Return 400 for validation errors with field-level messages
- Return 401 for unauthenticated, 403 for unauthorized
- Paginate all list endpoints with cursor-based pagination
- Never expose internal IDs in API responses

## Auth

- Use JWT with RS256 signing
- Access tokens expire after 15 minutes
- Refresh tokens stored in HttpOnly cookies
- Never log token payloads
- CORS restricted to known origin domains

## Database

- All queries through repository layer
- Migrations must be reversible
- Use transactions for multi-step writes
- Never SELECT *

## Deployment

- Deploy via Wrangler to Cloudflare Workers
- CI runs tests and type-check before deploy
- Staging deploys on every PR merge to main
- Production deploys require manual approval

## UI

- Use shadcn/ui for all design system components
- Tailwind utility classes only — no custom CSS
- All interactive elements must have accessible labels
`,
        // ## API Design → backend.adf (6), ## Auth → security.adf (5),
        // ## Database → backend.adf (4), ## Deployment → infra.adf (4), ## UI → frontend.adf (3)
        // backend.adf total: 6 + 4 = 10
        expected: { 'backend.adf': 10, 'security.adf': 5, 'infra.adf': 4, 'frontend.adf': 3 },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // Empty injection — heading with no content
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'edge-empty-heading',
    archetype: 'backend',
    description: 'AI adds a heading with no content — should produce 0 extractions cleanly',
    manifest: {
      onDemand: [
        { path: 'backend.adf', triggers: ['api', 'database', 'auth'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: heading with no content',
        inject: `
## Auth

`,
        expected: {},
      },
    ],
  },
];

/**
 * Backend/API archetype — Node.js/Express/Hono style projects.
 * Heavy on database rules, auth patterns, API design constraints.
 */

import type { Scenario } from '../types';

export const backendScenarios: Scenario[] = [
  {
    id: 'backend-auth-accumulation',
    archetype: 'backend',
    description: 'Auth rules accumulate session by session after security incident',
    manifest: {
      onDemand: [
        { path: 'security.adf', triggers: ['auth', 'jwt', 'token', 'session', 'secret', 'password', 'bcrypt'] },
        { path: 'backend.adf', triggers: ['api', 'route', 'endpoint', 'middleware', 'handler', 'request', 'response'] },
        { path: 'infra.adf', triggers: ['deploy', 'env', 'docker', 'ci', 'pipeline'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: basic auth rules',
        inject: `
## Auth

- JWT tokens expire in 15 minutes
- Refresh tokens stored in httpOnly cookies only
- Never log tokens or passwords
`,
        expected: { 'security.adf': 3 },
      },
      {
        label: 'session-2: more auth after incident',
        inject: `
## Security

- Rate limit login endpoint to 5 requests per minute per IP
- bcrypt cost factor is 12
- Validate password strength on signup: min 8 chars, 1 upper, 1 number
- CORS restricted to known origins only — no wildcard in production
`,
        expected: { 'security.adf': 4 },
      },
      {
        label: 'session-3: API rules mixed with auth',
        inject: `
## API Conventions

- All endpoints return \`{ data, error, meta }\` shape
- 400 for validation errors, 401 for auth, 403 for authz, 404 for not found
- Request IDs injected via middleware, logged on every response

## Auth Middleware

- Apply \`requireAuth\` to all routes except /health and /auth/*
- Decoded token payload available as \`req.user\`
`,
        expected: { 'backend.adf': 3, 'security.adf': 2 },
      },
    ],
  },

  {
    id: 'backend-database-rules',
    archetype: 'backend',
    description: 'Database rules grow as schema complexity increases',
    manifest: {
      onDemand: [
        { path: 'backend.adf', triggers: ['database', 'db', 'sql', 'query', 'migration', 'schema', 'postgres', 'prisma'] },
        { path: 'core.adf', triggers: [] },
      ],
    },
    sessions: [
      {
        label: 'session-1: initial database rules',
        inject: `
## Database

- All queries go through the repository layer — no raw SQL in controllers
- Migrations must be reversible
- Schema changes require a migration file in \`db/migrations/\`
`,
        expected: { 'backend.adf': 3 },
      },
      {
        label: 'session-2: performance rules after slow query incident',
        inject: `
## Database Performance

- Add indexes for any column used in a WHERE clause with >10k rows
- Use \`EXPLAIN ANALYZE\` before adding any query to a hot path
- Paginate all list endpoints — default page size 20, max 100
- N+1 queries are forbidden — use JOINs or dataloader pattern
`,
        expected: { 'backend.adf': 4 },
      },
    ],
  },

  {
    id: 'backend-mixed-concerns',
    archetype: 'backend',
    description: 'Realistic AI session: mixed architecture, API, and deployment content in one dump',
    manifest: {
      onDemand: [
        { path: 'backend.adf', triggers: ['api', 'endpoint', 'route', 'middleware', 'handler', 'database', 'sql', 'query'] },
        { path: 'infra.adf', triggers: ['deploy', 'docker', 'env', 'ci', 'pipeline', 'build'] },
        { path: 'core.adf', triggers: [] },
      ],
    },
    sessions: [
      {
        label: 'session-1: AI dumps everything it knows about the project',
        inject: `
## Architecture

Layered architecture: routes → controllers → services → repositories → database.
Each layer only imports from the layer directly below it.

## API Design

- RESTful routes using plural nouns: \`/users\`, \`/orders\`
- PATCH for partial updates, PUT for full replacement
- All mutations require idempotency keys via \`Idempotency-Key\` header

## Database Rules

- Postgres 15 via Prisma ORM
- All timestamps in UTC
- Soft deletes via \`deleted_at\` column — never hard delete user data

## Deployment

- Build with \`docker build\`
- Deploy via GitHub Actions on merge to main
- Secrets injected as environment variables at runtime — never baked into image

## Conventions

- Use Zod for all input validation
- Error handling via centralized error middleware
- All new features require integration tests
`,
        // Prose architecture block (routes keyword) → backend.adf; middleware item → backend.adf
        // "database" heading now routes to backend.adf, displacing expected core items
        expected: { 'backend.adf': 8, 'infra.adf': 3, 'core.adf': 2 },
      },
    ],
  },
];

/**
 * Fullstack archetype — projects with frontend, backend, and infra concerns.
 * Tests cross-cutting content that spans multiple modules.
 */

import type { Scenario } from '../types';

export const fullstackScenarios: Scenario[] = [
  {
    id: 'fullstack-feature-by-feature-growth',
    archetype: 'fullstack',
    description: 'Each feature release adds more to CLAUDE.md — realistic long-term accumulation',
    manifest: {
      onDemand: [
        { path: 'frontend.adf', triggers: ['react', 'component', 'css', 'ui', 'tailwind', 'vite', 'tsx'] },
        { path: 'backend.adf', triggers: ['api', 'endpoint', 'route', 'handler', 'database', 'sql', 'prisma', 'auth'] },
        { path: 'infra.adf', triggers: ['deploy', 'ci', 'docker', 'build', 'pipeline', 'env'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: v1 launch — frontend setup',
        inject: `
## Frontend

- React 18 with TypeScript strict mode
- Components in \`src/components/\` — one file per component
- Use Tailwind for styling — no inline styles, no CSS modules
- All components must be tested with React Testing Library
`,
        expected: { 'frontend.adf': 4 },
      },
      {
        label: 'session-2: auth feature ships',
        inject: `
## Auth

- Auth via Clerk — do not roll your own auth
- Protect routes with \`<SignedIn>\` wrapper components
- Server-side auth check via \`auth()\` in API handlers

## API

- API routes in \`app/api/\` using Next.js route handlers
- Return \`NextResponse.json()\` — never return raw Response
`,
        // ## Auth heading → security.adf (3 items); ## API → backend.adf (2 items)
        expected: { 'security.adf': 3, 'backend.adf': 2 },
      },
      {
        label: 'session-3: CI/CD after first broken deploy',
        inject: `
## CI/CD

- GitHub Actions deploys on merge to main
- Build must pass \`tsc --noEmit\` and all tests before deploy
- Preview deployments on every PR via Vercel
- Production deploy requires manual approval in GitHub
`,
        expected: { 'infra.adf': 4 },
      },
    ],
  },

  {
    id: 'fullstack-big-bang-onboarding-doc',
    archetype: 'fullstack',
    description: 'New dev writes a full onboarding guide into CLAUDE.md',
    manifest: {
      onDemand: [
        { path: 'frontend.adf', triggers: ['react', 'component', 'css', 'ui', 'tailwind', 'tsx', 'vite'] },
        { path: 'backend.adf', triggers: ['api', 'database', 'prisma', 'auth', 'route', 'handler', 'middleware'] },
        { path: 'infra.adf', triggers: ['deploy', 'docker', 'ci', 'build', 'pipeline', 'env', 'vercel'] },
        { path: 'core.adf', triggers: [] },
      ],
    },
    sessions: [
      {
        label: 'session-1: entire onboarding guide dumped',
        inject: `
## Stack

- Next.js 14 app router, TypeScript, Tailwind, Prisma, PostgreSQL
- Auth via NextAuth.js
- Deploy to Vercel

## Frontend Conventions

- Use server components by default — client components only when necessary
- Tailwind classes in JSX only — no separate CSS files
- Component names in PascalCase, files match component name

## Backend Conventions

- API routes validate with Zod before hitting any service
- All database mutations wrap in transactions
- Prisma client is a singleton in \`lib/prisma.ts\`

## Auth

- Session handled by NextAuth — never access \`req.session\` directly
- Protected pages redirect to /login via middleware.ts
- Admin routes also check \`user.role === 'admin'\`

## Deployment

- \`pnpm build\` then push to main — Vercel auto-deploys
- Environment variables set in Vercel dashboard — not in \`.env\`
- Preview URL shared in PR description for review

## Testing

- Vitest for unit tests, Playwright for e2e
- Coverage threshold is 80% for \`src/lib/\`
- Run \`pnpm test\` before pushing
`,
        // ## Auth → security.adf (3); "vitest" keyword (vite prefix) → frontend.adf (1 testing item)
        // ## Stack prose split by content triggers; heading-based routing dominates per section
        expected: { 'frontend.adf': 5, 'backend.adf': 4, 'infra.adf': 4, 'core.adf': 2, 'security.adf': 3 },
      },
    ],
  },
];

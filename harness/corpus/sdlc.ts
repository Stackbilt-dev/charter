/**
 * SDLC-focused scenarios — validate that ADF modules stay updated and portable
 * as project guidance evolves from requirements through release.
 */

import type { Scenario } from '../types';

export const sdlcScenarios: Scenario[] = [
  {
    id: 'fullstack-sdlc-handoff-portability',
    archetype: 'fullstack',
    description: 'Rules evolve across SDLC phases while remaining portable through ADF modules',
    manifest: {
      onDemand: [
        { path: 'frontend.adf', triggers: ['react', 'component', 'ui', 'css', 'vite', 'tsx'] },
        { path: 'backend.adf', triggers: ['api', 'endpoint', 'route', 'handler', 'database', 'auth', 'zod', 'request', 'response'] },
        { path: 'infra.adf', triggers: ['deploy', 'release', 'rollback', 'ci', 'pipeline', 'docker', 'env', 'artifact'] },
        { path: 'qa.adf', triggers: ['test', 'testing', 'playwright', 'contract', 'smoke', 'verification', 'evidence', 'auditability'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: requirements',
        inject: `
## API Requirements

- Every API endpoint must publish request and response schemas
- Auth is required for all write endpoints
- Route handlers must return structured error codes
- Database migrations must be reviewed before merge
`,
        expected: { 'backend.adf': 4 },
      },
      {
        label: 'session-2: design',
        inject: `
## System Design

- React UI components must map one-to-one to approved design tokens
- API handlers must validate all payloads with Zod
- Route naming must stay stable across versions
- Frontend component props must be typed in TSX files
`,
        expected: { 'frontend.adf': 2, 'backend.adf': 2 },
      },
      {
        label: 'session-3: implementation',
        inject: `
## Implementation Rules

- API route files live under \`app/api/\` and use one handler per endpoint
- Database writes must run inside transactions
- Auth checks execute before any handler business logic
- Build artifacts are generated only in CI pipeline jobs
`,
        expected: { 'backend.adf': 3, 'infra.adf': 1 },
      },
      {
        label: 'session-4: verification',
        inject: `
## Verification

- CI pipeline must run unit, integration, and Playwright suites on every PR
- API contract tests validate request and response schema compatibility
- Deploy preview environments must run smoke checks before approval
- Test artifacts are uploaded from CI for auditability
`,
        expected: { 'qa.adf': 4 },
      },
      {
        label: 'session-5: release and portability handoff',
        inject: `
## Release Handoff

- Deploy jobs must consume versioned artifacts from the pipeline only
- Rollback instructions must be validated in staging before production release
- Environment configuration uses env keys defined in the deployment checklist
- Release evidence includes CI run ID, artifact hash, and deployment timestamp
`,
        expected: { 'infra.adf': 4 },
      },
    ],
  },
  {
    id: 'fullstack-sdlc-generic-checklist-routing',
    archetype: 'fullstack',
    description: 'Generic SDLC handoff headings still separate verification evidence from release operations',
    manifest: {
      onDemand: [
        { path: 'frontend.adf', triggers: ['react', 'component', 'ui', 'css', 'vite', 'tsx'] },
        { path: 'backend.adf', triggers: ['api', 'endpoint', 'route', 'handler', 'database', 'auth', 'zod', 'request', 'response'] },
        { path: 'infra.adf', triggers: ['deploy', 'release', 'rollback', 'ci', 'pipeline', 'docker', 'env', 'artifact'] },
        { path: 'qa.adf', triggers: ['test', 'testing', 'playwright', 'contract', 'smoke', 'verification', 'evidence', 'auditability'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: generic checklist handoff',
        inject: `
## Checklist

- Playwright smoke tests must pass before release approval
- Contract test evidence is attached to the deployment record for auditability
- Release artifact hashes are recorded before deploy starts
- Rollback drills must use the staged deploy artifact from the pipeline
`,
        expected: { 'qa.adf': 2, 'infra.adf': 2 },
      },
    ],
  },
  {
    id: 'fullstack-sdlc-mixed-qa-backend-signals',
    archetype: 'fullstack',
    description: 'Mixed backend and QA wording in a generic checklist should still route by dominant verification vs API intent',
    manifest: {
      onDemand: [
        { path: 'frontend.adf', triggers: ['react', 'component', 'ui', 'css', 'vite', 'tsx'] },
        { path: 'backend.adf', triggers: ['api', 'endpoint', 'route', 'handler', 'database', 'auth', 'zod', 'request', 'response'] },
        { path: 'infra.adf', triggers: ['deploy', 'release', 'rollback', 'ci', 'pipeline', 'docker', 'env', 'artifact'] },
        { path: 'qa.adf', triggers: ['test', 'testing', 'playwright', 'contract', 'smoke', 'verification', 'evidence', 'auditability'] },
      ],
    },
    sessions: [
      {
        label: 'session-1: mixed checklist bullets',
        inject: `
## Checklist

- API contract test evidence must be attached to the release review for auditability
- Request and response schema contract tests must pass before merging backend changes
- Endpoint smoke tests run in CI before deploy approval
- API handler error responses are verified against contract fixtures
`,
        expected: { 'qa.adf': 3, 'backend.adf': 1 },
      },
    ],
  },
];

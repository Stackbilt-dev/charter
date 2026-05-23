# Context Refresh Resume Guide

This doc is the handoff packet for resuming `charter context-refresh` work with minimal rediscovery.

## Current Status

- Issue status:
  - `#154` closed (resolved)
  - `#158` closed (resolved)
  - `#155` open (remaining Phase 3 scope)
- Landed commits:
  - `c5e90fd` — Phase 1 MVP (`context-refresh` command, `.ai/context.adf`, tests/docs)
  - `5fb4a44` — Phase 2 (`git` + `github` sources, `.ai/context.snapshot.json`, TTL controls, config contract)

## What Is Shipped

`charter context-refresh` currently supports:

- Sources:
  - `git`
  - `github` (strict-label mode)
- Writes:
  - `.ai/context.adf`
  - `.ai/context.snapshot.json`
- Flags:
  - `--sources git,github`
  - `--output CONTEXT.md`
  - `--ai-dir <dir>`
  - `--once`
  - `--ttl-minutes <n>`
  - `--force`
  - `--format json`
- Config file:
  - `.charter/context-sources.json`

## Important Behavioral Decisions

- Aggregate arrays (`openWork`, `recentActivity`, `pendingDecisions`) are derived at refresh time from source payloads to avoid dual-write drift.
- GitHub source is fail-closed:
  - missing `GITHUB_TOKEN` does not crash refresh
  - snapshot records `sources.github.available = false`
  - warning is emitted in output payload

## Remaining Scope (Phase 3)

To close `#155`, complete:

1. MCP tool: `charter_context` (structured snapshot read, optional refresh path)
2. Warm-start orchestration docs:
   - session-start usage with `--once`
   - TTL tuning guidance
   - example hook wiring

## Phase 3 Kickoff Checklist (v0.16.0+)

Track this as the active implementation sequence for `#155`:

1. `serve` wiring:
   - add MCP tool contract for `charter_context`
   - support read-only mode (`refresh=false`) and refresh mode (`refresh=true`)
2. runtime behavior:
   - return structured JSON from `.ai/context.snapshot.json` when available
   - on missing snapshot + `refresh=false`, return explicit actionable error
   - on `refresh=true`, invoke existing `context-refresh` pipeline and return refreshed snapshot
3. tests:
   - tool reads existing snapshot
   - tool refresh path returns updated snapshot
   - missing snapshot behavior is deterministic and documented
4. docs:
   - `docs/cli-reference.md` tool contract
   - `README.md` session-start flow using `--once` and TTL guidance

Definition of done for Phase 3:

- `charter serve` exposes `charter_context` with stable JSON output
- end-to-end tests pass for read/refresh/error paths
- docs include a copy/pasteable session-start hook example
- issue `#155` can close with no remaining TODOs

## Suggested Restart Plan (Next Session)

1. Add `charter_context` tool registration in `packages/cli/src/commands/serve.ts`
2. Reuse `context-refresh` pipeline for refresh-on-demand behavior
3. Add tests:
   - tool read existing snapshot
   - tool refresh path
   - missing snapshot behavior when `refresh=false`
4. Update docs:
   - `docs/cli-reference.md` (MCP tools table + tool contract)
   - `README.md` MCP section

## Validation Commands

Run these after any Phase 3 changes:

```bash
pnpm exec vitest run packages/cli/src/__tests__/context-refresh.test.ts
pnpm exec vitest run packages/cli/src/__tests__/context.test.ts packages/cli/src/__tests__/score.test.ts
pnpm exec tsc --noEmit -p tsconfig.json
```

## Quick Smoke Commands

```bash
npx charter context-refresh --format json
npx charter context-refresh --once --ttl-minutes 30 --format json
npx charter context-refresh --sources git,github --format json
```

If GitHub source is enabled and `GITHUB_TOKEN` is absent, expected behavior is warning-only fallback (no hard failure).

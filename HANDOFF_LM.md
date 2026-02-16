# LM Handoff: Charter Kit

## Mission
Prepare Charter Kit for production npm publication as a seamless CLI for humans and LM agents.

## Current State (as of 2026-02-16)

- CLI supports: `setup`, `init`, `doctor`, `validate`, `drift`, `audit`, `classify`.
- Deterministic exit codes are implemented:
  - `0` success
  - `1` policy violation in CI mode
  - `2` runtime/config/usage error
- JSON output is available for machine consumption via `--format json`.
- Root scripts are cross-platform (`build`, `typecheck`, `clean`).
- Docs were updated (`README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `SECURITY.md`).

## What Was Verified Locally

Run from repo root:

```bash
pnpm install
pnpm run clean
pnpm run build
pnpm run typecheck
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js setup --format json --yes
node packages/cli/dist/bin.js doctor --format json
```

Behavior checks done:
- `doctor --ci` on missing config returns exit code `1`.
- invalid `classify` usage returns exit code `2`.

## Key Design Contracts

1. CLI must be usable by humans and agents without branching logic.
2. Machine mode uses `--format json --ci` and exit codes for control flow.
3. Toolkit remains offline-first and heuristic-only (no LLM API/runtime cloud dependency).

## Known Gaps Before npm Publish

1. Workspace dependencies still use `workspace:*` and require publish strategy.
2. No automated unit/integration test suite yet.
3. No release automation/versioning pipeline documented yet.
4. JSON schemas for command output are implied but not formally versioned.

## Recommended Next Tasks

1. Finalize publish model:
   - Publish all `@charter/*` packages together, or
   - Bundle CLI dependencies to avoid workspace publish coupling.
2. Add tests:
   - command-level smoke tests for exit codes and JSON shape
   - fixture-based tests for `validate` and `drift`
3. Add schema docs:
   - versioned JSON schema per command output
4. Add release process docs:
   - version bump flow
   - npm publish checklist
   - rollback strategy

## Guardrails

- Keep command names stable; avoid breaking CLI contracts pre-1.0 unless documented.
- Preserve deterministic exit-code behavior.
- Keep output concise in text mode and stable in JSON mode.
- Do not add cloud runtime coupling to core packages.

## Suggested Immediate Smoke Test in an External Repo

```bash
npx @charter/cli@<local-or-tag> setup --ci github
npx @charter/cli@<local-or-tag> doctor --format json
npx @charter/cli@<local-or-tag> validate --format json --ci
npx @charter/cli@<local-or-tag> drift --format json --ci
```

Expected outcome:
- config scaffolding created
- diagnostics emitted in JSON
- non-zero exits only for policy or runtime/usage failures

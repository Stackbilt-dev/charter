---
title: "Agent DX Feedback: Install/Setup Automation Friction (Windows + PNPM Workspace)"
feedback-id: ADX-003
date: 2026-02-26
source: "Codex (OpenAI) configuring digitalcsa-kit with @stackbilt/cli v0.3.2"
severity: high
bucket: automation-ci
status: planned
related:
  - RM-001 (ADF vNext Roadmap draft)
  - ADX-001 (runtime discoverability friction)
  - ADX-002 (ADF bootstrapping/routing friction)
tracked-issues: []
tracked-prs: []
---

# Agent DX Feedback: Install/Setup Automation Friction (Windows + PNPM Workspace)

## Observation

Running the documented Charter install/setup flow in this repo surfaced a separate class of friction:
**automation orchestration friction**.

The setup itself works, but the path to a stable, locally-pinned CLI involved multiple command modes and manual cleanup:

1. Local dev invocation (`node packages/cli/dist/bin.js`) failed with `MODULE_NOT_FOUND` (`@stackbilt/adf`)
2. `pnpm exec charter` resolved an unrelated older `charter v0.1.11` before local pinning
3. `npx @stackbilt/cli@latest` worked and applied setup mutations (`package.json`, workflow)
4. `pnpm install` prompted interactively to rebuild modules
5. `pnpm install` then failed with `EACCES` due to mixed package-manager state in root and nested `packages/*/node_modules`
6. Manual cleanup of `node_modules` (root + nested packages) was required before install succeeded
7. After cleanup, `pnpm exec charter` resolved correctly to `charter v0.3.2`

This is precisely the kind of workflow that should be reduced to one automation command for users and agents.

## What Worked

- `npx @stackbilt/cli@latest setup --detect-only --format json` returned useful JSON detection output.
- `npx @stackbilt/cli@latest doctor --format json` validated `.charter/` and `.ai/` state.
- `npx @stackbilt/cli@latest setup --ci github --yes --format json` successfully:
  - created `.github/workflows/charter-governance.yml`
  - added `charter:detect` and `charter:setup` scripts
  - added `@stackbilt/cli` as a dev dependency
- `npx @stackbilt/cli@latest adf sync --check --format json` confirmed `.ai/.adf.lock` was in sync.
- After reinstall, `pnpm exec charter --version` resolved the pinned local CLI (`v0.3.2`).

## Root Causes

### 1. Invocation paths are fragmented and ambiguous

There are at least three viable command paths, each with different behavior:

- `node packages/cli/dist/bin.js ...` (local source build path)
- `pnpm exec charter ...` (local installed binary path)
- `npx @stackbilt/cli@latest ...` (published package path)

Agents and users need a documented decision rule:

- "bootstrap with `npx`"
- "then pin and switch to `pnpm exec`"
- "do not use `node packages/cli/dist/bin.js` unless workspace package links are installed"

Without this, automation scripts become brittle.

### 2. `setup` is not an install-complete workflow

`charter setup --ci github --yes` mutates `package.json` to add `@stackbilt/cli`, but does not complete dependency installation.

This is reasonable behavior in isolation, but in practice it creates a second required step that is easy to miss in automation:

- `charter setup` succeeds
- local `pnpm exec charter` may still be wrong or unavailable until `pnpm install`

For users who want "one command and done," this is a DX trap.

### 3. PNPM reinstall prompt breaks unattended automation

`pnpm install` prompted:

- "The modules directories will be removed and reinstalled from scratch. Proceed? (Y/n)"

This blocks CI-like or agent-driven unattended flows unless the user already knows which flags/environment variables suppress the prompt.

### 4. Mixed package-manager state cleanup is manual and platform-sensitive

`pnpm install` failed with `EACCES` while trying to move packages to `.ignored`, requiring manual removal of:

- root `node_modules`
- nested `packages/*/node_modules`

This is especially painful on Windows due to file locks/permissions and path case differences (`Documents` vs `documents` shown across tools).

### 5. Detection confidence and preset suggestion are not automation-safe enough

On this repo (a Charter toolkit monorepo), detect-only returned:

- `confidence: "MEDIUM"`
- `suggestedPreset: "fullstack"`

That may be harmless, but it is not strong enough for no-review automation. A single-command bootstrap should either:

- produce a high-confidence preset, or
- stop with a machine-readable "needs confirmation" status (without mutating files)

## Impact on vNext Roadmap (RM-001)

This adds a new roadmap pressure beyond ADF authoring:

- **automation-first installation and repo onboarding**

The user request in this session was explicit: too many manual commands across Windows/WSL. The current flow confirms that pain.

## Recommended Charter Improvements

### P0: Add a one-command bootstrap wrapper

Introduce a command that orchestrates the full happy path:

```bash
charter bootstrap --ci github --yes
```

Responsibilities:

- run detect/setup
- pin/add `@stackbilt/cli` to devDependencies if missing
- invoke the repo package manager install (or emit exact next step)
- optionally run `doctor`
- optionally run `adf init` / `adf sync --check`
- emit a final status summary and next actions

### P0: Add `--install` / `--post-install-check` mode to `setup`

If a new `bootstrap` command is too large for next sprint, extend `setup`:

- `charter setup --ci github --yes --install`
- `charter setup --ci github --yes --install --doctor`

This directly addresses the "setup succeeded but install not done" gap.

### P1: Emit machine-readable next-step plan after `setup`

When `setup` mutates `package.json`, emit:

- detected package manager
- exact install command (`pnpm install`)
- whether install is required before local `charter` usage
- optional `doctor`/`validate` follow-ups

JSON example:

```json
{
  "nextSteps": [
    { "cmd": "pnpm install", "required": true, "reason": "New devDependency @stackbilt/cli added" },
    { "cmd": "pnpm exec charter doctor --format json", "required": false, "reason": "Verify configuration" }
  ]
}
```

### P1: Add `charter fix install` (workspace cleanup helper)

Detect and repair common local install blockers:

- mixed package-manager artifacts
- stale nested `node_modules`
- lockfile/package-manager mismatch

Dry-run first, explicit destructive confirmation, and JSON output.

### P1: Publish platform-specific automation recipes

Document canonical commands for:

- Windows PowerShell
- WSL/Linux
- CI

This should include non-interactive install guidance (`CI=true`, pnpm flags) and known prompt suppression patterns.

### P2: Improve detect-only automation ergonomics

- de-duplicate `sources` entries in output
- expose confidence rationale
- add `requiresConfirmation: true|false`
- support `--fail-on-medium-confidence` for safe automation wrappers

## Metrics to Track (Automation DX)

- Commands required from empty state to "configured + doctor pass"
- Interactive prompts encountered during bootstrap
- Manual interventions required (cleanup, retries, permission fixes)
- Time to local pinned `charter` availability (`pnpm exec charter --version`)
- Cross-platform recipe success rate (PowerShell vs WSL/Linux)

## Appendix: Session Receipts (Key Outcomes)

- `npx @stackbilt/cli@latest` resolved `charter v0.3.2`
- `setup --ci github --yes` added:
  - `.github/workflows/charter-governance.yml`
  - `package.json` scripts: `charter:detect`, `charter:setup`
  - `devDependencies["@stackbilt/cli"] = "0.3.2"`
- `adf sync --check` returned `allInSync: true`
- Local pinned CLI worked after cleanup + reinstall: `pnpm exec charter --version` -> `charter v0.3.2`

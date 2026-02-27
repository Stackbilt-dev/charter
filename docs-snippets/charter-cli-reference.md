---
title: "CLI Reference"
section: "charter"
order: 2
color: "#f59e0b"
tag: "02"
---

# CLI Reference

Use `npx charter ...` if Charter is installed as a local dev dependency. Use `charter ...` if installed globally.

## Governance Commands

### charter validate

Checks commit trailers for governance compliance. Every commit should carry a `Governed-By:` trailer linking it to an ADR or governance decision.

```bash
npx charter validate                       # check recent commits
npx charter validate --ci                  # CI mode — exits 1 on violations
npx charter validate --ci --format json    # machine-readable output
npx charter validate --range HEAD~5..HEAD  # specific commit range
```

JSON output includes `policyOffenders` (missing required trailers) and `riskOffenders` (high-risk paths without governance), plus `effectiveRangeSource` and `defaultCommitRange` for agent transparency.

### charter drift

Scans the codebase for deviations from your blessed stack patterns. Detects unapproved dependencies, frameworks, and patterns defined in `.charter/patterns/*.json`.

```bash
npx charter drift                         # scan + print report
npx charter drift --ci --format json      # CI mode
npx charter drift --path ./packages       # scan a specific directory
```

### charter audit

Generates a governance posture report: risk score, governed commit ratio, recent violations, and trend data. Policy score uses configurable section coverage.

```bash
npx charter audit
npx charter audit --format json
npx charter audit --range HEAD~10..HEAD
```

### charter classify

Classifies a subject or change request into a governance scope.

| Scope | Meaning |
|---|---|
| `SURFACE` | UI/copy only, low risk |
| `LOCAL` | Contained to one module |
| `CROSS_CUTTING` | Touches multiple systems, requires ADR |

```bash
npx charter classify "add OAuth callback flow"
npx charter classify "migrate auth provider" --format json
```

### charter hook

Installs git hooks that normalize governance trailers at commit time.

```bash
npx charter hook install --commit-msg
```

### charter setup

Bootstraps `.charter/` config and optionally writes CI workflow scaffolding.

```bash
npx charter setup --detect-only --format json
npx charter setup --ci github --yes
npx charter setup --preset fullstack --ci github --yes
```

Setup-specific options:

- `--ci github` — generate GitHub Actions governance workflow
- `--preset <worker|frontend|backend|fullstack>` — stack preset
- `--detect-only` — preview detection results without writing files
- `--no-dependency-sync` — skip rewriting `@stackbilt/cli` devDependency

### charter init

Scaffolds the `.charter/` config directory without running the full setup workflow.

```bash
npx charter init
npx charter init --preset worker
```

### charter doctor

Checks CLI installation and repository config health. Validates ADF readiness: manifest existence, manifest parse, default-load module presence, and sync lock status.

```bash
npx charter doctor
npx charter doctor --format json
```

### charter why

Prints a quick explanation of Charter's governance value and adoption ROI.

```bash
npx charter why
```

## ADF Commands

ADF (Attention-Directed Format) is Charter's modular AI context compiler. These commands manage the `.ai/` directory.

### charter adf init

Scaffolds `.ai/` directory with `manifest.adf`, `core.adf`, `state.adf`, and starter `frontend.adf`/`backend.adf` modules. The scaffolded `core.adf` includes a `[load-bearing]` CONSTRAINTS section and a `METRICS [load-bearing]` section with starter LOC ceilings.

```bash
npx charter adf init
npx charter adf init --ai-dir ./context    # custom directory
npx charter adf init --force               # overwrite existing
```

### charter adf fmt

Parses and reformats ADF files to canonical form. Enforces emoji decorations, canonical section ordering, and 2-space indent.

```bash
npx charter adf fmt .ai/core.adf --write   # reformat in-place
npx charter adf fmt .ai/core.adf --check   # CI: exit 1 if not canonical
npx charter adf fmt --explain              # canonical section ordering
```

### charter adf patch

Applies typed delta operations to ADF files. Agents issue patches instead of rewriting entire files — preventing silent memory corruption.

```bash
npx charter adf patch .ai/state.adf --ops '[{"op":"ADD_BULLET","section":"STATE","value":"Reviewing PR #42"}]'
npx charter adf patch .ai/state.adf --ops-file patches.json
```

**Operations:** `ADD_BULLET`, `REPLACE_BULLET`, `REMOVE_BULLET`, `ADD_SECTION`, `REPLACE_SECTION`, `REMOVE_SECTION`, `UPDATE_METRIC`.

### charter adf create

Creates a module file and registers it in `manifest.adf` under `ON_DEMAND` or `DEFAULT_LOAD`.

```bash
npx charter adf create arcana.adf --triggers "reading,spread,card"
npx charter adf create governance.adf --load default
```

### charter adf bundle

Resolves manifest modules for a given task and outputs merged context with token estimate. Only loads modules whose trigger keywords match the task.

```bash
npx charter adf bundle --task "Fix the React login component"
npx charter adf bundle --task "Add REST endpoint" --format json
```

JSON output includes `triggerMatches` (with `matchedKeywords` and `loadReason`), `unmatchedModules`, `missingModules`, `tokenEstimate`, `tokenBudget`, `tokenUtilization`, and `perModuleTokens`.

### charter adf sync

Verifies source `.adf` files match locked hashes, or updates the lock file.

```bash
npx charter adf sync --check               # CI: exit 1 on drift
npx charter adf sync --write               # update .adf.lock
npx charter adf sync --check --format json
```

### charter adf evidence

Validates metric constraints and produces a structured evidence report. The core of Charter's ADF governance pipeline.

```bash
npx charter adf evidence --auto-measure                     # full report
npx charter adf evidence --auto-measure --ci --format json  # CI gating
npx charter adf evidence --task "auth module" --auto-measure
npx charter adf evidence --context '{"entry_loc": 142}'
npx charter adf evidence --context-file metrics.json
```

**`--auto-measure`** counts lines in source files referenced by the manifest `METRICS` section and injects them as context overrides.

**Constraint semantics:** `value < ceiling` = pass, `value === ceiling` = warn, `value > ceiling` = fail.

**CI mode:** exits 1 on any constraint failure. Warnings (at boundary) surface in the report but do not fail the build.

Output includes constraint results, weight summary (load-bearing / advisory / unweighted), sync status, advisory-only warnings, and a `nextActions` array.

### ADF Automation Gate

For deterministic LM-agent enforcement, run:

```bash
npx charter doctor --adf-only --ci --format json
npx charter adf evidence --auto-measure --ci --format json
```

`doctor --adf-only` validates thin-pointer routing, required manifest wiring, and module parseability. `adf evidence --ci` validates measurable ceilings.

## Global Flags

| Flag | Effect |
|---|---|
| `--config <path>` | Path to `.charter/` directory (default: `.charter/`) |
| `--format json` | Machine-readable output with stable schemas |
| `--ci` | Non-interactive, deterministic exit codes |
| `--yes` | Accept all prompts (for automation) |
| `--preset <name>` | Stack preset (`worker`, `frontend`, `backend`, `fullstack`) |
| `--detect-only` | Setup mode: detect stack/preset and exit |
| `--no-dependency-sync` | Setup mode: do not rewrite `@stackbilt/cli` devDependency |

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success / pass |
| `1` | Policy violation (CI mode: governance threshold breached) |
| `2` | Runtime / config / usage error |

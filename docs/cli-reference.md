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

**Default range detection:** When `--range` is omitted, Charter tries `main..HEAD` or `master..HEAD` first, then falls back to the most recent 5 commits.

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

Installs git hooks for commit-time governance enforcement.

```bash
npx charter hook install --commit-msg                # trailer normalization hook
npx charter hook install --pre-commit                # ADF evidence gate hook
npx charter hook install --commit-msg --pre-commit   # both hooks
npx charter hook install --commit-msg --force        # overwrite existing hooks
```

- `--commit-msg` — normalizes `Governed-By` and `Resolves-Request` trailers via `git interpret-trailers`
- `--pre-commit` — runs ADF evidence checks (LOC ceiling validation) before each commit. Only gates when `.ai/manifest.adf` exists.
- `--force` — overwrite existing non-Charter hooks

Must specify at least one of `--commit-msg` or `--pre-commit`.

### charter bootstrap

One-command repo onboarding. Orchestrates detect + setup + ADF init + install + doctor in a single flow.

```bash
npx charter bootstrap                                         # interactive
npx charter bootstrap --preset worker --ci github --yes       # fully automated
npx charter bootstrap --skip-install --skip-doctor            # minimal
```

- `--ci github` — generate GitHub Actions governance workflow
- `--preset <worker|frontend|backend|fullstack|docs>` — stack preset
- `--skip-install` — skip dependency installation phase
- `--skip-doctor` — skip health check phase
- `-y, --yes` — accept all prompts

### charter setup

Bootstraps `.charter/` config and optionally writes CI workflow scaffolding. For full onboarding, prefer `charter bootstrap` which orchestrates setup + ADF init + install + doctor.

```bash
npx charter setup --detect-only --format json
npx charter setup --ci github --yes
npx charter setup --preset fullstack --ci github --yes
```

Setup-specific options:

- `--ci github` — generate GitHub Actions governance workflow
- `--preset <worker|frontend|backend|fullstack|docs>` — stack preset
- `--detect-only` — preview detection results without writing files
- `--no-dependency-sync` — skip rewriting `@stackbilt/cli` devDependency

### charter init

Scaffolds the `.charter/` config directory without running the full setup workflow.

```bash
npx charter init
npx charter init --preset worker
```

### charter doctor

Checks CLI installation and repository config health. Validates ADF readiness: manifest existence, manifest parse, default-load module presence, sync lock status, and agent config file migration status.

```bash
npx charter doctor                    # full diagnostics
npx charter doctor --adf-only         # ADF checks only (skip Charter config)
npx charter doctor --ci --format json # CI mode: exit 1 on warnings
```

- `--adf-only` — run only ADF readiness checks, skip Charter config validation
- `--ci` — non-interactive, exits with policy violation code on warnings

### charter why

Prints a quick explanation of Charter's governance value and adoption ROI.

```bash
npx charter why
```

## ADF Commands

ADF (Attention-Directed Format) is Charter's modular AI context compiler. These commands manage the `.ai/` directory.

### charter adf init

Scaffolds `.ai/` directory with preset-aware modules. The scaffolded `core.adf` includes a `[load-bearing]` CONSTRAINTS section and a `METRICS [load-bearing]` section with starter LOC ceilings.

```bash
npx charter adf init
npx charter adf init --ai-dir ./context       # custom directory
npx charter adf init --force                  # overwrite existing
npx charter adf init --emit-pointers          # generate thin pointer files
npx charter adf init --module testing         # add a single module to existing .ai/
```

- `--ai-dir <dir>` — custom directory path (default: `.ai`)
- `--force` / `--yes` — overwrite existing manifest
- `--emit-pointers` — generate thin pointer files (`CLAUDE.md`, `.cursorrules`, `agents.md`)
- `--module <name>` — add a single module to existing `.ai/` (delegates to `adf create`)

**Default scaffolding** (worker/frontend/backend/fullstack presets):

| File | Purpose |
|------|---------|
| `manifest.adf` | Module registry with default-load and on-demand routing |
| `core.adf` | Universal constraints, metrics, and project context |
| `state.adf` | Current session state |
| `frontend.adf` | Frontend module scaffold (triggers: React, CSS, UI) |
| `backend.adf` | Backend module scaffold (triggers: API, Node, DB) |

**Docs preset** (`--preset docs`):

| File | Purpose |
|------|---------|
| `manifest.adf` | Docs-specific module routing |
| `core.adf` | Universal constraints and metrics |
| `state.adf` | Current session state |
| `decisions.adf` | ADR and decision tracking (triggers: ADR, decision, rationale) |
| `planning.adf` | Roadmap and milestone tracking (triggers: plan, milestone, phase, roadmap) |

### charter adf create

Creates a new ADF module file and registers it in the manifest under `DEFAULT_LOAD` or `ON_DEMAND`.

```bash
npx charter adf create api-patterns                           # on-demand module (default)
npx charter adf create core-rules --load default              # default-load module
npx charter adf create react --triggers "react,jsx,component" # on-demand with triggers
npx charter adf create api-patterns --force                   # overwrite existing
```

- `--load <default|on-demand>` — loading policy (default: `on-demand`)
- `--triggers "a,b,c"` — comma-separated trigger keywords (for on-demand modules)
- `--ai-dir <dir>` — path to ADF directory (default: `.ai`)
- `--force` — overwrite existing module file

### charter adf migrate

Scans existing agent config files (`CLAUDE.md`, `.cursorrules`, `agents.md`, `GEMINI.md`, `copilot-instructions.md`), classifies their content, and migrates structured blocks into ADF modules. Replaces originals with thin pointers.

```bash
npx charter adf migrate --dry-run                # preview migration plan
npx charter adf migrate --yes                    # execute migration
npx charter adf migrate --source CLAUDE.md       # migrate a single file
npx charter adf migrate --merge-strategy replace # overwrite existing sections
npx charter adf migrate --no-backup              # skip .pre-adf-migrate.bak files
```

- `--dry-run` — preview changes without writing files
- `--source <file>` — migrate a specific file instead of scanning all
- `--merge-strategy <append|dedupe|replace>` — how to handle duplicates (default: `dedupe`)
- `--no-backup` — skip creating backup files
- `--ai-dir <dir>` — path to ADF directory (default: `.ai`)

### charter adf fmt

Parses and reformats ADF files to canonical form. Enforces emoji decorations, canonical section ordering, and 2-space indent.

```bash
npx charter adf fmt .ai/core.adf --write   # reformat in-place
npx charter adf fmt .ai/core.adf --check   # CI: exit 1 if not canonical
```

### charter adf patch

Applies typed delta operations to ADF files. Agents issue patches instead of rewriting entire files — preventing silent memory corruption.

```bash
npx charter adf patch .ai/state.adf --ops '[{"op":"ADD_BULLET","section":"STATE","value":"Reviewing PR #42"}]'
npx charter adf patch .ai/state.adf --ops-file patches.json
```

**Operations:** `ADD_BULLET`, `REPLACE_BULLET`, `REMOVE_BULLET`, `ADD_SECTION`, `REPLACE_SECTION`, `REMOVE_SECTION`, `UPDATE_METRIC`.

### charter adf bundle

Resolves manifest modules for a given task and outputs merged context with token estimate. Only loads modules whose trigger keywords match the task.

```bash
npx charter adf bundle --task "Fix the React login component"
npx charter adf bundle --task "Add REST endpoint" --format json
```

JSON output includes `triggerMatches` (with `matchedKeywords` and `loadReason`), `unmatchedModules`, `tokenEstimate`, `tokenBudget`, `tokenUtilization`, and `perModuleTokens`.

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

### charter adf metrics recalibrate

Recalibrates metric baselines and ceilings from current measured LOC. Requires a rationale for every recalibration to maintain audit trail.

```bash
npx charter adf metrics recalibrate --auto-rationale                   # auto-generate rationale
npx charter adf metrics recalibrate --reason "post-refactor baseline"  # custom rationale
npx charter adf metrics recalibrate --headroom 20 --dry-run            # preview with 20% headroom
npx charter adf metrics recalibrate --auto-rationale --format json     # machine-readable
```

- `--headroom <percent>` — percentage above current LOC for ceiling calculation (default: `15`, range: 1–200)
- `--reason "<text>"` — required rationale text (mutually exclusive with `--auto-rationale`)
- `--auto-rationale` — auto-generate rationale from headroom and metric count
- `--dry-run` — preview recalibration without writing files
- `--ai-dir <dir>` — custom `.ai/` directory (default: `.ai`)

**Behavior:** Parses all METRICS sections across manifest modules, measures current source file line counts, calculates new ceilings as `ceil(current × (1 + headroom / 100))`, and appends entries to the `BUDGET_RATIONALES` section with format:

```
{metric}_{ISO_DATE}: {old} -> {new}, ceiling {oldCeiling} -> {newCeiling}; {rationale}
```

One of `--reason` or `--auto-rationale` is required.

## Global Flags

| Flag | Effect |
|---|---|
| `--config <path>` | Path to `.charter/` directory (default: `.charter/`) |
| `--format json` | Machine-readable output with stable schemas |
| `--ci` | Non-interactive, deterministic exit codes |
| `--yes` | Accept all prompts (for automation) |
| `--preset <name>` | Stack preset (`worker`, `frontend`, `backend`, `fullstack`, `docs`) |
| `--detect-only` | Setup mode: detect stack/preset and exit |
| `--no-dependency-sync` | Setup mode: do not rewrite `@stackbilt/cli` devDependency |
| `--force` | Overwrite existing files (hooks, ADF modules, config) |

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success / pass |
| `1` | Policy violation (CI mode: governance threshold breached) |
| `2` | Runtime / config / usage error |

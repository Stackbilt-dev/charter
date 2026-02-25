# @stackbilt/cli

CLI entry point for Charter Kit -- a local-first governance toolkit for software repositories. Orchestrates all other `@stackbilt/*` packages to parse commit trailers, score risk, detect blessed-stack drift, and classify change scope. No LLM calls at runtime.

> **This is the only package most users need.** One install gives you the full Charter Kit toolkit.

## Install (Recommended)

```bash
npm install --save-dev @stackbilt/cli
```

If using a pnpm workspace root:

```bash
pnpm add -Dw @stackbilt/cli
```

Use with `npx` in each repository:

```bash
npx charter
npx charter setup --detect-only --format json
npx charter setup --ci github --yes
npx charter doctor --format json
npx charter validate --ci --format json
npx charter drift --ci --format json
npx charter audit --format json
```

Global install is optional if you want `charter` available system-wide:

```bash
npm install -g @stackbilt/cli
```

This pulls in all Charter Kit packages automatically. Use `charter setup` inside each repo to scaffold governance baseline files.
Upgrade existing repos with:

```bash
npm install --save-dev @stackbilt/cli@latest
npx --no-install charter --version
```

For CI pipelines, install as a dev dependency:

```bash
npm install --save-dev @stackbilt/cli
```

Requires Node >= 18.

## Quick Start

```bash
charter                # quick value/risk snapshot + next action
charter why            # why teams adopt Charter and expected payoff
charter setup          # bootstrap .charter/ directory + policy baseline
charter doctor         # check CLI + config health
charter validate       # validate commit governance trailers
charter drift          # scan for blessed-stack drift
charter audit          # generate governance audit report
charter classify "migrate auth provider"
charter hook install --commit-msg
charter adf init             # scaffold .ai/ context directory
charter adf fmt .ai/core.adf # reformat ADF to canonical form
charter adf bundle --task "fix React component"
charter adf sync --check     # verify .adf files match locked hashes
charter adf evidence --auto-measure --format json  # validate metric ceilings
```

## Human Onboarding (Copy/Paste)

Run this in the target repository:

```bash
npm install -g @stackbilt/cli
charter
charter setup --ci github
charter classify "describe the planned change"
charter doctor --format json
charter validate --format text
charter drift --format text
charter audit --format text
```

This ensures people immediately see:
- what Charter is doing in their repo
- where baseline files were created (`.charter/*`)
- how policy checks behave before merge

## LM Agent Onboarding (Deterministic)

Use JSON output and explicit CI semantics:

```bash
charter --format json
charter setup --ci github --yes --format json
charter setup --ci github --yes --no-dependency-sync --format json
charter doctor --format json
charter validate --format json --ci
charter drift --format json --ci
charter audit --format json
```

Agent handling contract:
- `exit 0`: pass
- `exit 1`: policy violation (action required)
- `exit 2`: runtime/usage failure

Agent decision rules:
- If `mixedStack: true`, use `--preset fullstack`.
- If framework signals look wrong, inspect `detected.sources` and rerun setup with an explicit `--preset`.
- Treat `validate --ci` and `drift --ci` as blocking checks.
- `validate` and `audit` both report commit range explicitly so coverage numbers are comparable.
- Use `validate.evidence.policyOffenders` for strict-trailer failures and `validate.evidence.riskOffenders` for threshold-based risk failures.
- `policyOffenders` are policy-context entries (not risk-rule findings); risk metadata is attached to `riskOffenders`.
- `validate.effectiveRangeSource` and `validate.defaultCommitRange` make implicit range behavior explicit for agents.

## LM Agent Ops Flow

```bash
# install in target repo
npm install --save-dev @stackbilt/cli@latest

# setup
npx charter setup --detect-only --format json
npx charter setup --ci github --yes --format json
npx charter classify "describe the planned change" --format json

# enforce on PR/build
npx charter validate --ci --format json
npx charter drift --ci --format json
npx charter audit --format json

# ADF context management
npx charter adf evidence --auto-measure --format json --ci
npx charter adf sync --check --format json

# recurring maintenance
npx charter doctor --format json
npx charter audit --format json
```

## Commands

### `charter` (no args)

Default first-run experience. Shows:
- repository governance baseline status
- commit governance coverage snapshot
- high-risk unlinked commit count
- one recommended next action

### `charter why`

Explains the adoption case in plain terms (problem, what Charter enforces, expected operational payoff).

### `charter setup`

Bootstrap `.charter/` with config, patterns, and policies. Optionally generates a GitHub Actions workflow.
This is the command that applies Charter governance into a repository.

```bash
charter setup --ci github --yes
charter setup --detect-only
charter setup --preset frontend
```

For mixed repos (for example Worker backend + React frontend under `client/`), prefer:

```bash
charter setup --detect-only
charter setup --preset fullstack --ci github --yes
```

Detection output includes `detected.sources` in JSON mode so agents can verify which manifests were scanned before applying a baseline.
Setup also adds optional root scripts when missing: `charter:detect` and `charter:setup`.
Setup JSON now includes `mutationPlan` and `appliedMutations` so side effects are explicit before/after apply.
Setup baseline mutation metadata now includes `configHashBefore`, `configHashAfter`, and `writesPerformed`.

### `charter init`

Scaffold `.charter/` config templates only. Supports `--preset worker|frontend|backend|fullstack`.

### `charter doctor`

Validate CLI installation, `.charter/` config, and ADF readiness (manifest existence, module parseability, sync lock status).

### `charter validate`

Validate git commits for `Governed-By` and `Resolves-Request` trailers.

```bash
charter validate --ci --format json
charter validate --range HEAD~10..HEAD --format json
```

When `--range` is omitted, JSON includes `effectiveRangeSource` and `defaultCommitRange` so automation can trace default selection behavior.

Trailer formatting requirement:
- Governance trailers must be in one contiguous trailer block at the end of the commit message.
- A blank line inside the trailer section can make governance trailers unparsable by git trailer rules.

Valid:

```text
feat: ship governance checks

Governed-By: ADR-012
Resolves-Request: REQ-078
Co-Authored-By: Dev <dev@example.com>
```

Invalid (blank line splits the trailer block):

```text
feat: ship governance checks

Governed-By: ADR-012
Resolves-Request: REQ-078

Co-Authored-By: Dev <dev@example.com>
```

### `charter drift`

Scan files against blessed-stack patterns in `.charter/patterns/*.json`.

```bash
charter drift --path ./src --ci
```

JSON output includes `patternsCustomized` when pattern files declare customization metadata.

### `charter audit`

Generate a governance audit report covering trailers, risk, drift, and policy-section coverage quality.
Use `--range <revset>` to audit the same commit window used by validation in reviews.

If score is held down by trailer coverage, enforce `validate --ci` in PR checks and add commit-template guidance for required trailers.
Audit output includes whether preset pattern files are still uncustomized when metadata is present.

### `charter classify`

Classify a change as `SURFACE`, `LOCAL`, or `CROSS_CUTTING`.

```bash
charter classify "update button color"
```

### `charter hook`

Install git hooks for commit-time trailer ergonomics.

```bash
charter hook install --commit-msg
```

`--force` (or global `--yes`) allows overwrite when a non-Charter `commit-msg` hook already exists.

### `charter adf`

ADF (Attention-Directed Format) context management. Replaces monolithic `.cursorrules`/`claude.md` files with a modular, AST-backed `.ai/` directory.

```bash
charter adf init [--ai-dir <dir>] [--force]
charter adf fmt <file> [--check] [--write]
charter adf patch <file> --ops '<json>' | --ops-file <path>
charter adf bundle --task "Fix React component" [--ai-dir <dir>]
charter adf sync --check [--ai-dir <dir>]
charter adf sync --write [--ai-dir <dir>]
charter adf evidence [--task "<prompt>"] [--ai-dir <dir>] [--auto-measure]
                     [--context '{"key": value}'] [--context-file <path>]
```

- `init`: Scaffold `.ai/` with `manifest.adf`, `core.adf`, and `state.adf`. Core module includes a 500-line LOC guardrail metric by default.
- `fmt`: Parse and reformat to canonical ADF. `--check` exits 1 if not canonical. `--write` reformats in place. Default prints to stdout.
- `patch`: Apply typed delta operations (ADD_BULLET, REPLACE_BULLET, REMOVE_BULLET, ADD_SECTION, REPLACE_SECTION, REMOVE_SECTION, UPDATE_METRIC). Accepts `--ops <json>` inline or `--ops-file <path>` from a file.
- `bundle`: Read `manifest.adf`, resolve ON_DEMAND modules via keyword matching against the task, and output merged context with token estimate, trigger observability (matched keywords, load reasons), unmatched modules, and advisory-only warnings.
- `sync --check`: Verify source `.adf` files match their locked hashes. Exits 1 if any source has drifted since last sync.
- `sync --write`: Update `.adf.lock` with current source hashes.
- `evidence`: Validate all metric ceilings in the merged document and produce a structured pass/fail evidence report. `--auto-measure` counts lines in files referenced by the manifest METRICS section. `--context` or `--context-file` inject external metric overrides that take precedence over auto-measured and document values. In `--ci` mode, exits 1 on constraint failures (warnings don't fail).

## Global Options

| Option | Description | Default |
|---|---|---|
| `--config <path>` | Path to `.charter/` directory | `.charter/` |
| `--format <mode>` | Output: `text` or `json` | `text` |
| `--ci` | CI mode: exit non-zero on WARN or FAIL | off |
| `--yes` | Auto-accept safe setup overwrites | off |

Setup-only options:
- `--preset <worker|frontend|backend|fullstack>`: override auto-detected preset
- `--detect-only`: print stack detection result and selected preset without writing files
- `--no-dependency-sync`: skip rewriting `devDependencies["@stackbilt/cli"]` during setup

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Policy violation (CI mode) |
| 2 | Runtime or usage error |

## Related Packages

- `@stackbilt/types` -- shared enums and interfaces
- `@stackbilt/core` -- Zod schemas and sanitization helpers
- `@stackbilt/git` -- trailer parsing and commit risk assessment
- `@stackbilt/classify` -- heuristic change classification
- `@stackbilt/drift` -- blessed-stack pattern drift detection
- `@stackbilt/validate` -- citation validation and intent classification
- `@stackbilt/adf` -- ADF parser, formatter, patcher, and bundler
- `@stackbilt/ci` -- GitHub Actions integration helpers

## License

Apache-2.0

## Repository

[https://github.com/Stackbilt-dev/charter](https://github.com/Stackbilt-dev/charter)

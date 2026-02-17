# @stackbilt/cli

CLI entry point for Charter Kit -- a local-first governance toolkit for software repositories. Orchestrates all other `@stackbilt/*` packages to parse commit trailers, score risk, detect blessed-stack drift, and classify change scope. No LLM calls at runtime.

> **This is the only package most users need.** One install gives you the full Charter Kit toolkit.

## Install (Recommended)

```bash
npm install --save-dev @stackbilt/cli
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
npx charter --version
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
```

## Human Onboarding (Copy/Paste)

Run this in the target repository:

```bash
npm install -g @stackbilt/cli
charter
charter setup --ci github
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

## LM Agent Ops Flow

```bash
# install in target repo
npm install --save-dev @stackbilt/cli@latest

# setup
npx charter setup --detect-only --format json
npx charter setup --ci github --yes --format json

# enforce on PR/build
npx charter validate --ci --format json
npx charter drift --ci --format json
npx charter audit --format json

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

### `charter init`

Scaffold `.charter/` config templates only. Supports `--preset worker|frontend|backend|fullstack`.

### `charter doctor`

Validate CLI installation and `.charter/` config.

### `charter validate`

Validate git commits for `Governed-By` and `Resolves-Request` trailers.

```bash
charter validate --ci --format json
charter validate --range HEAD~10..HEAD --format json
```

### `charter drift`

Scan files against blessed-stack patterns in `.charter/patterns/*.json`.

```bash
charter drift --path ./src --ci
```

### `charter audit`

Generate a governance audit report covering trailers, risk, drift, and policy-section coverage quality.
Use `--range <revset>` to audit the same commit window used by validation in reviews.

If score is held down by trailer coverage, enforce `validate --ci` in PR checks and add commit-template guidance for required trailers.

### `charter classify`

Classify a change as `SURFACE`, `LOCAL`, or `CROSS_CUTTING`.

```bash
charter classify "update button color"
```

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
- `@stackbilt/ci` -- GitHub Actions integration helpers

## License

Apache-2.0

## Repository

[https://github.com/Stackbilt-dev/charter](https://github.com/Stackbilt-dev/charter)

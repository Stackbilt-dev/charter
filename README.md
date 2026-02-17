# Charter Kit

Charter is a local-first governance toolkit for software repos. It works in both terminal-first human workflows and deterministic CI/agent workflows.

## Install And Adopt (Start Here)

Recommended for most repos (local install):

```bash
npm install --save-dev @stackbilt/cli
npx charter
npx charter setup --detect-only --format json
npx charter setup --ci github --yes
npx charter doctor --format json
npx charter validate --ci --format json
npx charter drift --ci --format json
npx charter audit --format json
```

Global install is optional if you want `charter` on your PATH:

```bash
npm install -g @stackbilt/cli
charter
charter setup --detect-only --format json
charter setup --ci github --yes
```

`setup` is what applies the governance baseline into the current repo (`.charter/*` and optional workflow).
Use `charter setup --detect-only` to preview detected stack and selected preset without writing files, including `detected.sources` so users and agents can verify what was scanned.
For mixed repos (frontend + backend/worker), run detect-only first, then choose preset intentionally:

```bash
charter setup --detect-only
charter setup --preset fullstack --ci github --yes
```

`setup` also adds optional root `package.json` scripts when missing:
- `charter:detect`
- `charter:setup`
Setup JSON includes `mutationPlan` and `appliedMutations` so agents can see planned/applied deltas.
Use `--no-dependency-sync` if you want setup to avoid rewriting `devDependencies["@stackbilt/cli"]`.
Baseline mutation metadata includes `configHashBefore`, `configHashAfter`, and `writesPerformed` for auditable idempotency checks.

Upgrade path in existing repos:

```bash
npm install --save-dev @stackbilt/cli@latest
npx charter --version
```

## Why Charter

- Validate governance trailers like `Governed-By` and `Resolves-Request`
- Score commit risk and flag high-risk ungoverned changes
- Detect stack drift against blessed patterns
- Classify change scope as `SURFACE`, `LOCAL`, or `CROSS_CUTTING`
- Produce stable JSON output for automation
- Make governance purpose obvious on first run with a repo risk/value snapshot

## Choose Your Path

### Human Path (Local Text Output)

```bash
pnpm install
pnpm run build
node packages/cli/dist/bin.js
node packages/cli/dist/bin.js why
node packages/cli/dist/bin.js setup --yes
node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js validate
node packages/cli/dist/bin.js drift
node packages/cli/dist/bin.js audit
```

### CI/Agent Path (Deterministic JSON)

```bash
pnpm install
pnpm run build
node packages/cli/dist/bin.js --format json
node packages/cli/dist/bin.js setup --ci github --yes
node packages/cli/dist/bin.js doctor --format json --ci
node packages/cli/dist/bin.js validate --format json --ci
node packages/cli/dist/bin.js drift --format json --ci
node packages/cli/dist/bin.js audit --format json --ci
```

## Human Onboarding (Copy/Paste)

For someone new to governance tooling, use this exact sequence inside the target repo:

```bash
npm install -g @stackbilt/cli
charter
charter setup --ci github
charter doctor --format json
charter validate --format text
charter drift --format text
charter audit --format text
```

What they should understand after this:
- Charter is now installed for this repo (`.charter/*` exists)
- CI can block risky, ungoverned changes (`.github/workflows/charter-governance.yml`)
- They can see current governance posture immediately (`validate`, `drift`, `audit`)

## LM Agent Onboarding (Deterministic Path)

For agent integrations, prefer JSON mode and exit-code handling:

```bash
charter --format json
charter setup --ci github --yes --format json
charter doctor --format json
charter validate --format json --ci
charter drift --format json --ci
charter audit --format json
```

Agent contract:
- Inputs: git repo + optional existing `.charter/`
- Stable machine output: `--format json`
- Exit codes: `0` success, `1` policy violation, `2` runtime/usage error
- CI behavior: with `--ci`, treat `1` as gating failure and surface actionable remediation

## LM Agent Runbook (Install To Maintenance)

Use this deterministic flow in agent-driven repos:

```bash
# install (repo-local)
npm install --save-dev @stackbilt/cli@latest

# detect + apply baseline
npx charter setup --detect-only --format json
npx charter setup --ci github --yes --format json

# pre-merge / CI gates
npx charter validate --ci --format json
npx charter drift --ci --format json
npx charter audit --format json

# maintenance loop (scheduled or pre-release)
npx charter doctor --format json
npx charter audit --format json
```

Decision rules for agents:
- If `setup --detect-only` reports `mixedStack: true`, apply `--preset fullstack`.
- If detection looks incomplete, inspect `detected.sources` before setup.
- Treat `validate` and `drift` with `--ci` as merge gates.
- In `validate` JSON, use `evidence.policyOffenders` for strict trailer policy failures and `evidence.riskOffenders` for threshold-risk failures.
- Treat `policyOffenders` as compliance findings and `riskOffenders` as risk-threshold findings.

## Trailer Adoption Ramp

Teams often score lower early due to missing governance trailers. Use this ramp:
- Stage 1: run `charter validate --ci --format json` in PR CI and fail on policy violations.
- Stage 2: add a commit template in the repo that includes `Governed-By` and `Resolves-Request`.
- Stage 3: track audit trend; trailer coverage should rise naturally as PR gating normalizes behavior.

## Command Reference

- `charter`: show repo risk/value snapshot and recommended next action
- `charter setup [--ci github] [--preset <worker|frontend|backend|fullstack>] [--detect-only] [--no-dependency-sync]`: detect stack and scaffold `.charter/` baseline
- `charter init [--preset <worker|frontend|backend|fullstack>]`: scaffold `.charter/` templates only
- `charter doctor`: validate environment/config state
- `charter validate [--ci] [--range <revset>]`: validate commit governance and citations
- `charter drift [--path <dir>] [--ci]`: run drift scan
- `charter audit [--ci] [--range <revset>]`: produce governance audit summary
- `charter classify <subject>`: classify change scope heuristically
- `charter why`: explain adoption rationale and expected payoff

Global options: `--config <path>`, `--format text|json`, `--ci`, `--yes`.

Audit policy scoring note:
- Policy score now uses configurable section coverage (`config.audit.policyCoverage.requiredSections`) instead of raw markdown file count.

## Exit Code Contract

- `0`: success/pass
- `1`: policy violation in CI mode
- `2`: runtime/config/usage error

## CI Integration

- Reusable template in this repo: `.github/workflows/governance.yml`
- Generated in target repos by `charter setup --ci github`: `.github/workflows/charter-governance.yml`

## Workspace Layout

```text
packages/
  types/      Shared contracts
  core/       Schemas, sanitization, errors
  git/        Trailer parsing and risk scoring
  classify/   Heuristic classification
  validate/   Governance validation
  drift/      Pattern drift scanning
  cli/        `charter` command
  ci/         GitHub Actions integration helpers
```

## Development

- `pnpm run clean`
- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run test`

## Release Docs

- `PUBLISHING.md`: first release/publish workflow
- `CHANGELOG.md`: user-visible change history
- `CONTRIBUTING.md`: contribution conventions
- `SECURITY.md`: vulnerability reporting

## License

Apache-2.0. See `LICENSE`.

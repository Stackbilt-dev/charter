# Charter Kit

Repo-adoptable governance checks for any project. Charter runs locally and in CI with no cloud dependency, and supports both human and LM-agent workflows.

## What It Does

- Validates governance trailers (`Governed-By`, `Resolves-Request`) on commits
- Scores commit risk and flags unlinked high-risk changes
- Scans for drift against blessed stack patterns
- Classifies change scope as `SURFACE`, `LOCAL`, or `CROSS_CUTTING`
- Emits deterministic JSON for automation and agent integration

## Workspace Layout

```text
packages/
  types/      Shared contracts
  core/       Schemas, sanitization, errors
  git/        Trailer parsing and risk scoring
  classify/   Heuristic change classification
  validate/   Citation and governance validation
  drift/      Pattern drift scanning
  cli/        `charter` command
  ci/         GitHub Actions integration helpers
```

## Quickstart (Local)

```bash
pnpm install
pnpm run build
node packages/cli/dist/bin.js setup --ci github
```

Then run checks:

```bash
node packages/cli/dist/bin.js doctor --format json
node packages/cli/dist/bin.js validate --format text
node packages/cli/dist/bin.js drift --format text
node packages/cli/dist/bin.js audit --format json
```

## CLI Commands

- `charter setup [--ci github]`: bootstrap `.charter/` and optional GitHub workflow
- `charter init`: scaffold `.charter/` templates only
- `charter doctor`: environment/config health check
- `charter validate [--ci]`: validate commit governance
- `charter drift [--path <dir>] [--ci]`: run drift scan
- `charter audit [--ci]`: generate governance audit
- `charter classify <subject>`: classify change scope

Global options: `--config <path>`, `--format text|json`, `--ci`, `--yes`.

## Human Mode vs Agent Mode

- Human mode: default text output with remediation hints.
- Agent mode: use `--format json --ci` for stable structured output + deterministic exit codes.

Exit codes:
- `0`: pass/success
- `1`: policy violation in CI mode (`WARN`/`FAIL` threshold reached)
- `2`: runtime/config/usage error

## Development

- `pnpm run build`: build all packages
- `pnpm run typecheck`: strict type-check across workspace
- `pnpm run clean`: remove build outputs and TypeScript build state

## CI Integration

- Template workflow in this repo: `.github/workflows/governance.yml`
- Auto-generated per-target-repo workflow: `.github/workflows/charter-governance.yml` via `charter setup --ci github`

## Contributing and Security

See `CONTRIBUTING.md` for contribution standards and commit format. Report vulnerabilities via `SECURITY.md`.

## Additional Docs

- `AGENTS.md`: contributor/agent repository guidelines
- `TESTPLAN.md`: pre-release and regression test matrix
- `PUBLISHING.md`: npm release process and rollback steps
- `CHANGELOG.md`: release history and user-visible changes
- `HANDOFF_LM.md`: implementation handoff for collaborating LM teams

## License

Apache-2.0. See `LICENSE`.

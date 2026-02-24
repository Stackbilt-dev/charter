# Contributing to Charter Kit

Thanks for contributing. This repo is a PNPM workspace for offline governance tooling.

## Development Setup

```bash
git clone https://github.com/stackbilt-dev/charter-kit.git
cd charter-kit
pnpm install
pnpm run build
```

## Project Structure

```text
packages/
  types/      Shared TypeScript contracts
  core/       Schemas, sanitization, shared errors
  adf/        ADF parser, formatter, patcher, bundler (AI context format)
  git/        Git trailer parsing and risk scoring
  classify/   Heuristic change classification
  validate/   Citation and governance validation
  drift/      Anti-pattern drift scanning
  cli/        CLI tool (`charter`)
  ci/         GitHub Actions integration helpers
```

## Local Validation Before PR

Run these from the repo root:

```bash
pnpm run typecheck
pnpm run build
node packages/cli/dist/bin.js doctor --format json
```

If you changed CLI behavior, include at least one command sample in your PR body.

## Commit and PR Standards

Use Conventional Commits:

- `feat(git): add support for custom trailer names`
- `fix(drift): handle empty anti-pattern strings`
- `docs: update CLI usage examples`

PR checklist:

1. Keep scope focused (single concern per PR)
2. Describe what changed and why
3. Link related issue(s)
4. Include command output/screenshots for behavior changes
5. Confirm `pnpm run build` passes
6. If CLI UX or setup behavior changes, update `README.md`, `packages/cli/README.md`, and `CHANGELOG.md` in the same PR

## Code Standards

- TypeScript `strict: true` across all packages
- No runtime dependency on cloud services
- Pure functions preferred; side effects in CLI command handlers only
- No LLM API calls in this kit (heuristic-only runtime)

## What Belongs Here vs CSA Cloud

Belongs here:
- Heuristic classifiers and validators
- Schema definitions and validation
- Git integration logic
- ADF context format parsing, formatting, and patching
- CLI commands and local config parsing

Stays in CSA Cloud:
- LLM-powered analysis
- Database operations and multi-tenant runtime features
- AuthN/AuthZ and hosted frontend concerns

## Reporting Issues

Use GitHub Issues for bugs/features. Include Node.js version, OS, and `charter --version` output.
For security issues, follow `SECURITY.md`.

## License

By contributing, you agree that contributions are licensed under Apache License 2.0.

# Repository Guidelines

## Project Structure & Module Organization
This repository is a PNPM workspace for the Charter governance kit. Core code lives in `packages/*`; each package compiles from `src/` to `dist/`.

- `packages/types`: shared TypeScript contracts
- `packages/core`: schemas, sanitization, shared errors
- `packages/git`: git trailer parsing and risk scoring
- `packages/classify`, `packages/validate`, `packages/drift`: governance analysis logic
- `packages/cli`: `charter` command and subcommands in `src/commands/`
- `packages/ci`: GitHub Actions integration helpers
- `.github/workflows/governance.yml`: reusable CI workflow template

## Build, Test, and Development Commands
Run from the repository root.

- `pnpm install`: install workspace dependencies
- `pnpm run build`: compile all packages with project references
- `pnpm run typecheck`: strict type-check without emit
- `pnpm run clean`: remove `dist/` folders and `tsconfig.tsbuildinfo`
- `pnpm --filter @charter/cli build`: compile only the CLI package

Example local run: `node packages/cli/dist/bin.js doctor --format json`.

## Coding Style & Naming Conventions
Use TypeScript strict mode (`tsconfig.base.json`). Follow existing style:

- 2-space indentation, semicolons, single quotes
- Prefer pure functions; keep side effects in CLI command handlers
- File names use kebab-case (for example `message-classifier.ts`)
- Keep package boundaries explicit and import via `@charter/*`

No formatter/linter is currently enforced; match surrounding code style.

## Testing Guidelines
No dedicated test framework is configured yet.

- Treat `pnpm run typecheck` and `pnpm run build` as required validation gates
- Validate behavior with CLI commands (`setup`, `doctor`, `validate`, `drift`, `audit`)
- When adding new behavior, include deterministic JSON output samples in PRs

## Commit & Pull Request Guidelines
Use Conventional Commits as documented in `CONTRIBUTING.md`:

- `feat(git): add support for custom trailer names`
- `fix(drift): handle empty anti-pattern strings`
- `docs: update CLI usage examples`

PR expectations:

- Branch from `main` and keep scope focused
- Explain what changed, why, and affected packages
- Link related issues
- Include command output/screenshots when behavior changes
- Ensure `pnpm run build` passes before review

## Mandatory Commit Workflow
- ALWAYS use `scripts/smart-commit.sh` for commits.
- NEVER run raw `git add`, `git commit`, or ad-hoc staging/commit commands for normal workflow commits.
- Use `scripts/smart-commit.sh --dry-run` first to preview grouped commits and confirm whitespace-only diffs are excluded.
- The workflow enforces `.githooks/pre-commit`, which runs `pnpm exec tsc --noEmit` and blocks commits on type errors.

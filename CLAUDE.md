# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Hygiene

- ALWAYS use `scripts/smart-commit.sh` for commits.
- NEVER use raw `git add`/`git commit` for normal workflow commits.
- Run `scripts/smart-commit.sh --dry-run` first to preview grouped commits and verify whitespace-only changes are filtered out.
- Never stage line-ending or whitespace-only changes. The smart-commit workflow filters them automatically.
- Always check git identity is configured (`git config user.name` / `git config user.email`) before making commits.
- When in WSL, use `git config --global credential.helper '/mnt/c/Program Files/Git/mingw64/bin/git-credential-manager.exe'` if HTTPS push fails.
- Keep `core.hooksPath` pointed to `.githooks` so the pre-commit check (`pnpm exec tsc --noEmit`) always runs.

## Build & Development Commands

```bash
pnpm install                          # Install workspace dependencies
pnpm run build                        # Compile all packages (TypeScript project references)
pnpm run typecheck                    # Strict type-check without emit
pnpm run clean                        # Remove dist/ and tsbuildinfo files
pnpm --filter @charter/<pkg> build    # Build a single package (e.g. @charter/cli)
node packages/cli/dist/bin.js <cmd>   # Run CLI locally after build
```

Validation gates are `pnpm run typecheck`, `pnpm run build`, and `pnpm run test`. Verify behavior changes by running CLI commands with `--format json`.

## TypeScript Build Commands

- Use `pnpm exec tsc` instead of `npx tsc` for type-checking in this monorepo (npx has PATH issues in WSL).
- Pre-existing build errors should be noted but not blocked on — flag them and continue with the task.

## Architecture

Charter Kit is a PNPM monorepo providing offline governance checks for git repos. It parses commit trailers (`Governed-By`, `Resolves-Request`), scores risk, detects drift from blessed-stack patterns, and classifies change scope — all heuristic-based with no LLM calls at runtime.

**Package dependency flow:**
```
types (no deps) ← git, classify, validate, drift, ci ← cli (orchestrates all)
                ← core (zod schemas)
```

- **types**: Enums (`ChangeClass`, `CommitRiskLevel`, `ValidationStatus`, `PatternStatus`) and interfaces — the shared data model
- **core**: Zod schemas and `sanitizeInput`/`sanitizeErrorMessage` helpers
- **git**: `parseTrailersFromMessage()`, `assessCommitRisk()` with HIGH/MEDIUM/LOW risk path patterns
- **classify**: `heuristicClassify()` — pattern-matches subjects against SURFACE/CROSS_CUTTING patterns, returns class + confidence
- **drift**: `scanForDrift()` — loads patterns from `.charter/patterns/*.json`, matches anti-patterns (regex or keyword) against file contents
- **validate**: Citation validation and message intent classification
- **cli**: Command handlers in `src/commands/`, config loading in `src/config.ts`

**Exit codes:** 0 = success, 1 = policy violation (CI mode), 2 = runtime/usage error.

## Key Conventions

- TypeScript strict mode, ES2022 target, CommonJS output
- 2-space indent, semicolons, single quotes, kebab-case filenames
- Pure functions in library packages; side effects only in CLI command handlers
- Import across packages via `@charter/*` aliases (defined in `tsconfig.base.json`)
- Conventional Commits: `feat(git):`, `fix(drift):`, `docs:`, `chore(types):`
- All commands support `--format json` for stable machine-readable output

## Config Structure

The `.charter/` directory holds project governance config:
- `config.json`: Project settings (trailer requirements, drift thresholds, CI behavior)
- `patterns/*.json`: Blessed-stack definitions with anti-patterns (regex/keyword)
- `policies/*.md`: Human-readable governance docs

## Task Execution Style

- Bias toward action over clarification. If the task is reasonably clear, start implementing rather than asking multiple clarifying questions.
- When fixing visual/UI bugs, verify the fix addresses root cause (e.g., transform context, overflow model) before presenting it — avoid multi-iteration guess-and-check.

# CLAUDE.md

> **DO NOT add rules, constraints, or context to this file.**
> This file is auto-managed by Charter. All project rules live in `.ai/`.
> New rules should be added to the appropriate `.ai/*.adf` module.
> See `.ai/manifest.adf` for the module routing manifest.

## Session Start

Call `charter_context` (MCP tool) before any other action. It returns the live constraint surface — open work, recent decisions, and metric ceilings — so you act within current project state rather than reconstructing it from scratch.

If `charter serve` is not running, read `.ai/context.snapshot.json` directly or run `charter context-refresh` to generate it.

## Environment

- When in WSL, use `git config --global credential.helper '/mnt/c/Program Files/Git/mingw64/bin/git-credential-manager.exe'` if HTTPS push fails.
- Keep `core.hooksPath` pointed to `.githooks` so the pre-commit check runs.
- Pre-existing build errors should be noted but not blocked on -- flag them and continue with the task.

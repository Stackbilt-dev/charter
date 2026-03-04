# CLAUDE.md

> This project uses [ADF](https://github.com/Stackbilt-dev/charter) for AI agent context management.
> All stack rules, constraints, and architectural guidance live in `.ai/`.
> **Do not duplicate ADF rules here.** Only pre-ADF bootstrap content belongs in this file.

See `.ai/manifest.adf` for the module routing manifest.

## Environment

- When in WSL, use `git config --global credential.helper '/mnt/c/Program Files/Git/mingw64/bin/git-credential-manager.exe'` if HTTPS push fails.
- Keep `core.hooksPath` pointed to `.githooks` so the pre-commit check runs.
- Pre-existing build errors should be noted but not blocked on -- flag them and continue with the task.

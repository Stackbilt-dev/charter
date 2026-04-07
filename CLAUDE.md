# CLAUDE.md

> **DO NOT add rules, constraints, or context to this file.**
> This file is auto-managed by Charter. All project rules live in `.ai/`.
> New rules should be added to the appropriate `.ai/*.adf` module.
> See `.ai/manifest.adf` for the module routing manifest.

## Environment

- When in WSL, use `git config --global credential.helper '/mnt/c/Program Files/Git/mingw64/bin/git-credential-manager.exe'` if HTTPS push fails.
- Keep `core.hooksPath` pointed to `.githooks` so the pre-commit check runs.
- Pre-existing build errors should be noted but not blocked on -- flag them and continue with the task.

## OSS Policy

This is a **public infrastructure package** governed by the Stackbilt OSS Infrastructure Package Update Policy.

Rules:
1. **Additive only** — never remove or rename public API without a major version bump
2. **No product logic** — framework patterns and generic utilities only. If a competitor could reconstruct Stackbilt product architecture from this code, it doesn't belong here.
3. **Strict semver** — patch for fixes, minor for new features, major for breaking changes
4. **Tests travel with code** — every public export must have test coverage
5. **Validate at boundaries** — all external API responses validated before returning to consumers

Full policy: `stackbilt_llc/policies/oss-infrastructure-update-policy.md`

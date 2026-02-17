# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and follows Semantic Versioning.

## [Unreleased]

### Added
- `validate` JSON output now includes an evidence block with offending commit details (`sha`, `riskLevel`, `riskReason`, `missingTrailers`).
- `setup --detect-only` now surfaces runtime ambiguity warnings when multiple runtime families are detected without a clear stack split.

### Changed
- `setup` now synchronizes `package.json` onboarding scripts to the selected preset (`charter:setup`) instead of only adding missing entries.

### Fixed
- `audit --range` now fails with a runtime error on invalid git revspecs (matching `validate` semantics) instead of silently returning zero commits.
- `validate` text output now includes offending short SHAs for faster remediation loops.

### Security
- Placeholder for unreleased security updates.

## [0.1.14] - 2026-02-17

### Added
- Documentation runbook updates for mixed-stack setup decision flow and LM-agent decision rules.
- `setup` now adds optional onboarding scripts to root `package.json` when missing: `charter:detect` and `charter:setup`.
- `validate` and `audit` now include explicit commit range in output for easier score interpretation.

### Changed
- Root and CLI README now lead with detect-first setup (`setup --detect-only`) and explicit CI gating commands (`validate/drift --ci`).
- Publishing guide now verifies `detected.sources` in setup detection output and includes drift/audit checks in post-publish validation.
- Generated GitHub workflow from `setup --ci github` now installs a pinned CLI version for reproducible CI behavior.
- Default baseline config now enforces stricter trailer policy (`validation.citationStrictness: "FAIL"`).

## [0.1.13] - 2026-02-17

### Added
- `setup --detect-only --format json` now includes `detected.sources` listing which `package.json` files were used for detection.

### Changed
- Stack detection now merges dependencies from root and nested manifests (`client/`, `frontend/`, `web/`, `apps/*/`), improving React/Vite signal detection in mixed repos.

## [0.1.12] - 2026-02-17

### Added
- Mixed-stack setup guidance now appears directly in `setup --detect-only` and setup completion output.
- Framework-aware baseline specialization for detected Cloudflare, Hono, and React/Vite signals.

### Changed
- Auto-detection now prioritizes `fullstack` for mixed frontend + backend/worker repositories.
- Setup now uses repo path signals (for example `client/`, `apps/web`) to improve mixed-stack inference.
- Docs now recommend detect-first + explicit fullstack preset for mixed repos.

## [0.1.11] - 2026-02-17

### Added
- `setup` stack auto-detection with preset selection (`worker|frontend|backend|fullstack`) and `--detect-only` preview mode.
- Configurable policy coverage checklist in `.charter/config.json` under `audit.policyCoverage.requiredSections`.

### Changed
- `setup` now scaffolds richer preset-based baseline patterns and infers project name from local `package.json` (fallback: directory name).
- `audit` policy score now uses required section coverage instead of markdown file count.
- Root and CLI docs updated with preset and detection guidance.

### Fixed
- Policy scoring now rewards governance coverage quality over policy-file quantity.

## [0.1.10] - 2026-02-17

### Changed
- Root and CLI README install guidance now leads with local repo install (`npm i -D @stackbilt/cli` + `npx charter`) and keeps global install as optional.
- Audit output now includes explicit scoring formulas and actionable remediation steps for trailer coverage, pattern definitions, and policy docs.

### Fixed
- `charter validate` now returns runtime error (`exit 2`) when git commit loading fails (for example invalid revision/range), instead of incorrectly returning PASS.
- Validation output now distinguishes true "no commits" from internal git failures.

## [0.1.9] - 2026-02-17

### Changed
- Synchronized all published `@stackbilt/*` packages to version `0.1.9` with aligned internal dependency ranges.

## [0.1.8] - 2026-02-17

### Added
- New first-run UX: `charter` now prints a governance value/risk snapshot with a single recommended next action.
- New `charter why` command to explain adoption rationale and expected operational payoff.

### Changed
- `setup` command output rewritten to focus on concrete outcomes (guardrails active, CI policy gate, immediate follow-up commands).
- CLI and root docs updated for human and agent onboarding paths.

## [0.1.6] - 2026-02-17

### Fixed
- Cross-platform git invocation in `validate` and `audit` (removed shell-specific quoting/redirection issues on Windows).
- `charter validate` and `charter audit` no longer emit `%an`/shell noise on Windows.

## [0.1.5] - 2026-02-17

### Fixed
- `charter --version` now reports package version dynamically instead of a hardcoded value.

## [0.1.4] - 2026-02-17

### Fixed
- Replaced published internal dependency references from `workspace:*` to semver ranges so npm consumers can install successfully.
- Published patched internal package dependency chain used by CLI.

## [0.1.0] - 2026-02-16

### Added
- Initial Charter Kit workspace with modular `@stackbilt/*` packages.
- CLI command surface: `init`, `validate`, `drift`, `audit`, `classify`.
- Governance workflow template in `.github/workflows/governance.yml`.

### Changed
- Introduced seamless CLI setup with `setup` and diagnostics via `doctor`.
- Standardized command exit-code contract for human and LM-agent workflows.
- Improved cross-platform build scripts and docs for public contribution.

### Security
- Added repository security policy and reporting process.

[Unreleased]: https://github.com/stackbilt-dev/charter-kit/compare/v0.1.14...HEAD
[0.1.14]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.14
[0.1.13]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.13
[0.1.12]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.12
[0.1.11]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.11
[0.1.10]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.10
[0.1.9]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.9
[0.1.8]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.8
[0.1.6]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.6
[0.1.5]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.5
[0.1.4]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.4
[0.1.0]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.0

# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and follows Semantic Versioning.

## [Unreleased]

### Added
- Human and LM-agent onboarding guides with copy-paste command flows in root and CLI READMEs.

### Changed
- Publishing runbook verification checklist now includes first-run UX checks (`charter`, `charter why`) and version checks.

### Fixed
- Clarified install-vs-adopt guidance so users understand `npm install -g @stackbilt/cli` installs the tool and `charter setup` applies governance baseline to each repo.

### Security
- Placeholder for unreleased security updates.

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

[Unreleased]: https://github.com/stackbilt-dev/charter-kit/compare/v0.1.8...HEAD
[0.1.8]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.8
[0.1.6]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.6
[0.1.5]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.5
[0.1.4]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.4
[0.1.0]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.0

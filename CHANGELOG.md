# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and follows Semantic Versioning.

## [Unreleased]

### Added
- First-release publishing runbook with phased preflight, artifact validation, publish order, and rollback guidance.

### Changed
- README reorganized around two onboarding paths: human terminal flow and CI/agent JSON flow.
- Root scripts now execute through `bash -lc "pnpm exec ..."` for more reliable local execution in this environment.
- Vitest config moved to `vitest.config.mts` for ESM-safe test startup.

### Fixed
- Removed stale references to private/local-only planning docs from public-facing README.

### Security
- Placeholder for unreleased security updates.

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

[Unreleased]: https://github.com/stackbilt-dev/charter-kit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.0

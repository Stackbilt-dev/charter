# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.10.x  | Yes       |
| < 0.10  | No        |

## Reporting a Vulnerability

If you discover a security issue in Charter Kit, report it responsibly.

Do not open a public GitHub issue for vulnerabilities.

Email: **admin@stackbilt.dev**

Include:
- Vulnerability description
- Reproduction steps
- Potential impact
- Suggested mitigation (if available)

Response targets:
- Acknowledge within 48 hours
- Critical-issue fix target within 7 days

## Supply Chain and Dependency Policy

Charter is an OSS monorepo that publishes npm packages from a pnpm workspace. Supply-chain changes are governed as security-sensitive maintenance.

Required controls:
- Run `pnpm run supply-chain:check` before release and on CI. The command is a stable wrapper around `pnpm audit --json`.
- Keep Dependabot enabled for npm and GitHub Actions updates.
- Keep GitHub Actions pinned to full commit SHAs, with the human-readable tag retained in a trailing comment.
- Keep `.github/workflows/supply-chain.yml` enabled so SBOM and dependency-review checks run on the repo.
- Publish npm packages through the release workflow with trusted-publisher OIDC and `npm publish --provenance`.
- Use `pnpm.overrides` only as an auditable remediation bridge for vulnerable transitive packages, and remove overrides after upstream ranges catch up.

Current audit baseline:
- Last checked: 2026-06-15
- Command: `pnpm audit --json`
- Result: 0 critical, 0 high, 0 moderate, 0 low, 0 info vulnerabilities across 200 resolved dependencies
- GitHub Dependabot alerts: 0 open alerts

Security-sensitive dependency or workflow changes should be classified as `CROSS_CUTTING` unless they are automated patch/minor updates with no contract impact.

## Scope

This policy covers Charter Kit OSS packages:
- `@stackbilt/types`
- `@stackbilt/core`
- `@stackbilt/adf`
- `@stackbilt/blast`
- `@stackbilt/git`
- `@stackbilt/classify`
- `@stackbilt/validate`
- `@stackbilt/drift`
- `@stackbilt/cli`
- `@stackbilt/ci`
- `@stackbilt/policies`
- `@stackbilt/surface`


## Security Design

The kit is intentionally minimal:
- No network calls by default (offline runtime)
- No secrets handling in normal operation
- No dynamic code execution (`eval`-style behavior)
- Input sanitization before processing
- Immutable GitHub Actions pins for repo-owned workflows
- npm provenance on published packages

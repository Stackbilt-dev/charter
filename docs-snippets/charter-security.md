---
title: "Security"
section: "charter"
order: 4
color: "#dc2626"
tag: "04"
---

# Security

Charter is an OSS governance toolkit published from a pnpm monorepo. The security policy covers vulnerability reporting, supported package versions, and supply-chain controls for dependency and release hygiene.

## Reporting Vulnerabilities

Do not open public GitHub issues for vulnerabilities.

Email: **admin@stackbilt.dev**

Include:
- Vulnerability description
- Reproduction steps
- Potential impact
- Suggested mitigation, if available

Response targets:
- Acknowledge within 48 hours
- Critical-issue fix target within 7 days

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.10.x  | Yes       |
| < 0.10  | No        |

## Supply Chain Controls

Required controls:
- `pnpm run supply-chain:check` runs `pnpm audit --json` and must pass before release.
- Dependabot tracks npm and GitHub Actions updates weekly.
- GitHub Actions use full commit SHA pins with readable tag comments.
- `.github/workflows/supply-chain.yml` runs SBOM and dependency-review checks.
- Releases publish through trusted-publisher OIDC and `npm publish --provenance`.
- `pnpm.overrides` may be used for vulnerable transitives, but only as an auditable remediation bridge.

Current audit baseline:
- Last checked: 2026-06-15
- Result: 0 critical, 0 high, 0 moderate, 0 low, 0 info vulnerabilities across 200 resolved dependencies
- GitHub Dependabot alerts: 0 open alerts

## Security Design

Charter is intentionally minimal:
- No network calls by default
- No secrets handling in normal operation
- No dynamic code execution
- Input sanitization before processing
- Immutable GitHub Actions pins for repo-owned workflows
- npm provenance on published packages

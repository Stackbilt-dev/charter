# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

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

## Scope

This policy covers Charter Kit OSS packages:
- `@stackbilt/types`
- `@stackbilt/core`
- `@stackbilt/adf`
- `@stackbilt/git`
- `@stackbilt/classify`
- `@stackbilt/validate`
- `@stackbilt/drift`
- `@stackbilt/cli`
- `@stackbilt/ci`


## Security Design

The kit is intentionally minimal:
- No network calls by default (offline runtime)
- No secrets handling in normal operation
- No dynamic code execution (`eval`-style behavior)
- Input sanitization before processing

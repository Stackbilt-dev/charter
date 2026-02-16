# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in Charter Kit, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, email: **security@stackbilt.dev**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to provide a fix within 7 days for critical issues.

## Scope

This policy covers the open-source Charter Kit packages only:
- `@charter/types`
- `@charter/core`
- `@charter/git`
- `@charter/classify`
- `@charter/validate`
- `@charter/drift`
- `@charter/cli`
- `@charter/ci`

For issues with CSA Cloud (the hosted platform), contact **support@stackbilt.dev**.

## Security Design

The Kit is designed with a minimal attack surface:
- **No network calls** — works fully offline by default
- **No secrets handling** — the Kit never processes API keys or tokens
- **No code execution** — pattern matching uses regex only, no eval()
- **Input sanitization** — all user input is sanitized before processing

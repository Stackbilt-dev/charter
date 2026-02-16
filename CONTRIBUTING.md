# Contributing to Charter Kit

Thanks for your interest in contributing. This document covers the basics.

## Development Setup

```bash
git clone https://github.com/stackbilt-dev/charter-kit.git
cd charter-kit
pnpm install
pnpm run build
```

## Project Structure

```
packages/
  types/      Shared TypeScript type definitions
  core/       Zod schemas, sanitization, error handling
  git/        Git trailer parsing and commit risk scoring
  classify/   Heuristic change classification
  validate/   Citation validation, message classification
  drift/      Anti-pattern drift scanning
  cli/        CLI tool (npx charter)
  ci/         GitHub Actions helpers
```

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes in the relevant package(s)
3. Ensure `pnpm run build` passes with zero errors
4. Write clear commit messages using conventional commits:
   - `feat(git): add support for custom trailer names`
   - `fix(drift): handle empty anti-pattern strings`
   - `docs: update CLI usage examples`
5. Open a PR against `main`

## Code Standards

- **TypeScript strict mode** — all packages use `strict: true`
- **No runtime dependencies on cloud services** — the Kit must work fully offline
- **Pure functions preferred** — side effects only in CLI commands
- **No LLM API calls** — heuristic-only; LLM features belong in CSA Cloud

## What Belongs Here vs CSA Cloud

This repo contains **portable governance logic** that runs locally and in CI.

**Belongs here:**
- Heuristic classifiers and validators
- Schema definitions and validation
- Git integration logic
- CLI commands
- Config parsing

**Does NOT belong here (stays in CSA Cloud):**
- LLM-powered analysis (temporal, quality, triage)
- Database operations (D1, Durable Objects)
- Authentication/authorization
- Multi-tenant features
- The React frontend

If you're unsure, open an issue to discuss before submitting a PR.

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include your Node.js version, OS, and the output of `charter --version`
- For security issues, see [SECURITY.md](SECURITY.md)

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.

# Publishing Guide

This document defines the release process for Charter Kit packages.

## Scope

Publishable packages:
- `@charter/types`
- `@charter/core`
- `@charter/git`
- `@charter/classify`
- `@charter/validate`
- `@charter/drift`
- `@charter/ci`
- `@charter/cli`

Repository root package (`charter`) is private and must not be published.

## Release Prerequisites

1. Clean working tree (`git status` has no unintended changes).
2. Authenticated npm session (`npm whoami`).
3. All docs updated for behavior changes.
4. Validation commands pass:

```bash
pnpm install
pnpm run clean
pnpm run typecheck
pnpm run build
```

## Versioning Strategy

Use synchronized versions for all `@charter/*` packages until independent versioning is intentionally introduced.

1. Bump versions in `packages/*/package.json`.
2. Replace `workspace:*` with matching semver versions for publish.
3. Verify dependency graph consistency (especially `@charter/cli` internal deps).

## Pre-Publish Verification

Run from repo root:

```bash
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js setup --format json --yes
node packages/cli/dist/bin.js doctor --format json
node packages/cli/dist/bin.js validate --format json
node packages/cli/dist/bin.js drift --format json
node packages/cli/dist/bin.js audit --format json
```

Expected:
- Commands run without runtime errors.
- JSON output is valid and stable.
- Exit codes follow contract (`0`, `1`, `2`).

## Publish Steps

Publish packages in dependency order:

1. `@charter/types`
2. `@charter/core`, `@charter/git`, `@charter/classify`, `@charter/validate`, `@charter/drift`, `@charter/ci`
3. `@charter/cli`

Example (per package):

```bash
pnpm --filter @charter/types publish --access public
pnpm --filter @charter/core publish --access public
pnpm --filter @charter/git publish --access public
pnpm --filter @charter/classify publish --access public
pnpm --filter @charter/validate publish --access public
pnpm --filter @charter/drift publish --access public
pnpm --filter @charter/ci publish --access public
pnpm --filter @charter/cli publish --access public
```

## Post-Publish Validation

In a clean external repo:

```bash
npx @charter/cli@latest setup --ci github
npx @charter/cli@latest doctor --format json
npx @charter/cli@latest validate --format json --ci
```

Confirm:
- `.charter/` scaffold exists
- workflow file is generated when requested
- CLI behavior matches docs

## Release Artifacts

After publish:
1. Create git tag (for example `v0.1.1`).
2. Add release notes summarizing user-visible changes.
3. Include migration notes for any breaking behavior.

## Rollback Strategy

If a bad version is published:
1. Publish a patch fix immediately.
2. Deprecate broken package version(s):

```bash
npm deprecate @charter/cli@<bad_version> "Broken release: use <fixed_version>"
```

3. Update release notes with the corrective version.

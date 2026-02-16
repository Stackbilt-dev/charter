# Publishing Guide

This is the operator runbook for publishing Charter packages to npm.

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

## Phase 1: Preflight (You Run This)

1. Ensure clean working tree:

```bash
git status
```

2. Ensure npm auth:

```bash
npm whoami
```

3. Ensure release gates pass:

```bash
pnpm install
pnpm run clean
pnpm run typecheck
pnpm run build
pnpm run test
```

## Phase 2: Version and Dependency Prep

Use one synchronized version for all `@charter/*` packages until multi-version strategy is introduced.

1. Set new version in each `packages/*/package.json`.
2. Replace internal `workspace:*` dependencies with the same concrete version.
3. Confirm no `workspace:*` remains:

```bash
rg -n "workspace:\\*" packages -g "package.json"
```

## Phase 3: Artifact Validation (Required)

1. Dry-run packed contents per package:

```bash
pnpm --filter @charter/types pack --dry-run
pnpm --filter @charter/core pack --dry-run
pnpm --filter @charter/git pack --dry-run
pnpm --filter @charter/classify pack --dry-run
pnpm --filter @charter/validate pack --dry-run
pnpm --filter @charter/drift pack --dry-run
pnpm --filter @charter/ci pack --dry-run
pnpm --filter @charter/cli pack --dry-run
```

2. Verify CLI behavior before publish:

```bash
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js setup --format json --yes
node packages/cli/dist/bin.js doctor --format json
node packages/cli/dist/bin.js validate --format json
node packages/cli/dist/bin.js drift --format json
node packages/cli/dist/bin.js audit --format json
```

## Phase 4: Publish (Dependency Order)

Publish in this order:

1. `@charter/types`
2. `@charter/core`, `@charter/git`, `@charter/classify`, `@charter/validate`, `@charter/drift`, `@charter/ci`
3. `@charter/cli`

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

## Phase 5: Post-Publish Verification

In a clean external repo:

```bash
npx @charter/cli@latest setup --ci github
npx @charter/cli@latest doctor --format json
npx @charter/cli@latest validate --format json --ci
```

Confirm:
- `.charter/` scaffold exists.
- workflow file is generated when requested.
- behavior matches docs and exit-code contract.

## Release Artifacts

After successful publish:
1. Create git tag (for example `v0.1.1`).
2. Publish release notes summarizing user-visible changes.
3. Update `CHANGELOG.md`.

## Rollback

If a bad version ships:
1. Publish a patch fix immediately.
2. Deprecate broken version(s):

```bash
npm deprecate @charter/cli@<bad_version> "Broken release: use <fixed_version>"
```

3. Call out corrective version in release notes.

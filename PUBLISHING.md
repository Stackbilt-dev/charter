# Publishing Guide

This is the operator runbook for publishing Charter packages to npm.

## Scope

Publishable packages:
- `@stackbilt/types`
- `@stackbilt/core`
- `@stackbilt/adf`
- `@stackbilt/git`
- `@stackbilt/classify`
- `@stackbilt/validate`
- `@stackbilt/drift`
- `@stackbilt/ci`
- `@stackbilt/cli`

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

Use one synchronized version for all `@stackbilt/*` packages until multi-version strategy is introduced.

1. Set new version in each `packages/*/package.json`.
2. Replace internal `workspace:^` dependencies with the same concrete version (e.g. `"^0.2.0"`).
3. Confirm no `workspace:` specifiers remain:

```bash
rg -n "workspace:" packages -g "package.json"
```

## Phase 3: Artifact Validation (Required)

1. Dry-run packed contents per package:

```bash
pnpm --filter @stackbilt/types pack --dry-run
pnpm --filter @stackbilt/core pack --dry-run
pnpm --filter @stackbilt/adf pack --dry-run
pnpm --filter @stackbilt/git pack --dry-run
pnpm --filter @stackbilt/classify pack --dry-run
pnpm --filter @stackbilt/validate pack --dry-run
pnpm --filter @stackbilt/drift pack --dry-run
pnpm --filter @stackbilt/ci pack --dry-run
pnpm --filter @stackbilt/cli pack --dry-run
```

2. Verify CLI behavior before publish:

```bash
node packages/cli/dist/bin.js --version
node packages/cli/dist/bin.js
node packages/cli/dist/bin.js why
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js setup --detect-only --format json
node packages/cli/dist/bin.js setup --format json --yes
node packages/cli/dist/bin.js doctor --format json
node packages/cli/dist/bin.js validate --format json --ci
node packages/cli/dist/bin.js drift --format json --ci
node packages/cli/dist/bin.js audit --format json
node packages/cli/dist/bin.js adf init
node packages/cli/dist/bin.js adf fmt .ai/core.adf
node packages/cli/dist/bin.js adf bundle --task "test task" --format json
```

When reviewing detect output, confirm:
- `suggestedPreset` and `selectedPreset` are sensible for the repo layout.
- `detected.sources` includes expected manifests (root and nested where applicable).

## Phase 4: Publish (Dependency Order)

Publish in this order:

1. `@stackbilt/types`
2. `@stackbilt/core`, `@stackbilt/adf`, `@stackbilt/git`, `@stackbilt/classify`, `@stackbilt/validate`, `@stackbilt/drift`, `@stackbilt/ci`
3. `@stackbilt/cli`

```bash
pnpm --filter @stackbilt/types publish --access public
pnpm --filter @stackbilt/core publish --access public
pnpm --filter @stackbilt/adf publish --access public
pnpm --filter @stackbilt/git publish --access public
pnpm --filter @stackbilt/classify publish --access public
pnpm --filter @stackbilt/validate publish --access public
pnpm --filter @stackbilt/drift publish --access public
pnpm --filter @stackbilt/ci publish --access public
pnpm --filter @stackbilt/cli publish --access public
```

## Phase 5: Post-Publish Verification

In a clean external repo:

```bash
npx @stackbilt/cli@latest --version
npx @stackbilt/cli@latest
npx @stackbilt/cli@latest why
npx @stackbilt/cli@latest setup --detect-only --format json
npx @stackbilt/cli@latest setup --ci github
npx @stackbilt/cli@latest doctor --format json
npx @stackbilt/cli@latest validate --format json --ci
npx @stackbilt/cli@latest drift --format json --ci
npx @stackbilt/cli@latest audit --format json
```

Confirm:
- `.charter/` scaffold exists.
- workflow file is generated when requested.
- behavior matches docs and exit-code contract.
- mixed-stack repos are detected correctly, or can be corrected with explicit `--preset fullstack`.

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
npm deprecate @stackbilt/cli@<bad_version> "Broken release: use <fixed_version>"
```

3. Call out corrective version in release notes.

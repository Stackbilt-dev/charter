# Test Plan

This test plan validates Charter Kit behavior before release.

## Test Objectives

1. Confirm CLI commands work in human mode (text output).
2. Confirm deterministic machine mode for agents (`--format json --ci`).
3. Confirm exit-code contract:
- `0` success
- `1` policy violation in CI mode
- `2` runtime/config/usage error

## Environment Matrix

Run at minimum on:
- Windows (PowerShell)
- Linux (bash)
- Node.js 20+

## Pre-Test Setup

```bash
pnpm install
pnpm run clean
pnpm run typecheck
pnpm run build
```

## Core Functional Tests

### 1. CLI Entry and Help

```bash
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js --version
```

Expected:
- help includes `setup`, `doctor`, `validate`, `drift`, `audit`, `classify`
- version prints successfully

### 2. Bootstrap Flow

```bash
node packages/cli/dist/bin.js setup --format json --yes
node packages/cli/dist/bin.js doctor --format json
```

Expected:
- `.charter/config.json` exists
- patterns and policies exist
- doctor reports `PASS` in configured repo

### 3. Validation and Audit Commands

```bash
node packages/cli/dist/bin.js validate --format json
node packages/cli/dist/bin.js drift --format json
node packages/cli/dist/bin.js audit --format json
```

Expected:
- valid JSON output
- no runtime failures

### 4. Classification Command

```bash
node packages/cli/dist/bin.js classify "Add OAuth2 integration for partner API" --format json
```

Expected:
- JSON includes class and recommendation fields

## Exit-Code Tests

### 5. CI Warning Path

```bash
node packages/cli/dist/bin.js doctor --config .missing-charter --ci --format json
```

Expected:
- exit code `1`
- JSON status indicates warning

### 6. Usage Error Path

```bash
node packages/cli/dist/bin.js classify
```

Expected:
- exit code `2`
- clear usage guidance printed

## CI Template Test

```bash
node packages/cli/dist/bin.js setup --ci github --yes
```

Expected:
- `.github/workflows/charter-governance.yml` is created
- workflow runs `validate`, `drift`, and `audit`

## External Repo Smoke Test

In a separate repo:

```bash
npx @charter/cli@latest setup --ci github
npx @charter/cli@latest doctor --format json
npx @charter/cli@latest validate --format json --ci
```

Expected:
- onboarding is one-command
- commands are deterministic for LM automation

## Release Gate

Do not publish unless all sections above pass and documentation reflects final behavior.

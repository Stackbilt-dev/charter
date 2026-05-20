# @stackbilt/policies

Supply chain policy stamping for Stackbilt-dev org repos.

Detects floating GitHub Action pins, patches them to immutable commit SHAs, and injects a standard supply chain caller workflow backed by reusable workflows in `Stackbilt-dev/stackbilt_llc`.

Used internally by `charter stamp-policies`. Can also be consumed programmatically.

## Install

```bash
npm install @stackbilt/policies
```

## Usage

### Programmatic

```typescript
import { applyPolicies } from '@stackbilt/policies';

const result = await applyPolicies('/path/to/repo', {
  dryRun: false,
  fixPins: true,
  policyRepoRef: 'c87defbe10de10c7d53653338d330bcd48d41746', // stackbilt_llc SHA
});

console.log(`Pins patched: ${result.pinsPatched}`);
console.log(`Supply chain workflow added: ${result.supplyChainWorkflowAdded}`);
console.log(`Already compliant: ${result.alreadyCompliant}`);
```

### Via Charter CLI

```bash
charter stamp-policies --path /path/to/repo [--dry-run] [--no-fix-pins] [--policy-repo-ref <sha>]
```

If `--policy-repo-ref` is omitted, the CLI resolves the current HEAD of `Stackbilt-dev/stackbilt_llc` automatically.

## What it does

Given a target repo path, `applyPolicies` performs three operations:

1. **Patch floating action pins** — scans `.github/workflows/*.yml` for any `uses:` line referencing a non-SHA ref (`@vN`, `@main`, `@master`, semver tags). Resolves each to a commit SHA via `git ls-remote` and rewrites the line as `@<sha> # <original-ref>`.

2. **Add supply-chain.yml** — if no `supply-chain.yml` exists, generates a caller workflow that invokes the SBOM and dependency review reusable workflows from `stackbilt_llc`.

3. **Install drift pattern** — writes `.charter/patterns/floating-action-pins.json` and enables YAML drift in `.charter/config.json` so future floating pins are caught by `charter drift`.

## API

### `applyPolicies(repoPath, opts)`

```typescript
applyPolicies(repoPath: string, opts: StampOptions): Promise<PolicyStampResult>

interface StampOptions {
  dryRun: boolean;       // report changes without writing files
  fixPins: boolean;      // patch floating action pins
  policyRepoRef: string; // stackbilt_llc commit SHA for caller workflow uses: paths
}

interface PolicyStampResult {
  config: RepoConfig;
  pinsPatched: number;
  workflowsPatched: string[];
  supplyChainWorkflowAdded: boolean;
  charterConfigUpdated: boolean;
  alreadyCompliant: boolean;
}
```

### `detectRepoConfig(repoPath)`

Detects package manager (`npm`/`pnpm`), Node.js version, existing workflows, floating pins, and whether a supply chain workflow is already present.

### `patchFloatingActionPins(content)`

Async. Takes workflow file content as a string, returns `{ patched, replacements }`. Does not read or write files.

### `generateCallerWorkflow(config, policyRepoRef)`

Returns the YAML string for a supply-chain caller workflow.

### `generateCharterConfigPatch(existing)`

Merges YAML drift configuration into an existing charter config object (or creates one from scratch).

## Floating pin detection

A pin is considered floating if it is not a 40-character hex SHA. Exempt patterns:

- `uses: Stackbilt-dev/...` — org-internal reusable workflows
- `uses: ./...` — local composite actions

## Requirements

- Node.js >= 18
- `git` available in PATH (for SHA resolution via `git ls-remote`)

## License

Apache-2.0

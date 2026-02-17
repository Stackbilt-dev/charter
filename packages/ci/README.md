# @stackbilt/ci

GitHub Actions integration helpers for [Charter Kit](https://github.com/Stackbilt-dev/charter) -- a local-first governance toolkit for software repos.

## Install

```bash
npm install @stackbilt/ci
```

## Usage

### Write Actions outputs and summaries

```ts
import { setOutput, setSummary } from '@stackbilt/ci';

setOutput('governance-status', 'PASS');
setSummary('## Governance check passed\nNo violations detected.');
```

### Annotate drift violations

```ts
import { annotateDriftViolations } from '@stackbilt/ci';

// Emits ::warning:: or ::error:: annotations inline on PR diffs.
// BLOCKER/CRITICAL severity = error; others = warning.
annotateDriftViolations(violations);
```

### Annotate validation status

```ts
import { annotateValidationStatus } from '@stackbilt/ci';

annotateValidationStatus('FAIL', 'Missing required Governed-By trailer');
```

### Format a PR comment

```ts
import { formatPRComment } from '@stackbilt/ci';

const body = formatPRComment({
  status: 'WARN',
  summary: '2 drift violations detected',
  violations,
  suggestions: ['Pin axios to the blessed version'],
  score: 0.85,
});
```

## API Reference

### `setOutput(name, value): void`

Appends `name=value` to `$GITHUB_OUTPUT`. No-op outside Actions.

### `setSummary(markdown): void`

Appends markdown to `$GITHUB_STEP_SUMMARY`. No-op outside Actions.

### `annotateDriftViolations(violations: DriftViolation[]): void`

Emits `::error::` / `::warning::` for each violation with file and line number.

### `annotateValidationStatus(status, summary): void`

Emits `::error::` for FAIL, `::warning::` for WARN, nothing for PASS.

### `formatPRComment(result): string`

Formats governance results as a markdown PR comment with status, violations table (max 20), and suggestions.

## Requirements

- Node >= 18
- Peer dependency: `@stackbilt/types`

## License

Apache-2.0

## Links

- [Repository](https://github.com/Stackbilt-dev/charter)
- [Issues](https://github.com/Stackbilt-dev/charter/issues)

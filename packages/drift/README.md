# @stackbilt/drift

Blessed-stack drift detection for [Charter Kit](https://github.com/Stackbilt-dev/charter) -- a local-first governance toolkit for software repos. Scans source files against anti-patterns defined in `.charter/patterns/*.json` and produces a drift score with per-line violation details.

> **Want the full toolkit?** Just install the CLI — it includes everything:
> ```bash
> npm install -g @stackbilt/cli
> ```
> Only install this package directly if you need drift scanning without the CLI.

## Install

```bash
npm install @stackbilt/drift
```

## Usage

### Scan files for drift

```ts
import { scanForDrift } from '@stackbilt/drift';

const files = {
  'src/app.ts': 'import { createApp } from "vue";\ncreateApp({});',
  'src/utils.ts': 'export const add = (a: number, b: number) => a + b;',
};

const patterns = [
  { name: 'React Only', antiPatterns: 'Do not use `angular` or /vue\\.createApp/i' },
];

const report = scanForDrift(files, patterns);

console.log(report.score);        // 0.0 - 1.0 (1.0 = no drift)
console.log(report.violations);   // Array of DriftViolation
console.log(report.scannedFiles); // 2
```

### Extract rules independently

```ts
import { extractRules } from '@stackbilt/drift';

const rules = extractRules('Avoid /console\\.log/g and `eval`');
// => [/console\.log/g, /eval/]
```

## API Reference

### `scanForDrift(files, patterns): DriftReport`

Scan file contents against blessed-stack patterns.

| Field | Type | Description |
|---|---|---|
| `score` | `number` | 0.0 (high drift) to 1.0 (clean) |
| `violations` | `DriftViolation[]` | Anti-pattern matches found |
| `scannedFiles` | `number` | Total files scanned |
| `scannedPatterns` | `number` | Total patterns evaluated |
| `timestamp` | `string` | ISO 8601 scan timestamp |

### `extractRules(antiPatternText: string): RegExp[]`

Parse an anti-pattern definition into regex rules. Supports `/pattern/flags` and `` `keyword` `` syntax.

## Requirements

- Node >= 18
- Peer dependency: `@stackbilt/types`

## License

Apache-2.0

## Links

- [Repository](https://github.com/Stackbilt-dev/charter)
- [Issues](https://github.com/Stackbilt-dev/charter/issues)

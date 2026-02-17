# @stackbilt/classify

Heuristic change classification for [Charter Kit](https://github.com/Stackbilt-dev/charter) -- a local-first governance toolkit for software repos. Classifies changes as **SURFACE**, **LOCAL**, or **CROSS_CUTTING** using pure pattern matching. No LLM calls, runs in under 5 ms.

> **Want the full toolkit?** Just install the CLI — it includes everything:
> ```bash
> npm install -g @stackbilt/cli
> ```
> Only install this package directly if you need change classification without the CLI.

## Install

```bash
npm install @stackbilt/classify
```

## Usage

```ts
import { heuristicClassify, determineRecommendation } from '@stackbilt/classify';

const result = heuristicClassify('fix typo in readme');
// {
//   suggestedClass: 'SURFACE',
//   confidence: 'HIGH',
//   signals: ['Surface pattern: ...', 'Surface pattern: ...']
// }

const recommendation = determineRecommendation('CROSS_CUTTING', 'CLEAR', true);
// 'APPROVE_WITH_MITIGATIONS'
```

## API Reference

### `heuristicClassify(subject: string)`

Classifies a change description by matching against built-in pattern sets.

**Returns** `{ suggestedClass: ChangeClass, confidence: 'HIGH' | 'MEDIUM' | 'LOW', signals: string[] }`

| ChangeClass | Meaning | Example triggers |
|---|---|---|
| `SURFACE` | Cosmetic or documentation-only | readme, doc, typo, spelling, rename, `.md`/`.txt`/`.json` |
| `CROSS_CUTTING` | Multi-system or architectural | schema, API, migration, auth, infrastructure, integration |
| `LOCAL` | Single-module (default) | No strong pattern match detected |

Confidence is `HIGH` when two or more patterns match, `MEDIUM` for one, `LOW` when defaulting to `LOCAL`.

### `determineRecommendation(changeClass, governanceStatus, mitigationsRequired)`

Returns `APPROVE`, `APPROVE_WITH_MITIGATIONS`, `REJECT`, or `ESCALATE` based on classification context.

### `formatChangeClassification(classification: ChangeClassification)`

Renders a full classification as human-readable Markdown.

## Requirements

- Node >= 18
- Peer dependency: `@stackbilt/types`

## License

Apache-2.0

## Links

- [Repository](https://github.com/Stackbilt-dev/charter)
- [Issues](https://github.com/Stackbilt-dev/charter/issues)

# @stackbilt/adf

ADF (Attention-Directed Format) parser, formatter, patcher, and bundler for [Charter Kit](https://github.com/Stackbilt-dev/charter) -- a local-first governance toolkit for software repos. ADF is an attention-optimized microformat that replaces monolithic context files (`.cursorrules`, `claude.md`) with a modular, AST-backed system designed for LLM context windows.

> **Want the full toolkit?** Just install the CLI -- it includes everything:
> ```bash
> npm install -g @stackbilt/cli
> ```
> Only install this package directly if you need ADF parsing/formatting without the CLI.

## Install

```bash
npm install @stackbilt/adf
```

## What is ADF?

ADF treats LLM context as a compiled language. Key properties:

- **Emoji-decorated semantic keys** act as high-contrast attention boundaries for transformer models
- **Strict AST** with three content types: text, list, and map
- **Patch protocol** for safe delta updates (agents issue typed ops, not full rewrites)
- **Module system** with manifest-based routing and progressive disclosure

Example ADF document:

```
ADF: 0.1
TASK: Implement Redis cache layer
CONTEXT:
  - High-traffic /api/users endpoint
  - Cloudflare Workers environment
OUTPUT: Patch diff + brief explanation
CONSTRAINTS:
  - No new dependencies
  - P99 latency must improve
STATE:
  CURRENT: Baseline endpoint works but slow under load
  NEXT: Add cache + invalidation logic
```

## Usage

### Parse an ADF document

```ts
import { parseAdf } from '@stackbilt/adf';

const doc = parseAdf(`
ADF: 0.1
TASK: Build feature
CONSTRAINTS:
  - No new deps
  - Stay fast
STATE:
  CURRENT: Starting
  NEXT: Continue
`);

console.log(doc.version);                // '0.1'
console.log(doc.sections[0].key);        // 'TASK'
console.log(doc.sections[0].content);    // { type: 'text', value: 'Build feature' }
console.log(doc.sections[1].content);    // { type: 'list', items: ['No new deps', 'Stay fast'] }
console.log(doc.sections[2].content);    // { type: 'map', entries: [{key:'CURRENT',value:'Starting'}, ...] }
```

### Format to canonical ADF

```ts
import { parseAdf, formatAdf } from '@stackbilt/adf';

const doc = parseAdf(messyInput);
const canonical = formatAdf(doc);
// Sections sorted by canonical key order, standard emoji auto-injected, 2-space indent
```

### Apply patches (safe delta updates)

```ts
import { parseAdf, applyPatches, formatAdf } from '@stackbilt/adf';

const doc = parseAdf(input);
const patched = applyPatches(doc, [
  { op: 'ADD_BULLET', section: 'CONSTRAINTS', value: 'Must pass CI' },
  { op: 'REPLACE_BULLET', section: 'STATE', index: 1, value: 'NEXT: Deploy to prod' },
  { op: 'REMOVE_BULLET', section: 'STATE', index: 0 },
  { op: 'ADD_SECTION', key: 'RISKS', content: { type: 'list', items: ['Data loss'] } },
]);
console.log(formatAdf(patched));
```

Patch operations throw `AdfPatchError` with context on invalid ops (missing section, out-of-bounds index, duplicate section).

### Manifest-based module bundling

```ts
import { parseAdf, parseManifest, resolveModules, bundleModules } from '@stackbilt/adf';
import * as fs from 'node:fs';

const manifestDoc = parseAdf(fs.readFileSync('.ai/manifest.adf', 'utf-8'));
const manifest = parseManifest(manifestDoc);

// Resolve modules for a given task
const keywords = ['React', 'component', 'fix'];
const modules = resolveModules(manifest, keywords);
// => ['core.adf', 'state.adf', 'frontend.adf']

// Bundle into single merged document
const result = bundleModules('.ai', modules, (p) => fs.readFileSync(p, 'utf-8'));
console.log(result.tokenEstimate);      // rough token count
console.log(result.resolvedModules);    // which modules were loaded
console.log(result.triggerMatches);     // which triggers matched/missed
```

## API Reference

### `parseAdf(input: string): AdfDocument`

Tolerant parser that handles messy LLM output. Strips emoji decorations, normalizes line endings, auto-detects content types (text, list, map). Defaults to version `0.1` if version line is missing.

### `formatAdf(doc: AdfDocument): string`

Strict emitter producing canonical ADF. Sorts sections by canonical key order, auto-injects standard emoji decorations when missing, uses 2-space indent for body content.

### `applyPatches(doc: AdfDocument, ops: PatchOperation[]): AdfDocument`

Immutable patcher. Returns a new document; the original is never mutated. Supports six operation types:

| Op | Target | Description |
|---|---|---|
| `ADD_BULLET` | list/map section | Append an item or entry |
| `REPLACE_BULLET` | list/map section | Replace item at index |
| `REMOVE_BULLET` | list/map section | Remove item at index |
| `ADD_SECTION` | document | Add new section (throws if duplicate) |
| `REPLACE_SECTION` | document | Replace entire section content |
| `REMOVE_SECTION` | document | Remove section by key |

### `parseManifest(doc: AdfDocument): Manifest`

Extract routing manifest from a parsed ADF document. Reads `DEFAULT_LOAD`, `ON_DEMAND` (with trigger parsing), `ROLE`, and `RULES` sections.

### `resolveModules(manifest: Manifest, taskKeywords: string[]): string[]`

Resolve which modules to load. Always includes `defaultLoad`; adds `ON_DEMAND` modules whose triggers match any keyword (case-insensitive).

### `bundleModules(basePath: string, modulePaths: string[], readFile: (p: string) => string): BundleResult`

Parse, merge, and bundle resolved modules into a single ADF document. Duplicate sections are merged (lists concatenated, texts joined, maps concatenated). Returns token estimate and trigger match report.

## AST Types

```ts
interface AdfDocument { version: '0.1'; sections: AdfSection[]; }
interface AdfSection  { key: string; decoration: string | null; content: AdfContent; }

type AdfContent =
  | { type: 'text'; value: string }
  | { type: 'list'; items: string[] }
  | { type: 'map';  entries: AdfMapEntry[] };

interface AdfMapEntry { key: string; value: string; }
```

## Error Types

- `AdfParseError` -- invalid document structure (with optional line number)
- `AdfPatchError` -- invalid patch operation (with op name, section, index context)
- `AdfBundleError` -- module resolution failure (with optional module path)

## Requirements

- Node >= 18
- Zero runtime dependencies

## License

Apache-2.0

## Links

- [Repository](https://github.com/Stackbilt-dev/charter)
- [Issues](https://github.com/Stackbilt-dev/charter/issues)
- [ADF Specification](https://github.com/Stackbilt-dev/charter/blob/main/plans/ADF_SPEC.md)

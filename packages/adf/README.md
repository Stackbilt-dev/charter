# @stackbilt/adf

ADF (Attention-Directed Format) parser, formatter, patcher, and bundler for [Charter Kit](https://github.com/Stackbilt-dev/charter) -- a local-first governance toolkit for software repos. ADF is an attention-optimized microformat that replaces monolithic context files (`.cursorrules`, `claude.md`) with a modular, AST-backed system designed for LLM context windows.

![ADF Architecture](../../ADF_1.png)

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
- **Strict AST** with four content types: text, list, map, and metric
- **Patch protocol** for safe delta updates (agents issue typed ops, not full rewrites)
- **Module system** with manifest-based routing, progressive disclosure, and token budgets
- **Weight annotations** distinguish load-bearing constraints from advisory preferences
- **Sync protocol** detects drift between source .adf files and their compressed targets
- **Constraint validation** checks metric ceilings and produces structured pass/fail evidence reports
- **Cadence scheduling** declares check frequency expectations per metric
- **Auto-measurement** via manifest METRICS section mapping metric keys to source files

Example ADF document:

```
ADF: 0.1
TASK: Implement Redis cache layer
CONTEXT:
  - High-traffic /api/users endpoint
  - Cloudflare Workers environment
OUTPUT: Patch diff + brief explanation
CONSTRAINTS [load-bearing]:
  - No new dependencies
  - P99 latency must improve
STATE:
  CURRENT: Baseline endpoint works but slow under load
  NEXT: Add cache + invalidation logic
  METRICS:
    entry_loc: 142 / 200 [lines]
    total_loc: 312 / 400 [lines]
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

### Parse metric content

```ts
const doc = parseAdf(`
STATE:
  entry_loc: 142 / 200 [lines]
  total_loc: 312 / 400 [lines]
`);

// doc.sections[0].content =>
// { type: 'metric', entries: [
//   { key: 'entry_loc', value: 142, ceiling: 200, unit: 'lines' },
//   { key: 'total_loc', value: 312, ceiling: 400, unit: 'lines' },
// ]}
```

Metric entries use `lowercase_key: value / ceiling [unit]` syntax. Map entries use `UPPERCASE_KEY: value`. This is the disambiguation.

### Parse weight annotations

```ts
const doc = parseAdf(`
CONSTRAINTS [load-bearing]:
  - Max 400 LOC
`);

console.log(doc.sections[0].weight);  // 'load-bearing'
```

Sections can carry `[load-bearing]` or `[advisory]` annotations. Weight defaults to `undefined` when no annotation is present.

### Format to canonical ADF

```ts
import { parseAdf, formatAdf } from '@stackbilt/adf';

const doc = parseAdf(messyInput);
const canonical = formatAdf(doc);
// Sections sorted by canonical key order, standard emoji auto-injected, 2-space indent
// Metric entries formatted as: key: value / ceiling [unit]
// Weight annotations preserved in headers
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
  { op: 'UPDATE_METRIC', section: 'METRICS', key: 'entry_loc', value: 156 },
]);
console.log(formatAdf(patched));
```

Patch operations throw `AdfPatchError` with context on invalid ops (missing section, out-of-bounds index, duplicate section). `UPDATE_METRIC` only changes the value; ceiling and unit are immutable through patches.

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

// Bundle into single merged document (pass keywords for trigger observability)
const result = bundleModules('.ai', modules, (p) => fs.readFileSync(p, 'utf-8'), keywords);
console.log(result.tokenEstimate);        // rough token count
console.log(result.tokenBudget);          // from manifest BUDGET section (or null)
console.log(result.tokenUtilization);     // estimate / budget (or null)
console.log(result.perModuleTokens);      // { 'core.adf': 45, 'state.adf': 22, ... }
console.log(result.resolvedModules);      // which modules were loaded
console.log(result.triggerMatches);       // per-trigger detail with matchedKeywords + loadReason
console.log(result.unmatchedModules);     // on-demand modules not resolved
console.log(result.advisoryOnlyModules);  // loaded modules with no load-bearing sections
console.log(result.moduleBudgetOverruns); // modules exceeding their per-module budget
```

## API Reference

### `parseAdf(input: string): AdfDocument`

Tolerant parser that handles messy LLM output. Strips emoji decorations, normalizes line endings, auto-detects content types (text, list, map, metric). Defaults to version `0.1` if version line is missing. Parses `[load-bearing]` and `[advisory]` weight annotations on section headers.

### `formatAdf(doc: AdfDocument): string`

Strict emitter producing canonical ADF. Sorts sections by canonical key order, auto-injects standard emoji decorations when missing, uses 2-space indent for body content. Emits weight annotations and metric entries in canonical form.

### `applyPatches(doc: AdfDocument, ops: PatchOperation[]): AdfDocument`

Immutable patcher. Returns a new document; the original is never mutated. Supports seven operation types:

| Op | Target | Description |
|---|---|---|
| `ADD_BULLET` | list/map section | Append an item or entry |
| `REPLACE_BULLET` | list/map section | Replace item at index |
| `REMOVE_BULLET` | list/map section | Remove item at index |
| `ADD_SECTION` | document | Add new section (throws if duplicate) |
| `REPLACE_SECTION` | document | Replace entire section content |
| `REMOVE_SECTION` | document | Remove section by key |
| `UPDATE_METRIC` | metric section | Update value by key (ceiling/unit immutable) |

### `parseManifest(doc: AdfDocument): Manifest`

Extract routing manifest from a parsed ADF document. Reads `DEFAULT_LOAD`, `ON_DEMAND` (with trigger parsing and optional `[budget: N]` suffix), `BUDGET` (global `MAX_TOKENS`), `SYNC`, `CADENCE`, `METRICS` (source file mappings), `ROLE`, and `RULES` sections.

### `resolveModules(manifest: Manifest, taskKeywords: string[]): string[]`

Resolve which modules to load. Always includes `defaultLoad`; adds `ON_DEMAND` modules whose triggers match any keyword (case-insensitive).

### `bundleModules(basePath: string, modulePaths: string[], readFile: (p: string) => string, taskKeywords?: string[]): BundleResult`

Parse, merge, and bundle resolved modules into a single ADF document. Duplicate sections are merged (lists concatenated, texts joined, maps concatenated, metrics concatenated). Returns token estimate, budget utilization, per-module token counts, trigger match report with keyword-level detail, unmatched modules, and advisory-only module warnings. Optional `taskKeywords` enables richer trigger observability in the report.

### `validateConstraints(doc: AdfDocument, context?: Record<string, number>): EvidenceResult`

Validate all metric entries against their ceilings. Returns a structured evidence report with pass/fail/warn per metric, weight summary, and aggregate counts. Optional `context` parameter injects external measurements (e.g., actual LOC count) that override the document's own values. Status semantics: `value < ceiling` = pass, `value === ceiling` = warn, `value > ceiling` = fail.

### `computeWeightSummary(doc: AdfDocument): WeightSummary`

Count sections by weight category (`load-bearing`, `advisory`, unweighted). Useful independently from constraint validation.

## AST Types

```ts
// --- Document Model ---
interface AdfDocument { version: '0.1'; sections: AdfSection[]; }
interface AdfSection  {
  key: string;
  decoration: string | null;
  content: AdfContent;
  weight?: 'load-bearing' | 'advisory';
}

type AdfContent =
  | { type: 'text'; value: string }
  | { type: 'list'; items: string[] }
  | { type: 'map';  entries: AdfMapEntry[] }
  | { type: 'metric'; entries: AdfMetricEntry[] };

interface AdfMapEntry    { key: string; value: string; }
interface AdfMetricEntry { key: string; value: number; ceiling: number; unit: string; }

// --- Manifest ---
interface Manifest {
  version: '0.1'; role?: string; defaultLoad: string[];
  onDemand: ManifestModule[]; rules: string[]; tokenBudget?: number;
  sync: SyncEntry[]; cadence: CadenceEntry[]; metrics: MetricSource[];
}
interface ManifestModule { path: string; triggers: string[]; loadPolicy: 'DEFAULT' | 'ON_DEMAND'; tokenBudget?: number; }
interface SyncEntry      { source: string; target: string; }
interface CadenceEntry   { check: string; frequency: string; }
interface MetricSource   { key: string; path: string; }

// --- Bundle Result ---
interface BundleResult {
  manifest: Manifest; resolvedModules: string[]; mergedDocument: AdfDocument;
  tokenEstimate: number; tokenBudget: number | null; tokenUtilization: number | null;
  perModuleTokens: Record<string, number>;
  moduleBudgetOverruns: Array<{ module: string; tokens: number; budget: number }>;
  triggerMatches: Array<{
    module: string; trigger: string; matched: boolean;
    matchedKeywords: string[]; loadReason: 'default' | 'trigger';
  }>;
  unmatchedModules: string[];
  advisoryOnlyModules: string[];
}

// --- Constraint Validation ---
type ConstraintStatus = 'pass' | 'fail' | 'warn';
interface ConstraintResult {
  section: string; metric: string; value: number; ceiling: number;
  unit: string; status: ConstraintStatus; message: string; source: 'metric' | 'context';
}
interface WeightSummary  { loadBearing: number; advisory: number; unweighted: number; total: number; }
interface EvidenceResult {
  constraints: ConstraintResult[]; weightSummary: WeightSummary;
  allPassing: boolean; failCount: number; warnCount: number;
}
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

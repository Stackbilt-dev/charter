# @stackbilt/blast

Blast radius analysis for [Charter Kit](https://github.com/Stackbilt-dev/charter) — a local-first governance toolkit for software repos. Builds a reverse dependency graph from TypeScript/JavaScript source files and answers the question: **"if I change this file, what else breaks?"**

Pure heuristic — no LLM calls, no TypeScript compiler API, zero runtime dependencies. Uses regex-based import extraction, which trades some precision for universality and speed.

> **Want the full toolkit?** Just install the CLI — it includes everything:
> ```bash
> npm install -g @stackbilt/cli
> ```
> Only install this package directly if you need blast radius analysis without the CLI.

## Install

```bash
npm install @stackbilt/blast
```

## CLI Usage

Via the Charter CLI:

```bash
charter blast src/kernel/dispatch.ts                        # Default depth 3
charter blast src/a.ts src/b.ts --depth 4                   # Multi-seed, custom depth
charter blast src/foo.ts --format json                      # Machine-readable output
charter blast src/foo.ts --root ./packages/server           # Scan a subdirectory
```

Blast radius ≥20 files triggers a `CROSS_CUTTING` warning — a signal for governance gates to route the change through architectural review.

## Programmatic Usage

```ts
import { buildGraph, blastRadius, topHotFiles } from '@stackbilt/blast';

// Build the dependency graph once per project root
const graph = buildGraph('./src', {
  aliases: { '@/': 'src/' },   // tsconfig paths, if any
});

// Blast radius for a seed file (BFS on reverse graph)
const result = blastRadius(graph, ['./src/kernel/dispatch.ts'], {
  maxDepth: 3,
});

console.log(result.summary.totalAffected);  // e.g. 72
console.log(result.affected);               // string[] of file paths
console.log(result.hotFiles);               // top 20 most-imported files
```

## API Reference

### `buildGraph(root: string, options?: BuildGraphOptions): DependencyGraph`

Walks the source tree under `root`, extracts imports from every TS/JS file, and returns a bidirectional dependency graph.

**Options:**
- `extensions` — file extensions to scan (default: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`)
- `ignoreDirs` — directories to skip (default: `node_modules`, `dist`, `build`, `.git`, `.next`, `.turbo`, `.cache`, `coverage`, `.wrangler`)
- `aliases` — path alias map like `{ '@/': 'src/' }` (resolved against `root`)

**Returns:** `{ imports, importedBy, root, fileCount }` — two `Map<string, Set<string>>` for forward and reverse edges.

Handles:
- ESM `.js → .ts` rewrite (common in TypeScript ESM projects)
- tsconfig path aliases (the CLI auto-detects them from `tsconfig.json` including `extends` chains)
- Directory `src/index.*` resolution (standard monorepo layout)
- `package.json` `source` / `types` / `main` fallback
- Cycles (visited-set prevents infinite loops)
- Line and block comments (stripped before scanning)

### `blastRadius(graph, seeds, options?): BlastRadiusResult`

BFS traversal of the reverse (`importedBy`) graph from the given seed files.

**Options:**
- `maxDepth` — max BFS depth (default: 3)

**Returns:**
- `seeds` — relative paths of input seeds
- `affected` — relative paths of transitively-dependent files (excludes seeds)
- `maxDepth` — actual depth reached
- `hotFiles` — top 20 most-imported files in the whole graph
- `summary` — `{ totalAffected, seedCount, depthHistogram }`

### `topHotFiles(graph, limit): Array<{ file, importers }>`

Ranks files by number of incoming imports. Useful for identifying architectural bottlenecks independently of any specific change.

### `extractImports(source: string): string[]`

Extracts all raw import specifiers from a source string. Handles ES modules, CommonJS `require`, dynamic `import()`, and re-exports. Strips block and line comments first to avoid false positives.

### `resolveSpecifier(specifier, fromFile, root, extensions, aliases): string | null`

Resolves a single import specifier to an absolute file path, or `null` for bare specifiers (external packages).

## Use Cases

- **Governance gates** — block or escalate changes whose blast radius exceeds a threshold
- **Pre-commit hooks** — classify changes as `LOCAL` vs `CROSS_CUTTING` based on actual import coupling
- **Refactoring scope estimation** — "how much work is this rename going to be?"
- **Code review automation** — surface hot files to reviewers who might otherwise miss architectural impact
- **Self-improvement bots** — require blast radius <N before auto-queueing fix tasks

## Requirements

- Node >= 18
- Zero runtime dependencies

## License

Apache-2.0

## Links

- [Repository](https://github.com/Stackbilt-dev/charter)
- [Issues](https://github.com/Stackbilt-dev/charter/issues)
- [Charter CLI](https://github.com/Stackbilt-dev/charter/tree/main/packages/cli)

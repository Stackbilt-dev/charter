# @stackbilt/surface

API surface extraction for [Charter Kit](https://github.com/Stackbilt-dev/charter) — a local-first governance toolkit for software repos. Extracts two things from a project:

1. **HTTP routes** — Hono, Express, itty-router
2. **Database schema** — D1 / SQLite `CREATE TABLE` statements

Pure heuristic — no LLM calls, no AST. Zod is the only runtime dependency; it carries the package's authoritative input/output schemas so CLI and MCP adapters validate against the same contract. Designed for Cloudflare Worker projects, but works on any Node.js HTTP backend with compatible routing conventions.

> **Want the full toolkit?** Just install the CLI — it includes everything:
> ```bash
> npm install -g @stackbilt/cli
> ```
> Only install this package directly if you need surface extraction without the CLI.

## Install

```bash
npm install @stackbilt/surface
```

## CLI Usage

Via the Charter CLI:

```bash
charter surface                                    # Text summary
charter surface --format json                      # JSON for tooling
charter surface --markdown                         # Markdown for .ai/surface.adf
charter surface --root ./packages/worker           # Scan a subdirectory
charter surface --schema db/schema.sql             # Explicit schema path
```

## Programmatic Usage

```ts
import { analyze, SurfaceInputSchema } from '@stackbilt/surface';

// `analyze` is the Core-Out entry point — validates input via Zod,
// composes extractSurface, returns a SurfaceOutput-shaped result.
const input = SurfaceInputSchema.parse({ root: './packages/worker' });
const result = analyze(input);

console.log(result.summary);
// { routeCount: 95, schemaTableCount: 50, routesByMethod: {...}, routesByFramework: {...} }
```

The lower-level primitives are still exported for callers that don't need
the schema layer:

```ts
import { extractSurface, formatSurfaceMarkdown } from '@stackbilt/surface';

const surface = extractSurface({ root: './packages/worker' });
console.log(formatSurfaceMarkdown(surface));
// # API Surface
// **Routes:** 95
// **Tables:** 50
// ...
```

## API Reference

### `extractSurface(options?: ExtractOptions): Surface`

Scans a project directory and returns its full API surface (routes + schemas).

**Options:**
- `root` — project root (default: `cwd`)
- `extensions` — file extensions to scan for routes (default: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`)
- `ignoreDirs` — additional directories to skip
- `schemaPaths` — explicit schema file paths (default: auto-detect `*schema*.sql` under root)

**Returns:** `{ root, routes, schemas, summary }`

Automatically ignores `node_modules`, `dist`, `build`, `.git`, `.next`, `.turbo`, `.wrangler`, `coverage`, `__tests__`, `__mocks__`, `__fixtures__`, and all `*.test.*` / `*.spec.*` files.

### `extractRoutes(source: string, filePath: string): Route[]`

Extracts HTTP routes from a single source file.

**Detects:**
- `app.get('/path', handler)`, `router.post('/path', ...)`, etc.
- `.basePath('/api/v1')` for router prefixes
- Framework import detection: Hono, Express, itty-router
- Strips block and line comments before scanning (jsdoc examples don't match)
- Requires route paths to start with `/` to avoid matching unrelated method calls like `list.post(item)`

**Returns:** `{ method, path, file, line, framework, prefix? }[]`

### `extractSchema(source: string, filePath: string): SchemaTable[]`

Parses `CREATE TABLE` statements from a SQL source string.

**Handles:**
- `CREATE TABLE` and `CREATE TABLE IF NOT EXISTS`
- Column types including parameterized (e.g. `VARCHAR(255)`)
- Column flags: `PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `DEFAULT`
- Skips table-level constraints (`FOREIGN KEY`, `CHECK`, `CONSTRAINT`)
- Nested parens (balanced paren matching, not regex bracket soup)

**Returns:** `SchemaTable[]` where each table has `{ name, columns, file, line }` and each column has `{ name, type, nullable, primaryKey, unique, defaultValue? }`.

### `formatSurfaceMarkdown(surface: Surface): string`

Renders a surface as a compact markdown summary suitable for injection into AI context maps (e.g. an auto-generated `.ai/surface.adf` module) or mission briefs for autonomous task runners.

## Use Cases

- **Breaking change detection** — diff surfaces before and after a PR to identify removed endpoints or dropped columns
- **Auto-generated AI context** — emit markdown for `.ai/surface.adf` so agents always know the API shape
- **Deploy pipeline gates** — force a major version bump when the surface shrinks
- **Mission brief fingerprinting** — inject route + schema summaries into autonomous task runner prompts so agents don't burn turns exploring layout
- **Documentation scaffolding** — seed `API.md` from the current codebase

## Supported Frameworks

| Framework | Route detection | Framework label |
|---|---|---|
| [Hono](https://hono.dev) | ✓ | `hono` |
| [Express](https://expressjs.com) | ✓ | `express` |
| [itty-router](https://itty.dev/itty-router) | ✓ | `itty` |
| Others | ✓ (via regex, framework shown as `unknown`) | `unknown` |

Any router with the `router.METHOD('/path', handler)` pattern will work; only the framework label depends on import detection.

## Downstream integrations

### cc-taskrunner — mission brief fingerprinting

[cc-taskrunner](https://github.com/Stackbilt-dev/cc-taskrunner) runs Claude Code in unattended sessions. Starting in **1.4.0**, it calls `charter surface --markdown` on the target repo and injects the result as a `## Project Context (auto-generated)` section in every mission brief. This gives the agent an immediate routes + schema map so it doesn't burn exploration turns figuring out the codebase layout.

Output is capped at 80 lines to protect the prompt budget, and the whole feature no-ops gracefully when charter isn't installed. Opt out via `CC_DISABLE_FINGERPRINT=1`.

See [cc-taskrunner/taskrunner.sh](https://github.com/Stackbilt-dev/cc-taskrunner/blob/main/taskrunner.sh) — look for `build_fingerprint()` and the "Project fingerprint" comment block.

## Requirements

- Node >= 18
- One runtime dependency: [zod](https://zod.dev) (authoritative input/output schemas)

## License

Apache-2.0

## Links

- [Repository](https://github.com/Stackbilt-dev/charter)
- [Issues](https://github.com/Stackbilt-dev/charter/issues)
- [Charter CLI](https://github.com/Stackbilt-dev/charter/tree/main/packages/cli)

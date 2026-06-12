# @stackbilt/scaffold-core

Zero-dependency scaffold engine core for [Charter Kit](https://github.com/Stackbilt-dev/charter).

> **v0.1.0 — Experimental skeleton.** All module implementations are stubs that throw `Not implemented`. Child issues will land the module bodies. See the [Charter roadmap](https://github.com/Stackbilt-dev/charter/issues) for progress.

## What this is

`@stackbilt/scaffold-core` is the extracted scaffold engine from stackbilt-web, published as a standalone OSS package. It provides:

| Module | Responsibility |
|---|---|
| `classify/` | Pattern detection + trait extraction + quality profiling |
| `knowledge/` | Per-pattern threat catalog + ADR fragments |
| `governance/` | Threat model, ADR, and test plan document generation |
| `codegen/` | Route + file generation + wrangler binding output |
| `materializer/` | ADF + project file assembly |

The root `buildScaffold(intention, options?)` orchestrates the full pipeline.

## Constraints

- **Zero runtime dependencies** — no Zod, no external packages, pure TypeScript
- **Zero inference** — no LLM calls, no network requests
- **Zero network** — fully local, works offline

## Usage (once modules are implemented)

```typescript
import { buildScaffold } from '@stackbilt/scaffold-core';

const result = await buildScaffold('Build a KV-backed rate-limiting worker');
// result.classification.pattern === 'worker'
// result.files → ScaffoldFile[]
// result.governance.threatModel → string (Markdown)
```

## License

Apache-2.0 — Stackbilt LLC

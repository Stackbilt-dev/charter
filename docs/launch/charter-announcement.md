# Charter: treating AI-agent context like compiled source

Every coding agent starts with the same deceptively simple feature: put project instructions in a file.

That works until the file becomes important.

One repository accumulates a `CLAUDE.md`, an `AGENTS.md`, a `.cursorrules`, and a `GEMINI.md`. Universal rules sit beside frontend conventions, database constraints, release procedures, and security requirements. Every task sees context it does not need. Copies drift. Nobody can easily tell which rule is current or whether an important constraint was loaded at all.

I built [Charter](https://github.com/Stackbilt-dev/charter) to treat that context as compiled source.

## One modular source, multiple agents

Charter stores project context in a `.ai/` module tree:

```text
.ai/
├── manifest.adf
├── core.adf
├── frontend.adf
├── backend.adf
└── security.adf
```

The manifest separates rules that always load from modules that load only when task keywords match. The same source compiles into `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, and `GEMINI.md`. Generated files can be checked in CI, so a manual edit or stale vendor file becomes visible instead of silently drifting.

Resolution is deterministic string matching. It does not ask another model to decide which context a model should receive.

## Try the read-only part first

The first command does not modify the repository:

```bash
npx @stackbilt/cli score
```

It grades agent configuration, grounding, architecture, testing, governance, and freshness, then returns the five highest-impact fixes. It needs no Charter account. After `npx` obtains the package, the audit runs locally without a product service call.

If the model fits your workflow, bootstrap the modular source and compile the vendor files:

```bash
npx @stackbilt/cli bootstrap --yes
npx charter adf compile --target all --write
```

## A benchmark you can rerun

The repository now includes a [context-routing benchmark](https://github.com/Stackbilt-dev/charter/tree/main/examples/context-routing-benchmark), not just a screenshot of favorable output.

The fixture begins with 30 identified rules in one flat instruction document. The modular version contains the same 30 rules split across core, frontend, backend, security, and release modules. The runner verifies every rule is preserved byte-for-byte, executes four pinned tasks through Charter's actual parser, resolver, bundler, and task tokenizer, and compares the output with a committed snapshot.

Current result:

| Task | Baseline | Routed | Reduction |
|---|---:|---:|---:|
| Frontend | 580 | 252 | 56.6% |
| Secure API | 580 | 348 | 40.0% |
| Release | 580 | 242 | 58.3% |
| Core only | 580 | 131 | 77.4% |

Average estimated context reduction: **58.1%**.

These are estimated context tokens, not a claim about model quality or provider billing. Charter uses a documented structural heuristic of roughly four characters per token. The fixture proves deterministic routing, preservation, and relative reduction. It does not prove that an LLM follows every instruction.

You can reproduce it with:

```bash
pnpm run build
pnpm run benchmark:context
```

## ADF has a neutral home

Charter implements [ADF—Attention-Directed Format](https://github.com/adf-spec/adf), but does not own the standard.

ADF Draft 0.1 specifies the document format, manifest, deterministic resolution algorithm, Markdown interoperability, and conformance levels. The specification and fixtures live in the neutral `adf-spec` organization under Apache-2.0. Charter is the TypeScript reference implementation; other implementations are explicitly welcome.

That separation matters. A context format is useful only if teams can adopt it without accepting one vendor's runtime or roadmap.

## What I want feedback on

I am not looking only for stars. I would rather see:

- scores from real repositories;
- tasks where the routing model loads too much or too little;
- critiques of the scoring rubric;
- competing ADF implementations against the conformance fixtures;
- examples where modular context does not fit the way an agent host behaves.

Charter is available at [github.com/Stackbilt-dev/charter](https://github.com/Stackbilt-dev/charter). The specification is at [github.com/adf-spec/adf](https://github.com/adf-spec/adf).

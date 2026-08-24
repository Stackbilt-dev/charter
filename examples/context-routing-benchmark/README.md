# Context Routing Benchmark

This fixture demonstrates one narrow claim: deterministic task routing can reduce the amount of project instruction context presented for a task without dropping rules from the source corpus.

![Charter context routing benchmark result](../../docs/assets/context-routing-benchmark.svg)

The example is synthetic and intentionally small. It contains 30 identified rules for a TypeScript storefront:

- [`before/AGENTS.example.md`](./before/AGENTS.example.md) is the flat human-readable source, named as a fixture so agents do not treat it as live repository instructions.
- [`before/.ai/monolith.adf`](./before/.ai/monolith.adf) is the mechanically equivalent all-rules baseline used by Charter's estimator.
- [`after/.ai/`](./after/.ai/) contains the same rules split into one default and four on-demand modules.
- [`tasks.json`](./tasks.json) pins four tasks and their expected resolved modules.
- [`expected-results.json`](./expected-results.json) is the reviewed output snapshot.

## Run it

From the Charter repository root:

```bash
pnpm run build
pnpm run benchmark:context
```

Machine-readable output:

```bash
node examples/context-routing-benchmark/run.mjs --json
```

[`demo.tape`](./demo.tape) is a checked-in [VHS](https://github.com/charmbracelet/vhs) recording source for regenerating the launch GIF after a reviewed snapshot change:

```bash
vhs examples/context-routing-benchmark/demo.tape
```

The runner uses Charter's shipped ADF parser, manifest resolver, bundler, and CLI task tokenizer. It also verifies that every rule identifier appears exactly once before and after modularization. `--check` compares the live result with the committed snapshot and exits non-zero on any behavioral change.

## Current result

| Task | Baseline | Routed | Reduction | Modules loaded |
|---|---:|---:|---:|---|
| Frontend | 580 | 252 | 56.6% | `core`, `frontend` |
| Secure API | 580 | 348 | 40.0% | `core`, `backend`, `security` |
| Release | 580 | 242 | 58.3% | `core`, `release` |
| Core only | 580 | 131 | 77.4% | `core` |

Average estimated context reduction: **58.1%**.

## What this does and does not prove

This benchmark proves that Charter's deterministic reference implementation:

- preserves the fixture's complete rule inventory;
- resolves the expected module set for each pinned task;
- produces the snapshotted estimated-token counts;
- detects routing or estimation changes in CI.

It does not prove that an LLM follows the routed rules more accurately, nor does it predict a provider bill. Charter estimates tokens using its documented structural heuristic of roughly four characters per token. Use these numbers for relative context comparisons only.

## Specification relationship

[ADF](https://github.com/adf-spec/adf) is the vendor-neutral format and deterministic resolution specification. Charter is the TypeScript reference implementation exercised here. The standard belongs in `adf-spec/adf`; this benchmark belongs here because it tests Charter's implementation and product workflow.

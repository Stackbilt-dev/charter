# Launch FAQ

## Is this another proprietary agent-instruction format?

ADF is Apache-2.0 and maintained in the vendor-neutral [`adf-spec`](https://github.com/adf-spec/adf) organization. Charter is the TypeScript reference implementation, not the owner of the standard. The conformance suite is intended to support independent implementations.

## Does ADF replace AGENTS.md?

No. ADF is a modular layer above flat agent files. Charter compiles default context into `AGENTS.md` and adds an ordinary Markdown index for on-demand modules. ADF-aware tools can resolve modules directly; other tools still receive readable instructions.

## Why invent a format instead of using Markdown files in folders?

Folders solve storage, not interoperability. ADF pins loading policy, trigger resolution, section weights, metric ceilings, deterministic compilation, and conformance behavior. The files remain plain text.

## Does an LLM choose which modules load?

No. Draft 0.1 resolution uses deterministic, case-insensitive exact or prefix-stem matching. Given the same manifest and keywords, conforming implementations must return the same ordered module set.

## Is `charter score` safe to try?

The default score command reads repository files and prints a report. It does not change project files. `--badge --write` is the explicit mode that writes `.charter/badge.json`. `npx` may download the npm package if it is not cached.

## Does Charter send repository contents anywhere?

The Charter product commands described in the launch run locally and do not send repository contents to a Charter service. npm may be contacted to obtain the package. Optional external tooling or user-configured integrations have their own behavior.

## Are the benchmark numbers real tokens?

They are Charter's estimated tokens, calculated with its structural approximation of roughly four characters per token. They are useful for comparing the same corpus before and after routing. They are not exact provider tokenizer counts or billing predictions.

## Does the benchmark prove models follow instructions better?

No. It proves fixture preservation, deterministic module selection, and relative estimated-context reduction. Model adherence requires a separate controlled evaluation.

## Why is the benchmark synthetic?

It makes every input, expected module, rule identity, and result publishable and stable in CI. Charter also publishes a real greenfield case study, but the small synthetic fixture is easier for anyone to rerun and challenge.

## Why trigger keywords instead of embeddings?

Deterministic triggers are local, inspectable, inexpensive, and conformable across implementations. Semantic routing may be explored later, but it should not silently replace predictable baseline behavior.

## What happens when no trigger matches?

Default modules still load. On-demand modules do not. The bundle report exposes unmatched modules and trigger details so a routing gap can be diagnosed.

## Can I implement ADF in another language?

Yes. Choose a conformance level—parser, resolver, compiler, or full—run the published fixtures, and open an issue or pull request to be listed as an implementation.

## Is Charter only for TypeScript repositories?

No. Charter itself is implemented in TypeScript and requires Node to run, but it can govern non-Node repositories, including Rust/WASM projects.

# Publication Copy

The blocks below are final copy. Do not append generic hashtags to Hacker News or Reddit posts.

## Hacker News — Charter

### Title

Show HN: Charter – compile modular context for Claude, Codex, Cursor and Gemini

### Text

I kept accumulating instructions in CLAUDE.md, AGENTS.md and .cursorrules. They duplicated each other, unrelated rules loaded for every task, and changes drifted between tools.

I built Charter, an Apache-2.0 local CLI that treats agent context like compiled source. Rules live in small `.ai/` modules, a manifest loads modules using deterministic task triggers, and Charter compiles the source back into each supported vendor format.

The first command is deliberately read-only:

`npx @stackbilt/cli score`

It grades a repo's agent configuration and gives five prioritized fixes. No account is required; after npm obtains the package, the audit makes no product service call.

I also added a reproducible benchmark rather than relying on a screenshot. It verifies 30/30 fixture rules byte-for-byte and measures 40.0–77.4% less estimated task context across four pinned tasks (58.1% average). The estimator is ~4 chars/token, so this is a relative routing measurement, not a provider billing claim:

https://github.com/Stackbilt-dev/charter/tree/main/examples/context-routing-benchmark

ADF, the underlying format, has a separate vendor-neutral specification and conformance suite:

https://github.com/adf-spec/adf

I would especially value criticism of the routing model, scoring rubric, and compiled-file approach. Where would this break in your actual multi-agent workflow?

## Hacker News — ADF

### Title

ADF: A draft specification for modular, progressively disclosed agent context

### Text

We published ADF Draft 0.1 as an Apache-2.0, vendor-neutral specification for the modular layer above AGENTS.md-style files.

It defines a plain-text module format, default versus on-demand loading, a deterministic keyword resolver, token budgets, and compilation back to flat vendor files. It complements AGENTS.md rather than replacing it.

The repository includes parser, resolver, and compiler conformance fixtures. Normative changes require fixtures in the same PR. Charter is the current TypeScript reference implementation, but additional implementations are welcome.

Spec: https://github.com/adf-spec/adf/blob/main/SPEC.md

Conformance: https://github.com/adf-spec/adf/tree/main/conformance

The questions I most want challenged are the prefix-stem matching rule, the graceful-degradation module index, and whether the current fixtures leave important behavior ambiguous.

## Reddit or developer forum — Charter

### Title

My coding-agent rule files became a second codebase, so I built a compiler for them

### Text

Disclosure: I built this.

I was maintaining the same project rules across CLAUDE.md, AGENTS.md, .cursorrules and GEMINI.md. Universal constraints, frontend conventions, security rules and release steps all ended up in the same flat context—or drifted between copies.

Charter moves the source into small `.ai/` modules. A manifest deterministically selects modules by task keyword, and a compiler generates the vendor files. It is Apache-2.0, local-first and does not call an LLM to route context.

You can inspect a repo before letting it write anything:

`npx @stackbilt/cli score`

I created a reproducible synthetic benchmark with 30 identified rules and four pinned tasks. The runner verifies that every rule remains byte-for-byte identical, then checks the resolved modules and estimated context against a committed snapshot. Current reduction is 40.0–77.4%, averaging 58.1%:

https://github.com/Stackbilt-dev/charter/tree/main/examples/context-routing-benchmark

Important limitation: the estimator uses roughly four characters per token. This measures relative routed context; it does not claim better model adherence or exact API cost.

ADF itself lives in a separate neutral spec repository: https://github.com/adf-spec/adf

What is the most painful failure mode in your current agent instructions: size, duplication, stale rules, or the wrong context loading for a task?

## LinkedIn

AI coding agents do not always suffer from missing instructions. They often suffer from undifferentiated instructions.

One flat file accumulates architecture constraints, UI preferences, security requirements and release procedures. Then teams copy it for multiple agent vendors and the copies drift.

We built Charter to treat agent context like compiled source:

→ one modular `.ai/` source
→ deterministic task-based routing
→ generated files for Claude Code, Codex, Cursor and Gemini
→ measurable context budgets and CI checks

The first command is read-only:

`npx @stackbilt/cli score`

We also published a reproducible benchmark. It preserves 30/30 fixture rules byte-for-byte and measures an average 58.1% reduction in estimated task context across four pinned tasks. The raw fixtures, runner, expected snapshot and limitations are all public.

Charter: https://github.com/Stackbilt-dev/charter

Benchmark: https://github.com/Stackbilt-dev/charter/tree/main/examples/context-routing-benchmark

ADF specification: https://github.com/adf-spec/adf

I am looking for real repository scores and hard criticism of the routing model—not just impressions.

#ContextEngineering #AIAgents #DeveloperTools #OpenSource

## X thread

### 1

Your coding-agent instructions eventually become a second codebase.

CLAUDE.md. AGENTS.md. .cursorrules. GEMINI.md.

Same rules, different copies, every task loading context it may not need.

We built Charter to compile them. 🧵

### 2

Charter uses one modular `.ai/` source.

A manifest keeps universal rules loaded and activates specialist modules through deterministic task triggers.

No LLM decides what context an LLM receives.

### 3

Start read-only:

`npx @stackbilt/cli score`

It grades agent config, grounding, architecture, testing, governance and freshness—then gives five prioritized fixes.

### 4

We published a rerunnable benchmark:

• 30/30 rules preserved byte-for-byte
• 4 pinned tasks
• 40.0–77.4% less estimated task context
• 58.1% average reduction

Raw fixture + snapshot: https://github.com/Stackbilt-dev/charter/tree/main/examples/context-routing-benchmark

### 5

Limitations matter.

The estimator is roughly 4 characters/token. This validates deterministic routing and relative context reduction—not exact provider billing or better model adherence.

### 6

ADF, the underlying format, is not locked inside Charter.

It has a vendor-neutral Apache-2.0 specification and conformance suite. Charter is the TypeScript reference implementation; alternatives are welcome.

https://github.com/adf-spec/adf

### 7

Charter: https://github.com/Stackbilt-dev/charter

Run your score and share the result. Better yet, tell us where the router or rubric is wrong in your real repo.

## Product Hunt

### Tagline

Compile one modular context source for every AI coding agent

### Short description

Charter replaces drifting agent instruction files with task-routed `.ai/` modules, compiles them for Claude Code, Codex, Cursor and Gemini, and grades repository AI-readiness locally.

### Maker comment

We built Charter after our agent instruction files became large, duplicated and difficult to verify. Charter treats context as compiled source: modular inputs, deterministic routing, measurable budgets and generated vendor files.

The first experience is a read-only repository score, and the project includes a rerunnable benchmark with raw fixtures and explicit limitations. ADF, the underlying format, lives in a separate vendor-neutral specification repository.

We would love feedback from developers using multiple coding agents—especially examples where the routing model selects the wrong context.

# ADF Draft 0.1: a vendor-neutral format for modular AI-agent context

`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, and `GEMINI.md` made repository instructions practical. They also created a scaling problem: project context is flat, duplicated across vendors, and commonly loaded without regard to the current task.

[ADF—Attention-Directed Format](https://github.com/adf-spec/adf) is a draft, vendor-neutral specification for a modular layer above those files.

ADF specifies four things:

1. A plain-text document format with explicit load-bearing and advisory sections.
2. A manifest that separates default context from on-demand modules.
3. A deterministic task-keyword resolution algorithm that requires no model inference.
4. A compilation contract for interoperating with flat Markdown agent files.

ADF complements `AGENTS.md`; it does not replace it. A conforming compiler renders default modules into the flat entry point and includes an ordinary Markdown index telling agents when to read on-demand modules. Hosts that understand ADF can inject matching modules directly. Hosts that do not still receive a readable progressive-disclosure instruction.

## Conformance over branding

The repository contains authoritative parser, resolver, and compiler fixtures. They cover minimal documents, section types, weights, missing version declarations, emoji decoration, default loading, exact triggers, prefix-stem matching, no-match behavior, multi-trigger behavior, defaults-only compilation, and compilation with a module index.

Where specification prose and fixtures disagree, the fixtures win and the prose has a bug.

[Charter](https://github.com/Stackbilt-dev/charter) is the current TypeScript reference implementation. Additional implementations are welcome and can be listed once they pass the applicable conformance level.

## Draft governance

ADF is in a bootstrap governance phase. Normative changes happen through pull requests and require a conformance fixture in the same change. The project intends to align with, rather than fork, broader `AGENTS.md` and Agentic AI Foundation work—including moving the specification to a more appropriate neutral foundation if that best serves adoption.

## Review requested

The most useful feedback now is specific:

- Is the 66% prefix-stem trigger rule predictable enough across real repositories?
- Does the module-index fallback work with the agent hosts you use?
- Which normative behavior is still ambiguous or absent from the fixtures?
- Would you implement the parser, resolver, compiler, or full conformance level in another language?

Read the [specification](https://github.com/adf-spec/adf/blob/main/SPEC.md), inspect the [conformance suite](https://github.com/adf-spec/adf/tree/main/conformance), or open an issue at [github.com/adf-spec/adf](https://github.com/adf-spec/adf).

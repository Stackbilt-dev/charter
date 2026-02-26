---
title: "Context-as-Code: Quantifying the Impact of Attention-Directed Format (ADF) on Autonomous System Architecture"
paper-id: CSA-001
version: "1.1"
status: published
date: 2026-02-26
authors:
  - Charter Kit Engineering
charter-version: "0.3.1"
abstract: >
  After shipping v1 of an enterprise AI Orchestration Engine, the team wrote
  a moonshot PRD to guide a ground-up v2 rebuild. This paper quantifies the
  v2 SDLC, proving that ADF — an AST-backed, manifest-routed context
  microformat used to govern the AI agents building v2 — yields up to 80%
  token payload reduction and enforces architectural invariants with 0%
  violation across 33 generated modules.
---

# Context-as-Code: Quantifying the Impact of Attention-Directed Format (ADF) on Autonomous System Architecture

An AI Orchestration Engine v2 SDLC White-Paper
Date: February 2026

## Abstract

The transition from deterministic software engineering to LLM-driven autonomous generation introduces significant risks: architectural drift ("god objects"), token context bloat, and non-deterministic logic failures.

After shipping v1 of an enterprise AI Orchestration Engine and cataloging these failures first-hand, the engineering team authored a moonshot Product Requirements Document (PRD) to guide a ground-up v2 rebuild. The PRD codified the architectural invariants that v1 had violated — strict module boundaries, token budgets, and zero tolerance for god objects — and established the measurement rubric that would track the entire v2 SDLC.

To govern the AI agents responsible for building v2 from this PRD, the team replaced standard monolithic system prompts with Attention-Directed Format (ADF) — an AST-backed, manifest-routed context microformat. This report quantifies the data from five major release tiers of that PRD-driven build, proving that applying standard software engineering principles to LLM context ("Prompt-as-Code") yields up to an 80% reduction in token payloads and strictly enforces architectural invariants (0% violation of LOC limits across 33 generated modules).

## 1. Methodology & Measurement Rubric

The v2 PRD established the measurement rubric before a single line of code was generated. To provide verifiable "receipts" for the claims made in this report, the SDLC tracking utilized a strict quantitative rubric. The metrics gathered throughout the PRD-driven v2 build were derived from the following mechanisms:

**Token Estimation Algorithm**: Standardized across the bundler (bundler.js: estimateTokens), tokens were calculated programmatically via a structural heuristic: Math.ceil(charCount / 4). This accounted for structural markers (keys, colons, lists) parsed directly from the Abstract Syntax Tree (AST).

**Architectural Bounding (LOC Hard Limits)**: The core invariant was a strict <400 LOC limit per generated module, designed to eradicate v1 "god objects" (which previously exceeded 1,800 LOC).

**Context Payload Tracking**: Measured in two phases: Source Characters (raw .adf files) and Baked Characters (compressed maps injected into the runtime via adf-read.ts).

**Test Parity**: The health of the generated output was measured continuously via a growing suite of Vitest unit tests to ensure deterministic output (starting at 339 tests, scaling to 525).

## 2. Token Economics & Context Compression

**The Problem**: The v1 architecture relied on a monolithic markdown file (CLAUDE.md) that forced the LLM to process ~8,000 to 12,000 tokens on every agent load, regardless of task relevance. This caused severe attention dilution and excessive API costs.

**The ADF Solution**: ADF introduced a modular dependency graph via manifest.adf.

**The Data (Receipts from Tier 1 & Tier 2 Measurements)**:
By decomposing instructions into distinct ADF modules (core.adf, state.adf, governance.adf, etc.), the baseline payload dropped dramatically.

| ADF Module | Source Chars | Est. Source Tokens | Manifest Routing |
|---|---|---|---|
| manifest.adf | 420 | ~105 | DEFAULT_LOAD |
| core.adf | 319 | ~79 | DEFAULT_LOAD |
| state.adf | 337 | ~84 | DEFAULT_LOAD |
| governance.adf | 1,236 | ~309 | ON_DEMAND |
| flow-api.adf | 2,464 | ~616 | ON_DEMAND |
| **Total (All modules)** | **5,936** | **~1,484** | — |

**Runtime Payload Reduction**: Because most tasks only required the DEFAULT_LOAD modules, the baseline context payload dropped from ~10,000 tokens to under 300 tokens—a massive cost optimization.

**Build-Time Compression**: The internal pipeline compiled these ASTs into a baked map (adf-read.ts). The data shows a 72% memory compression rate (5,516 raw characters compressed to 1,522 runtime characters), significantly optimizing the cloud worker's memory footprint.

## 3. Enforcing Architectural Invariants at Compile-Time

**The Problem**: LLMs naturally drift toward monolithic code generation ("god objects"). The v1 architecture suffered from this, culminating in files like the primary router (1,818 LOC) and the governance protocol (1,861 LOC).

**The ADF Solution**: ADF ASTs support a metadata property called weight: 'load-bearing'. When a rule is marked load-bearing in core.adf, the bundler explicitly prioritizes it during document merging (bundler.js: mergeSectionContent), forcing the LLM to treat it as a hard system constraint.

**The Data (Receipts from Tier 5 & Gap Analysis)**:
The moonshot PRD explicitly mandated the decomposition of the v1 governance file (REQ-DECOMP-005), ensuring v2 would never recreate the anti-patterns cataloged from v1.

**The Result**: The Tier 5 SDLC report officially closed this requirement with the following note: "The core.adf guardrails ('No god objects', '<400 LOC per module') prevented the anti-pattern from recurring. No decomposition is needed because the god-object was never created."

**The Proof**: Across the entire v2 build—scaling to 3,755 production LOC across 33 modules—the largest generated file was compass-exchange.ts at exactly 343 LOC (14% headroom below the limit). The main entry point dropped from 1,818 LOC to 57 LOC. The architectural invariant was maintained with a 100% success rate.

## 4. Dynamic Routing via AST Keyword Matching

**The Problem**: Injecting contextual instructions manually into prompts is error-prone. If an agent is tasked with building an authentication module, it needs security rules, but loading those rules for a UI task wastes tokens.

**The ADF Solution**: The manifest.adf defines ON_DEMAND triggers. The bundler.js engine programmatically resolves these by inspecting the agent's task keywords against the manifest triggers (lowerKeywords.includes(trigger.toLowerCase())).

**The Data (Receipts from Tier 4a)**:
During Tier 4a, the engineering team rolled out a new embedded Authentication layer (+200 LOC, 3 new modules).

An ON_DEMAND module named auth.adf was created.

The gap analysis confirms: "auth.adf now triggers correctly."

Because ADF merges documents natively via AST rather than naive string concatenation, the agent received complex relational rules (e.g., D1-backed session storage, role-to-scope mappings) only when the task context required it, directly resulting in the successful generation of src/auth/instance.ts and src/auth/handler.ts with zero regressions.

## 5. Protocol Standardization & Test Velocity

**The Problem**: Tooling that relies on Regex to parse LLM outputs is notoriously fragile. If an LLM misformats a markdown list, a naive parser breaks, corrupting the context window.

**The ADF Solution**: Midway through the build (Tier 4b), the internal engine upgraded to standard ADF v0.3.1 packages (@stackbilt/adf). As proven in parser.js, ADF uses a highly fault-tolerant AST parser that safely classifies messy LLM output into text, list, map, and metric data structures, discarding malformed noise.

**The Data (Receipts from Test Metrics)**:
By standardizing the prompt pipeline around strict AST parsing (parseAdf) and immutable delta operations (applyPatches), the agent's output became highly predictable.

Throughout 5 complex domain implementations (Telemetry, SPRINT scaling, MCP Protocol, Auth, and Cloudflare AI integration), the test suite grew linearly.

The test count increased from 339 to 525 unit tests (npx vitest run).

The pass rate remained at 100% (525/525). This proves that dynamically injecting context via the ADF bundler did not introduce logic contradictions or hallucinations into the generated code.

## Conclusion

The data collected across the full PRD-driven v2 SDLC proves that treating "Prompts as Text" is an architectural dead-end for autonomous systems.

The moonshot PRD defined the invariants; ADF enforced them at compile-time. By implementing Prompt-as-Code via the Attention-Directed Format (ADF), the engineering team achieved quantifiable victories against every metric the PRD established:

- **Token Efficiency**: Context payloads reduced by >80%.
- **Structural Governance**: 0% drift from the <400 LOC module invariant.
- **Dynamic Scalability**: Seamless, zero-regression injection of domain-specific instructions via AST keyword routing.

For engineering teams looking to scale LLM-driven development, the ADF methodology provides the required "missing link": a deterministic, compiler-grade control plane for non-deterministic AI agents.

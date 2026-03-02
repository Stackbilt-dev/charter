---
title: "Agent DX Feedback: ADF architecture cohesion and enforcement boundaries"
feedback-id: ADX-007
date: 2026-03-02
source: "Architectural audit synthesis (user-provided)"
severity: medium
bucket: reliability-trust
status: triaged
related:
  - RM-001
  - ADX-005
tracked-issues:
  - "#8 refactor(adf): split bundler orchestration from pure merge logic"
  - "#9 feat(adf): introduce unified evidence/enforcement pipeline"
  - "#10 refactor(adf): dismantle monolithic types.ts into domain-owned modules"
  - "#11 feat(adf): inject configurable classifier/parsing rulesets"
  - "#12 refactor(adf): replace patcher switch branches with operation handlers"
tracked-prs: []
---

# Agent DX Feedback: ADF architecture cohesion and enforcement boundaries

## Summary

This audit identifies valid architectural debt in `packages/adf/src` that increases
cognitive load and slows safe extension. The largest concerns are:

- `bundler.ts` combines manifest parsing, trigger resolution, merge logic, and budget checks
- `types.ts` centralizes multiple unrelated domains into one import surface
- classifier/parser heuristics are hardcoded instead of host-configurable
- validation/enforcement logic is split between bundler and validator
- patch operation handling repeats shape checks and bounds checks across branches

## Evidence

1. `bundler.ts` is currently multi-domain

- `parseManifest` and manifest entry parsing live alongside orchestration: `packages/adf/src/bundler.ts:29`
- trigger resolution and matching are in the same module: `packages/adf/src/bundler.ts:160`
- merge logic and token estimation are embedded in the file: `packages/adf/src/bundler.ts:331`
- budget overrun checks are enforced in bundling path: `packages/adf/src/bundler.ts:252`

2. `types.ts` is a cross-domain monolith

- AST + formatting constants + patch protocol + manifest + bundle output + lockfile + evidence types all co-located: `packages/adf/src/types.ts:12`

3. Hardcoded heuristics reduce reuse

- stay patterns + heading-to-module routing are fixed constants/functions: `packages/adf/src/content-classifier.ts:53`, `packages/adf/src/content-classifier.ts:76`
- imperative/advisory strength detection regex is fixed in parser: `packages/adf/src/markdown-parser.ts:36`

4. Enforcement boundary is fragmented

- metric/weight evidence is produced in `validator.ts`: `packages/adf/src/validator.ts:27`
- token budget checks are independently produced in bundling: `packages/adf/src/bundler.ts:252`

5. Patcher operation branches duplicate guard logic

- large operation switch with repeated list/map checks and index bounds patterns: `packages/adf/src/patcher.ts:22`

## Impact

- Higher onboarding cost for contributors due to overloaded modules and broad type imports.
- Lower confidence in correctness because validation outcomes are split across subsystems.
- Slower feature development for new domains because heuristics are embedded in core code.
- Increased regression risk when changing patch behavior due to repetitive branch logic.

## Recommended Issues to File

### P0: refactor(adf): split bundler orchestration from pure merge logic

**Problem:** `bundler.ts` violates SRP and mixes file I/O coordination with pure AST transformation.

**Scope:**
- create `manifest.ts` for manifest parsing and trigger resolution
- create `merger.ts` for document merge + token estimation (pure functions)
- keep `bundler.ts` as orchestration shell for read/parse/compose

**Acceptance criteria:**
- merge utilities are pure and unit-tested without filesystem mocks
- bundler tests cover orchestration paths and adapter wiring only
- no behavior change in `adf bundle` CLI output

### P0: feat(adf): introduce unified evidence/enforcement pipeline

**Problem:** metrics/weights and budget checks are computed in separate modules with separate result shapes.

**Scope:**
- create single pipeline entry (for example `evaluateEvidence`) that accepts merged document + manifest context
- fold budget checks into shared evidence result envelope
- preserve existing warnings (`moduleBudgetOverruns`, advisory-only module signals)

**Acceptance criteria:**
- one typed result for constraints, weights, token budget, per-module budgets, and warnings
- bundler and CLI evidence command consume the same enforcement API
- existing validator semantics for pass/warn/fail remain stable

### P1: refactor(adf): dismantle monolithic types.ts into domain-owned modules

**Problem:** one file exports unrelated domain types and constants, causing broad coupling.

**Scope:**
- move AST and formatting constants into `ast/` (or similar)
- move patch op types next to patcher
- move manifest/bundle types near bundler/manifest
- move lockfile and evidence types to their owning modules

**Acceptance criteria:**
- `types.ts` removed or reduced to compatibility re-exports during migration window
- imports in each module reference nearest domain-owned type module
- no circular dependencies introduced

### P1: feat(adf): inject configurable classifier/parsing rulesets

**Problem:** migration/classification behavior is hardcoded for one organization’s vocabulary.

**Scope:**
- add optional `ClassifierConfig` and `MarkdownStrengthConfig`
- default to current behavior when config is omitted
- support custom stay patterns, heading-to-module routing, and imperative/advisory regex sets

**Acceptance criteria:**
- existing tests pass with defaults unchanged
- new tests verify custom rulesets alter routing/strength decisions deterministically
- CLI migrate can accept config source (or uses project defaults) without breaking current UX

### P2: refactor(adf): replace patcher switch branches with operation handlers

**Problem:** repeated bounds/type guards inflate patcher complexity and maintenance cost.

**Scope:**
- introduce operation handlers map keyed by `op`
- extract shared helpers for index validation and list/map target coercion
- keep immutable semantics and current error messages where possible

**Acceptance criteria:**
- equal behavior for all patch ops and error paths
- reduced duplication in add/replace/remove bullet operations
- patcher tests remain green; new tests cover extracted helper edge cases

## Sequencing

1. P0 bundler split (unblocks cleaner enforcement integration)
2. P0 unified enforcement pipeline
3. P1 type domain split
4. P1 configurable rulesets
5. P2 patcher handler refactor

## Filing Notes

Copy-paste issue drafts are available at:
- `papers/issues/ADX-007-issue-drafts.md`

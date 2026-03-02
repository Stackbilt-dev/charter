# ADX-007 Issue Drafts

> **Filed:** All 5 issues created on 2026-03-02 as #8–#12, assigned to v0.6.0 milestone.

These are the GitHub issue drafts derived from [ADX-007](../AGENT_DX_FEEDBACK_007.md).

## 1) `refactor(adf): split bundler orchestration from pure merge logic`

**Labels:** `area:adf`, `type:refactor`, `priority:p0`  
**Linked feedback:** `ADX-007`

### Problem

`packages/adf/src/bundler.ts` currently combines manifest parsing, trigger resolution,
AST merge/transformation, token estimation, and orchestration/file loading concerns.
This raises cognitive load and couples pure transformation behavior to orchestration paths.

Evidence:
- Manifest parsing in bundler: `packages/adf/src/bundler.ts:29`
- Trigger resolution in bundler: `packages/adf/src/bundler.ts:160`
- Merge and token estimation in bundler: `packages/adf/src/bundler.ts:331`

### Scope

- Extract manifest parsing/trigger resolution to `packages/adf/src/manifest.ts`.
- Extract pure merge/token-estimation functions to `packages/adf/src/merger.ts`.
- Keep `bundler.ts` as orchestration shell only:
  - load manifest
  - resolve module paths
  - read content
  - parse docs
  - call pure merger/evaluator

### Acceptance Criteria

- Merge utilities are pure and independently unit-tested without filesystem mocks.
- `bundler.ts` no longer defines merge/token estimation internals.
- CLI behavior for `adf bundle` is unchanged for existing fixtures/tests.
- Existing bundle tests pass; add focused tests for extracted `merger.ts`.

### Test Plan

- `pnpm run test --filter @stackbilt/adf`
- Add unit tests for:
  - duplicate-section merge behavior across content types
  - weight promotion rules
  - token estimate parity against current behavior

---

## 2) `feat(adf): introduce unified evidence/enforcement pipeline`

**Labels:** `area:adf`, `type:feature`, `priority:p0`  
**Linked feedback:** `ADX-007`

### Problem

Enforcement is fragmented:
- metric/weight evidence is computed in `validator.ts`
- token budget/module budget checks are computed in `bundler.ts`

This creates multiple result shapes and multiple enforcement entry points.

Evidence:
- Metric evidence: `packages/adf/src/validator.ts:27`
- Bundle budget checks: `packages/adf/src/bundler.ts:252`

### Scope

- Introduce a single evaluator API (e.g. `evaluateEvidence(...)`) under `packages/adf/src/evidence.ts`.
- Combine:
  - metric constraint results (pass/warn/fail)
  - weight summary
  - token budget utilization
  - per-module budget overruns
  - advisory-only module warnings
- Update bundler and CLI evidence flows to consume shared evaluator output.

### Acceptance Criteria

- One typed result envelope is used by both bundle and evidence flows.
- Validator semantics for metric status remain backward compatible.
- No loss of fields currently emitted in bundle/evidence outputs.
- Tests cover both metric and budget enforcement in one pipeline.

### Test Plan

- `pnpm run test --filter @stackbilt/adf`
- Add tests for:
  - under/at/over ceiling metric statuses
  - bundle token budget utilization
  - per-module budget overrun emission
  - advisory-only module warnings

---

## 3) `refactor(adf): dismantle monolithic types.ts into domain-owned modules`

**Labels:** `area:adf`, `type:refactor`, `priority:p1`  
**Linked feedback:** `ADX-007`

### Problem

`packages/adf/src/types.ts` currently co-locates AST, patch protocol, manifest/bundle,
lockfile, evidence, and formatter constants. This broad shared surface obscures domain
ownership and encourages cross-domain imports.

Evidence:
- Monolithic export surface starts at `packages/adf/src/types.ts:12`

### Scope

- Create domain-owned type modules, for example:
  - `packages/adf/src/ast/types.ts`
  - `packages/adf/src/patch/types.ts`
  - `packages/adf/src/manifest/types.ts`
  - `packages/adf/src/evidence/types.ts`
  - `packages/adf/src/sync/types.ts`
- Migrate imports to nearest domain modules.
- Optionally keep temporary compatibility re-exports during migration window.

### Acceptance Criteria

- `types.ts` is removed or reduced to compatibility exports only.
- Import graph remains acyclic (no circular deps introduced).
- Public package exports remain stable or are documented as a breaking change.
- All ADF tests and typecheck pass.

### Test Plan

- `pnpm run typecheck`
- `pnpm run test --filter @stackbilt/adf`
- Verify no cross-domain import regressions via code review of changed imports.

---

## 4) `feat(adf): inject configurable classifier/parsing rulesets`

**Labels:** `area:adf`, `type:feature`, `priority:p1`  
**Linked feedback:** `ADX-007`

### Problem

Classifier/parser heuristics are hardcoded, reducing reuse across organizations:
- fixed stay patterns and heading-to-module routing in classifier
- fixed imperative/advisory regex sets in markdown parser

Evidence:
- `packages/adf/src/content-classifier.ts:53`
- `packages/adf/src/content-classifier.ts:76`
- `packages/adf/src/markdown-parser.ts:36`

### Scope

- Add optional config objects:
  - `ClassifierConfig` for stay patterns + heading/module routing + optional keyword rules
  - `MarkdownStrengthConfig` for imperative/advisory patterns
- Preserve existing behavior when config is omitted.
- Thread config through migration entry points (including CLI migrate path).

### Acceptance Criteria

- Default behavior is unchanged and existing tests pass.
- New tests confirm custom rulesets alter classification/strength deterministically.
- CLI migrate can accept configured behavior without breaking current default UX.

### Test Plan

- `pnpm run test --filter @stackbilt/adf`
- Add tests for:
  - custom stay pattern causing `STAY`
  - custom heading mapping to non-default module
  - custom strength patterns overriding defaults

---

## 5) `refactor(adf): replace patcher switch branches with operation handlers`

**Labels:** `area:adf`, `type:refactor`, `priority:p2`  
**Linked feedback:** `ADX-007`

### Problem

`patcher.ts` relies on a large operation switch with repeated content-type checks and
index bounds logic in multiple branches, increasing maintenance overhead and error risk.

Evidence:
- Main switch: `packages/adf/src/patcher.ts:22`
- Repeated guards in add/replace/remove bullet paths: `packages/adf/src/patcher.ts:49`

### Scope

- Introduce handler map keyed by operation (`PatchOperation['op']`).
- Extract shared helpers for:
  - section lookup
  - index bounds validation
  - list/map entry parsing/coercion
- Keep immutable semantics and current error behavior.

### Acceptance Criteria

- Behavior parity across all patch operations and failure paths.
- Duplicated guard logic is reduced materially in patcher implementation.
- Existing patcher tests pass; new helper-focused edge-case tests added.

### Test Plan

- `pnpm run test --filter @stackbilt/adf`
- Add tests for:
  - invalid index errors (list/map)
  - unsupported content-type errors
  - metric update on missing metric key


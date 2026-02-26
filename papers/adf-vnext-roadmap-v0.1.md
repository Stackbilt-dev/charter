---
title: "ADF vNext Roadmap (Draft): Agent DX-Driven Priorities"
paper-id: RM-001
version: "0.1"
status: draft
date: 2026-02-26
authors:
  - Charter Kit Engineering
charter-version: "next"
related:
  - ADX-001
  - ADX-002
  - ADX-003
  - CSA-002
abstract: >
  This draft roadmap converts two Agent DX feedback reports into an initial
  implementation plan for the next Charter Kit release. The focus is reducing
  ADF setup friction (greenfield bootstrapping, rule routing) and runtime
  discoverability friction (schema archaeology, missing CLI explanation paths)
  through documentation, public types, guided CLI workflows, and trigger
  validation tooling.
---

# ADF vNext Roadmap (Draft): Agent DX-Driven Priorities

Date: February 26, 2026

## 1. Why This Roadmap Exists

`ADX-001` and `ADX-002` describe two different failure modes in agent experience:

- `ADX-001` (runtime usage): an agent could not quickly discover the trivial `.adf.lock` schema and burned tokens/tool calls reading truncated compiled output.
- `ADX-002` (greenfield setup): an agent could create ADF files, but spent most of the effort deciding rule placement, section taxonomy, and CLAUDE.md vs ADF boundaries.

These are complementary. Together they suggest the next version should prioritize:

- better specification surfaces (docs, types, `--explain`)
- better authoring guidance (routing heuristics, taxonomy rules)
- better bootstrap scaffolding (thin pointer files, pattern-aware init)
- better validation and observability (trigger test tooling)
- automation-first onboarding (single-command bootstrap, post-setup install orchestration)

## 2. Product Goal for vNext

Make ADF usable by a first-time agent+user pair with minimal back-and-forth, while making ADF internals discoverable without source archaeology.

## 3. Roadmap Themes (Derived from ADX Feedback)

## Theme A: Make Hidden Format Knowledge Explicit

From `ADX-001`:

- `.adf.lock` schema is implementation-only knowledge
- public `.d.ts` breadcrumbs are missing for sync/lockfile types
- no CLI command explains the schema directly

Outcome target:

- agents can discover lockfile semantics in one docs read or one CLI command

## Theme B: Codify Rule Routing and Authoring Semantics

From `ADX-002`:

- no documented rule-routing decision tree
- section taxonomy is implicit (open/closed unclear)
- weight tags and custom sections are ambiguous

Outcome target:

- agents can place new rules correctly without user correction loops

## Theme C: Turn Manual ADF Authoring into Guided Workflows

From `ADX-002`:

- rule insertion requires multiple manual choices
- trigger keywords are freeform and untestable
- no preflight for overlap/coverage

Outcome target:

- common ADF authoring tasks are assisted by CLI commands with dry-run output

## Theme D: Align Scaffolding with Governance and ADF Architecture

From both reports:

- scaffold should emit usable `.ai/` + `.adf.lock` from day one
- tool-specific files should point to ADF, not compete with it
- blessed patterns should inform module generation

Outcome target:

- `charter adf init` produces a low-drift, CI-ready baseline

## Theme E: Automate Repo Onboarding End-to-End

From `ADX-003`:

- install/setup requires multiple command modes (`node`, `pnpm exec`, `npx`)
- `setup` can mutate `package.json` but still requires a separate install step
- `pnpm install` can prompt interactively and fail on mixed package-manager artifacts
- Windows/WSL differences make manual recovery harder

Outcome target:

- a repo can reach "configured + local pinned CLI + doctor verified" with one command (or one command plus one machine-emitted next step)

## 4. Proposed vNext Milestones

## Milestone 1 (P0): Documentation + Discoverability Baseline

Goal: remove avoidable archaeology and ambiguity before adding new automation.

Scope:

- Document `.adf.lock` format in `@stackbilt/adf` README and docs.
- Export public lockfile/sync types from `@stackbilt/adf`.
- Add `charter adf sync --explain` with machine-readable JSON output.
- Document rule-routing decision tree in ADF authoring docs.
- Document section taxonomy:
  - whether sections are open or closed
  - whether emoji is semantic or decorative
  - weight tag semantics and validation behavior

Likely packages:

- `packages/adf`
- `packages/types` (if shared interfaces are promoted)
- `packages/cli`
- docs/README content

Exit criteria:

- `.adf.lock` schema is discoverable without reading implementation code
- new ADF authoring docs answer the section/taxonomy questions raised in `ADX-002`

## Milestone 2 (P1): Bootstrap UX and Pointer File Generation

Goal: reduce greenfield setup turns and CLAUDE.md/ADF drift risk.

Scope:

- Add `charter adf init --emit-pointers` to generate thin pointer files:
  - `CLAUDE.md`
  - `.cursorrules`
  - `agents.md`
  - `copilot-instructions.md` (optional)
- Include "do not duplicate ADF rules here" guidance in generated pointers.
- Optionally seed `.adf.lock` on init/scaffold to support immediate `sync --check`.
- Add commented rule-routing heuristics into generated `core.adf` template.

Likely packages:

- `packages/cli`
- `packages/adf` (template helpers if shared)

Exit criteria:

- a fresh repo can initialize ADF plus thin pointers in one command
- first CI run does not fail due to missing lockfile (if ADF files are generated)

## Milestone 3 (P2): Guided Authoring Commands

Goal: reduce manual decision load when adding or editing rules.

Scope:

- Add `charter adf add` (initial version) with:
  - `--rule`
  - `--weight`
  - `--file` / `--section` explicit mode
  - `--auto-route` suggestion mode
  - `--dry-run` output
- Heuristic routing engine (text-based, deterministic first pass):
  - modality/rule strength (`must`, `never`, `prefer`)
  - known stack keywords from `manifest.adf`
  - fallback confidence score + explanation
- Clarify/validate section naming rules during insertion.

Likely packages:

- `packages/cli`
- `packages/classify` (or new routing helper module)
- `packages/adf`

Exit criteria:

- common rule insertion can be completed without manually editing ADF files
- command explains why it chose file/section/weight

## Milestone 4 (P2/P3): Trigger Validation and Pattern-Aware Scaffolding

Goal: make manifest routing testable and connect governance patterns to ADF setup.

Scope:

- Add `charter adf triggers --test "<task description>"`.
- Add trigger diagnostics:
  - matched keywords
  - overlapping modules
  - no-match warnings
- Optional trigger lint:
  - duplicate keywords
  - high-overlap warnings
  - empty trigger sets for on-demand modules
- Bridge `.charter/patterns/blessed-stack.json` to ADF module scaffolding:
  - suggest/generate module skeletons from pattern categories
  - pre-populate trigger seeds

Likely packages:

- `packages/adf`
- `packages/cli`
- `packages/core` / `packages/validate` (if lint/diagnostics live there)

Exit criteria:

- trigger behavior is testable before production agent tasks
- blessed stack categories can seed ADF module generation

## Milestone 5 (P1/P2): Automation-First Bootstrap and Install Orchestration

Goal: minimize manual command count and platform-specific recovery during Charter onboarding.

Scope:

- Add `charter bootstrap` (or equivalent `setup --install` mode) to orchestrate:
  - detect + setup
  - dependency pinning
  - install step (or machine-readable next-step emission)
  - optional `doctor` verification
- Emit machine-readable next-step plans whenever manual follow-up is required.
- Document Windows PowerShell / WSL/Linux canonical flows.
- Improve automation safety in detect output:
  - confidence rationale
  - `requiresConfirmation`
  - optional fail-on-confidence threshold
- Explore install-repair helper (`charter fix install`) for mixed package-manager state and stale nested `node_modules`.

Likely packages:

- `packages/cli`
- `packages/core` (shared result/status types)
- docs/README content

Exit criteria:

- documented "one-command" or "one-command + explicit next step" onboarding path exists
- setup/install/doctor sequence can be scripted without interactive prompts in supported environments
- users do not need to manually choose between `node dist`, `npx`, and `pnpm exec` for normal onboarding

## 5. Prioritization Rationale

Order is intentional:

1. Docs/spec first (`M1`) because current ambiguity blocks both humans and agents immediately.
2. Bootstrap improvements (`M2`) next because they reduce first-run friction and drift risk quickly.
3. Guided insertion (`M3`) after taxonomy/routing rules are explicit, so CLI behavior encodes a stable spec.
4. Automation/bootstrap consolidation (`M5`) after baseline docs/bootstrap improvements, to reduce command sprawl and platform friction.
5. Trigger/pattern tooling (`M4`) after baseline workflows exist, to improve precision and scale.

## 6. Candidate Success Metrics (Seed for CSA-002 / vNext Validation)

Use the `ADX-001` and `ADX-002` baselines as pre-vNext comparison points.

Runtime discoverability metrics (`ADX-001` baseline):

- Lockfile schema discovery tool calls: `6+` -> target `<= 1`
- Token cost to discover `.adf.lock`: `500+` -> target `< 100`
- Success mode: partial -> target deterministic (`docs` or `--explain`)

Greenfield bootstrap metrics (`ADX-002` baseline):

- Turns to stable ADF context: `~8` -> target `<= 3`
- Initially misplaced rules: `3/6` -> target `<= 1/6`
- "Format validity" clarification questions: baseline qualitative -> target near-zero with docs + CLI validation

Tooling adoption/quality metrics:

- `% of repos with thin pointer files generated by init`
- `% of ADF repos with trigger diagnostic clean pass`
- `% of `adf add --auto-route` suggestions accepted without manual override`

Automation DX metrics (`ADX-003` baseline candidate):

- Commands from "fresh repo" to "configured + doctor": baseline observed `>4` with retries -> target `<= 2`
- Interactive prompts during bootstrap/install: baseline `>= 1` -> target `0` in documented non-interactive path
- Manual cleanup interventions (`node_modules`, nested workspace modules): baseline observed `1+` -> target `0`
- Time to local pinned CLI availability (`pnpm exec charter --version`): baseline qualitative -> track and reduce

## 7. Implementation Notes (Early)

Keep vNext pragmatic:

- Prefer deterministic heuristics first for `--auto-route`; do not require LLM inference.
- Every new assistive command should support `--dry-run --format json`.
- New docs and commands should include examples usable by agents (not just human prose).
- Public interfaces should live where `.d.ts` discovery in `node_modules` is straightforward.

## 8. Open Questions Before v0.2 of This Roadmap

- Should section taxonomy remain open (custom sections allowed) or become a constrained enum with extension points?
- Where should routing heuristics live long-term (`packages/classify` vs `packages/adf` vs `packages/cli`)?
- Should `.adf.lock` generation happen in `adf init`, `adf sync --write`, scaffold generation, or all three?
- Should thin pointer generation be opt-in (`--emit-pointers`) or default behavior?
- What is the minimal trigger-lint signal set that is useful without overfitting?

## 9. Suggested First Sprint Scope (Practical Starting Slice)

If the next version needs a narrow, high-leverage start, implement:

1. `.adf.lock` docs + exported types
2. `charter adf sync --explain`
3. rule-routing decision tree docs
4. section taxonomy spec docs
5. `charter adf init --emit-pointers` (thin `CLAUDE.md` + `agents.md`)

This slice addresses the core friction reported in both feedback papers without requiring a large parser/CLI redesign.

## 10. Addendum (From ADX-003)

An immediate follow-on sprint after the above slice should target automation ergonomics:

1. `setup` emits machine-readable next steps (install + verify)
2. document the canonical sequence: `npx ... setup` -> `pnpm install` -> `pnpm exec charter doctor`
3. non-interactive install guidance for PowerShell/WSL
4. decide whether `bootstrap` is a new command or a `setup --install` extension

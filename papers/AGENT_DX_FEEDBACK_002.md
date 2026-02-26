---
title: "Agent DX Feedback: ADF Greenfield Bootstrapping — Rule Routing Friction"
feedback-id: ADX-002
date: 2026-02-26
source: "Claude Opus 4.6 (Anthropic) bootstrapping smart_revenue_recovery_adf"
severity: medium
related:
  - CSA-002 (greenfield measurement — this IS the subject project)
  - ADX-001 (complements: ADX-001 showed cost without ADF; this shows cost of setting up ADF)
---

# Agent DX Feedback: ADF Greenfield Bootstrapping — Rule Routing Friction

## Observation

A Claude agent bootstrapped a greenfield project's ADF context from scratch — creating
`core.adf`, `backend.adf`, `frontend.adf`, updating `manifest.adf`, and establishing
the CLAUDE.md-vs-ADF boundary. The full bootstrapping conversation took ~8 turns of
collaborative rule triaging between agent and user before the context layer was stable.

The friction was not in writing ADF files — that was straightforward. The friction was
in **deciding where each rule belongs** and **whether the format was valid**.

## Root Causes

### 1. No rule-routing heuristic is documented

When the user provided rules like "use `wrangler --remote` for KV" and "this is Workers
not Pages," the agent initially placed both in CLAUDE.md. The user corrected: stack-specific
rules belong in ADF modules, not CLAUDE.md. The boundary was learned through conversation,
not documentation.

The empirically-discovered decision tree:

```
Is it pure runtime/environment? (OS, line endings, shell)
  → CLAUDE.md

Is it a universal architecture constraint? (platform choice, tenant isolation)
  → core.adf CONSTRAINTS [load-bearing]

Is it a stack-specific operational rule? (wrangler flags, D1 batching)
  → backend.adf or frontend.adf ADVISORY

Is it agent identity/behavior? ("You ARE the X agent")
  → core.adf CONTEXT

Is it language discipline? (type checks, enum safety)
  → core.adf dedicated section
```

This tree should ship with `charter adf init` or be in the ADF authoring docs.

### 2. Section taxonomy is implicit

The ADF format uses emoji-prefixed sections: `⚙️ CONTEXT`, `⚠️ CONSTRAINTS`, `📏 ADVISORY`,
`📊 METRICS`. These appear to be conventions inherited from examples, not a defined spec.

When the agent needed to add TypeScript-specific rules, it invented a new section:
`🔧 TYPESCRIPT [load-bearing]`. There was no way to know if this was valid. Questions:

- Is the set of section types open or closed?
- Does `charter adf fmt --check` validate section names?
- Can custom sections carry `[load-bearing]` weight tags?
- Are emoji prefixes semantic (parsed) or decorative?

### 3. No guided rule insertion CLI

Adding a rule requires 4 manual decisions:
1. Which `.adf` file? (core, backend, frontend, or new module)
2. Which section? (CONTEXT, CONSTRAINTS, ADVISORY, METRICS, or custom)
3. What weight? (`[load-bearing]` or unweighted)
4. What phrasing? (imperative constraint vs. descriptive context)

A `charter adf add` command could automate this:

```bash
charter adf add \
  --rule "Run type checks before committing" \
  --weight load-bearing \
  --auto-route  # analyzes rule text to suggest target file + section
```

### 4. CLAUDE.md vs ADF boundary is architecturally significant but undocumented

The project established that CLAUDE.md (and equivalents: `.cursorrules`, `agents.md`,
`copilot-instructions.md`) should be an ultra-thin pointer to `.ai/`, not a competing
context source. Only pre-ADF bootstrap content (runtime environment) stays in CLAUDE.md.

This is a strong architectural pattern: **ADF supersedes per-tool context files**. But
`charter adf init` doesn't generate or manage CLAUDE.md. An agent without this guidance
will create a full CLAUDE.md that duplicates ADF content — exactly the drift ADF exists
to prevent.

### 5. Trigger keywords are freeform and untestable

`manifest.adf` defines trigger keywords for on-demand modules:
```
- backend.adf (Triggers: API, Worker, D1, Queue, ...)
- frontend.adf (Triggers: React, CSS, UI, dashboard, ...)
```

These keywords were hand-authored with no validation. There's no way to:
- Test if a trigger fires for a given task description
- Detect overlapping triggers between modules
- Measure trigger precision/recall (CSA-002 Section 2.4 will measure this post-hoc,
  but pre-hoc tooling would help)

### 6. blessed-stack.json doesn't bridge to ADF modules

`.charter/patterns/blessed-stack.json` defines 5 architectural patterns (COMPUTE, DATA,
INTEGRATION, ASYNC, SECURITY). The on-demand ADF modules map roughly to these categories,
but the translation was manual. No tooling connects blessed patterns to module generation.

## Impact on CSA-002

This bootstrapping session IS data for CSA-002:

| Metric | Value | Notes |
|---|---|---|
| Turns to stable ADF context | ~8 | Agent + user collaborative triaging |
| Rules initially misplaced | 3 of 6 | Put in CLAUDE.md, belonged in ADF |
| Custom sections invented | 1 | 🔧 TYPESCRIPT — validity unknown |
| Files created/modified | 6 | core.adf, backend.adf, frontend.adf, manifest.adf, state.adf, CLAUDE.md |
| Token cost of bootstrapping | ~3,000 est. | Conversation tokens for rule routing decisions |

This is the "governance setup cost" that CSA-002 should report alongside the ongoing
per-task context cost. The hypothesis: this cost is paid once, then amortized across
all subsequent tasks. If `charter adf init` became smarter, this cost drops significantly.

## Recommended Charter Improvements

### P0: Document the rule-routing decision tree

Add to the ADF authoring guide (README or docs site). The tree discovered in this session
(Section 1 above) is a starting point. Ship it with `charter adf init` as a comment
block in the generated `core.adf`.

### P1: Specify the section taxonomy

Document whether sections are open or closed. If open, define the interface:
- Required: section emoji + name + optional weight tag
- Parsed fields: which parts are semantic vs. decorative
- Validation: what `charter adf fmt --check` enforces

### P2: Generate thin CLAUDE.md (and equivalents) at init

`charter adf init` should optionally emit a thin CLAUDE.md / .cursorrules / agents.md
that points to `.ai/` with an explicit "do not duplicate rules here" instruction.

```bash
charter adf init --emit-pointers  # generates CLAUDE.md, .cursorrules as pointers
```

### P3: Add `charter adf add --auto-route`

Guided rule insertion that analyzes rule text and suggests:
- Target file (based on trigger keyword overlap)
- Target section (based on rule phrasing: "must" → CONSTRAINT, "prefer" → ADVISORY)
- Weight (based on language strength)

### P4: Add `charter adf triggers --test "task description"`

Dry-run trigger matching against a task description string. Returns which modules
would fire and which keywords matched. Essential for validating manifest accuracy
before real tasks exercise it.

### P5: Bridge blessed-stack.json to module scaffolding

When `charter adf init` runs in a repo with `.charter/patterns/blessed-stack.json`,
offer to generate on-demand module skeletons based on the blessed pattern categories.

## Appendix: Final File State After Bootstrapping

### CLAUDE.md (thin pointer — 4 lines of content)
```
- WSL2/CRLF env note
- Pointer to .ai/manifest.adf
```

### core.adf (universal rules — loaded every task)
```
CONTEXT: Product, architecture, runtime (Workers not Pages), tenant isolation, agent identity
CONSTRAINTS: Conventional commits, no secrets, pure functions, tenant scoping,
             confidence scoring, engine boundaries, no theoretical-as-production,
             run real requests, execute directly
ADVISORY: Idempotency, canonical entities, storage allocation, Workers AI limits
TYPESCRIPT: Type checks before commit, enum consumer checks
METRICS: entry_loc 0/500
```

### backend.adf (on-demand — triggered by API/Worker/D1/Queue keywords)
```
CONTEXT: Runtime details for Workers, D1, DO, Queues, KV, Workers AI
CONSTRAINTS: Ingestion endpoints, idempotency, adapter normalization, DO timers,
             queue idempotency, thin handlers
ADVISORY: Engine stacks, wrangler bindings, wrangler --remote, secret verification,
          batch D1, alert debouncing
METRICS: handler_loc 0/120, adapter_loc 0/200, migration_count 0/30
```

### frontend.adf (on-demand — triggered by React/UI/dashboard keywords)
```
CONTEXT: Mission Control dashboard identity, views, data trust, users
CONSTRAINTS: Confidence thresholds (0.7 yellow, 0.5 hide), lineage drill-down,
             kill-switch, no direct DB calls
ADVISORY: Core Pack metrics, sparklines, action cards, intelligence feed, knobs UI
METRICS: component_loc 0/300, page_count 0/10
```

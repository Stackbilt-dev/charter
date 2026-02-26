---
title: "Architect v2 × Charter ADF Integration Brief"
date: 2026-02-26
audience: Architect v2 Engineering Team
status: proposal
---

# Architect v2 × Charter ADF Integration Brief

## TL;DR

The scaffold engine should emit `.ai/` (ADF context modules) alongside `.charter/` in every generated project. This turns every StackBilt-scaffolded repo into a governed project from line zero — and creates a measurement loop that no competitor has.

## What Changes

Today the scaffold engine generates:

```
.charter/config.json     ← governance config
governance.md            ← policy doc
wrangler.toml, routes/, schema.sql, etc.
```

After integration, it also generates:

```
.ai/manifest.adf         ← module registry with triggers derived from ARCHITECT components
.ai/core.adf             ← role, constraints, LOC ceilings derived from component count
.ai/state.adf            ← initial state seeded from the PRD/PRODUCT phase
```

## Where The Data Comes From

The ARCHITECT mode already produces everything ADF needs:

| ADF Needs | Architect Already Has |
|---|---|
| Module trigger keywords | Component names + domain keywords from ARCHITECT |
| LOC ceilings per module | Component count → ceiling formula (e.g., 400 LOC default, adjusted by complexity) |
| DEFAULT_LOAD modules | Core role/constraints derived from PRD requirements |
| ON_DEMAND triggers | Domain-specific modules mapped from component boundaries (auth, ingestion, api, etc.) |
| Token budget | Total component count × estimated LOC → target budget |
| Metric file paths | Scaffold file manifest provides the exact paths to measure |

The scaffold engine already emits the file manifest. Generating ADF metric entries that reference those same paths is a natural extension.

## Why This Is A Moat

**The loop no one else has:**

```
Architect plans → scaffold + ADF generated → developer builds with ADF governance
    ↑                                                    ↓
    └──── evidence data feeds back ◄──── Charter measures everything
```

1. Every StackBilt project starts governed. No manual setup.
2. Charter captures evidence at every CI run (LOC, tokens, ceiling utilization).
3. That evidence data tells us which scaffolds produce healthy projects and which don't.
4. We improve scaffold generation using real build data — not guesses.

Cursor generates code but doesn't measure what happens to it. OPA gates in CI but doesn't feed back to planning. We own plan → govern → build → measure → improve plan.

## Proof Case: Smart Revenue Rescue (SRR)

We have a unique situation with SRR:

- **Three complete architecture plans** already generated (Anthropic, Gemini, Groq parity tests)
- **Full baseline data** captured: component counts, test scenarios, ADRs, token costs, scaffolds
- **Governance preflight** completed: 88/100 quality, 100% traceability, 11/11 checks

We're about to build SRR with Charter/ADF from day one. The parity test data becomes the "predicted" baseline. Every Charter evidence run during development becomes the "actual." The delta between planned and actual is the paper (CSA-002, already drafted).

**The parity test data we already captured is the baseline we didn't know we were building.** Three models, three plans, full metrics — that's a controlled experiment baseline that fell into our lap.

## What We Need From Architect v2

### Phase 1: Scaffold ADF Emission (Minimal)

When the scaffold engine generates a project, also emit:

1. **`.ai/manifest.adf`** — DEFAULT_LOAD: core.adf, state.adf. ON_DEMAND entries for each domain-specific component with trigger keywords derived from ARCHITECT output.

2. **`.ai/core.adf`** — ROLE section from PRD, CONSTRAINTS section with `[load-bearing]` weight and standard guardrails (no god objects, <400 LOC per module). METRICS section with `[load-bearing]` weight, one entry per scaffold file: `<component>_loc: 0 / <ceiling> [lines]` with file path in manifest METRICS map.

3. **`.ai/state.adf`** — CURRENT: seeded from the most recent pipeline phase. NEXT: first sprint task. BLOCKED: empty.

### Phase 2: Baseline Capture

Emit a `.charter/baseline.json` alongside the scaffold:

```json
{
  "capturedAt": "<timestamp>",
  "source": "architect-v2-scaffold",
  "flowId": "<flow-id>",
  "model": "<model-used>",
  "plannedComponents": <N>,
  "plannedFiles": ["<file-list>"],
  "plannedTestScenarios": <N>,
  "plannedADRs": <N>,
  "planTokenCost": <N>,
  "scaffoldHash": "<sha256>"
}
```

This is the anchor for plan-vs-actual reconciliation. Charter's future `adf trend` command will read this.

### Phase 3: Evidence Feedback (Future)

Once Charter ships `adf evidence --append-log` and `adf trend`, the evidence data can flow back to Architect. Long-term, this means:

- Scaffold templates learn which ceilings are typically too tight or too loose
- Trigger keyword lists get refined based on actual trigger accuracy data
- Component decomposition guidance improves based on real module growth patterns

## Timeline Suggestion

- **Now:** Draft the ADF emission logic. The SRR build is starting — if the scaffold can emit `.ai/` before we begin, CSA-002 captures the full story.
- **Next release:** Ship scaffold ADF emission + baseline.json.
- **Following release:** Charter ships `--append-log` and `adf trend`. Close the feedback loop.

## Questions for the Team

1. Does ARCHITECT mode expose the component list in a structured format the scaffold engine can iterate over for ADF trigger generation?
2. What's the right default LOC ceiling formula? 400 flat? Or scaled by component complexity signal from ARCHITECT?
3. Should the scaffold emit a pre-built `.adf.lock` (so `charter adf sync --check` passes on first CI run)?

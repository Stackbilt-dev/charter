---
title: "Context-as-Code II: Measuring ADF Governance From Line Zero in a Greenfield Build"
paper-id: CSA-002
version: "0.3"
status: retrospective
date: 2026-08-24
authors:
  - Charter Kit Engineering
charter-version: "0.3.x → 0.4.0 (study); reviewed against 1.9.1"
baseline-source: "Stackbilt Architect v2 parity tests (Anthropic, Gemini, Groq)"
subject-project: "Smart Revenue Rescue (SRR) Platform"
related:
  - paper-id: CSA-001
    relationship: "predecessor — retrofit measurement; this paper covers greenfield"
abstract: >
  CSA-001 reported ADF measurements from a v1-to-v2 retrofit. This paper
  examines ADF governance applied from line zero on a greenfield build —
  Smart Revenue Rescue (SRR) — where the AI pipeline that planned the
  architecture also generated the governance constraints that governed
  its own build. Uniquely, baseline data was captured before development
  began: three independent LLM providers (Anthropic, Gemini, Groq) each
  produced a complete architecture plan from the same PRD, providing
  plan-vs-actual reconciliation data across every measurement axis.
---

# Context-as-Code II: Measuring ADF Governance From Line Zero in a Greenfield Build

A Stackbilt Architect v2 + Charter Kit SDLC White-Paper
Date: February 2026
Status: RETROSPECTIVE v0.3 — Backend study complete; frontend phase was not measured.

## Premise

CSA-001 reported an estimated 80% reduction in loaded instruction context and no observed LOC-limit violations during a retrofit where v1 failures were already cataloged. The natural question was: **would the same measurements hold when ADF was applied from the start, before technical debt existed to correct?**

## 2026-08 Retrospective Update

This document preserves a February 2026 single-project case study. It is not a controlled experiment, and its subject repository, raw task transcripts, and provider outputs are not public. The results are therefore observational and cannot establish that ADF caused higher task success, lower model cost, or better instruction adherence.

The original study also used `ceil(characterCount / 4)` as a structural estimator. Values labeled “tokens” below are estimates for relative context size, not tokenizer counts or provider billing measurements. Two historical LOC totals appear in the captured notes: 2,074 tested production LOC and a 2,147-LOC phase snapshot with a broader source boundary. Because the original raw snapshots are not public, this revision retains both values but uses 2,074 for the headline result and does not treat the difference as resolved.

Since the study, Charter has advanced from `0.3.x`/`0.4.0` to `1.9.1`. Current ADF routing adds bounded prefix-stem matching, trigger-match reports, local resolution telemetry, and `adf suggest` diagnostics. The original `ingest`/`ingestion` false negative is historical; it is not representative of the current matcher. The proposed `adf baseline`, `adf trend`, and `--append-log` interfaces described below were part of the study design and are not current CLI commands.

The repository now includes a smaller [reproducible context-routing benchmark](../examples/context-routing-benchmark/). It preserves 30/30 fixture rules byte-for-byte and checks four pinned task routes. The committed snapshot measures 40.0%–77.4% less estimated instruction context than loading the fixture monolith, averaging 58.1%. That benchmark validates deterministic preservation, routing, and relative context size only; it does not measure model task success or instruction adherence.

Recent external work sharpens the hypothesis. Anthropic recommends selecting the smallest high-signal context set and warns about context pollution. OpenAI describes a short repository map that points agents to deeper sources of truth. GitHub now supports repository-wide, path-specific, and agent instruction files across different Copilot surfaces. More importantly, 2026 evaluations report that repository context files can increase inference cost without a statistically significant task-success gain, and that coding agents often favor context recall over precision. These findings support measuring selective routing, but they do not validate Charter specifically.

References:

- Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), 2025.
- OpenAI, [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/), 2026.
- GitHub, [Support for different types of custom instructions](https://docs.github.com/en/copilot/reference/custom-instructions-support), accessed 2026-08-24.
- Gloaguen et al., [Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?](https://arxiv.org/abs/2602.11988), 2026.
- Li et al., [ContextBench: A Benchmark for Context Retrieval in Coding Agents](https://arxiv.org/abs/2602.05892), 2026.
- Yang et al., [Agent Retrieval Bench: Evaluating Repository Context Retrieval for Coding Agents](https://arxiv.org/abs/2607.24882), 2026.

### Dormant-project revalidation (2026-08-24)

The subject repository was revalidated at commit `d0bff55d38cde1ae32b2a7ab304e8457ab43c802` after no active development since March. The frontend phase had in fact landed on 2026-02-26 and later March work expanded the application.

- 47/47 backend tests passed across eight suites.
- Root TypeScript validation passed.
- The React frontend production build passed with 73 transformed modules.
- Current scope contains 4,783 production LOC across 60 `.ts`, `.tsx`, and `.css` files, plus 628 test LOC across eight files.
- Current Charter estimated 2,276 units for all five ADF modules, 1,768 for a frontend task, and 1,729 for a backend task. These are not directly comparable to the February 558/569 figures because the default-load set and project scope changed.
- Dependency audits reported 14 root findings (including one critical) and seven frontend findings. Counts may overlap and do not establish exploitability.

The rerun initially failed to route the repository's historical `(Triggers: ...)` manifest syntax. Charter `1.9.1` restores that compatibility. Full measurements and limitations are recorded in [CSA-003](./charter-evidence-2026-08.md).

This paper answers that question using a greenfield build of the Smart Revenue Rescue (SRR) platform. What makes this study unique is the existence of pre-development baseline data: before a single line of SRR code was written, three LLM providers independently generated complete architecture plans from the same PRD through the Stackbilt Architect v2 pipeline. Those plans — including component counts, test scenario counts, ADR inventories, token costs, and deployable scaffolds — serve as the "predicted" baseline against which the actual ADF-governed build is measured.

## 1. Baseline Data (Pre-Development)

### 1.1 Source

Three architecture plans generated by Stackbilt Architect v2 from the SRR PRD on 2026-02-23. Each plan traversed the full 6-mode pipeline: PRODUCT → UX → RISK → ARCHITECT → TDD → SPRINT.

### 1.2 Plan Inventory

| Metric | Anthropic | Gemini | Groq |
|---|---|---|---|
| Elapsed time | 2m46s | 2m50s | 2m19s |
| Total tokens (in+out) | 79,393 | 62,794 | 69,746 |
| Requirements produced | 22 | 23 | 16 |
| Risk items | 3 | 2 | 5 |
| Architecture components | 6 | 9 | 10 |
| Test scenarios | 10 | 25 | 16 |
| ADRs | 5 | 5 | 5 |
| Sprints | 3 | 2 | 2 |
| Quality pass | yes | yes | yes |

### 1.3 Scaffold Manifest

Each model's ARCHITECT mode produced a deployable scaffold. The file manifests serve as the predicted module inventory for plan-vs-actual comparison.

### 1.4 Governance Preflight

Enterprise governance preflight completed with:
- Quality score: 88/100 (post-refinement)
- Traceability: 100%
- Hard checks: 11/11 passed
- Domain lock: voiceops (7 required vendors)

This preflight data establishes the governance posture at the moment before development begins.

## 2. Measurement Rubric

The study combined Charter CLI output with manually retained milestone notes. Current Charter can reproduce the bundle and ceiling checks with `charter adf bundle --format json` and `charter adf evidence --auto-measure --ci --format json`; it does not implement the historical `--append-log`, `adf baseline`, or `adf trend` interfaces proposed in this rubric.

### 2.1 Context Economics

| Metric | How Measured | Frequency | CSA-001 Baseline |
|---|---|---|---|
| Baseline context tokens (DEFAULT_LOAD) | `adf bundle --format json` → `tokenEstimate` | Per task | ~300 tokens |
| Total context tokens (all loaded modules) | `adf bundle --format json` → `tokenEstimate` | Per task | ~1,484 tokens |
| Token budget utilization | `adf evidence` → `tokenUtilization` | Per CI run | 9% |
| Tokens-per-task trend | evidence-log.jsonl time series | Longitudinal | — (new metric) |
| Context growth rate vs codebase growth | token estimate / production LOC | Per milestone | — (new metric) |

**Key question:** Does context cost stay flat as the codebase grows (ADF routing working) or grow linearly (routing failing)?

### 2.2 Architectural Health

| Metric | How Measured | Frequency | CSA-001 Baseline |
|---|---|---|---|
| Module count | `ls src/**/*.ts` | Per milestone | 33 modules |
| Largest file LOC | `adf evidence --auto-measure` → max metric value | Per CI run | 343 LOC |
| Avg ceiling utilization % | mean(value/ceiling) across all metrics | Per CI run | ~70% est. |
| Ceiling headroom trend | ceiling utilization over time | Longitudinal | — (new metric) |
| God object formation | any file > 400 LOC | Per CI run | 0 violations |

**Key question:** Do modules stay within ceilings from the start, or does pressure build as features land?

### 2.3 Plan-vs-Actual Reconciliation (NEW — unique to CSA-002)

| Metric | Plan Source | Actual Source |
|---|---|---|
| Component count | Parity test: 6-10 components | Actual module count at each phase |
| File manifest | scaffold.json file list | Actual file inventory |
| Test count | Parity test: 10-25 scenarios | `vitest run` count at each phase |
| ADR count | Parity test: 5 ADRs per model | `charter validate` governed commits |
| Sprint structure | Parity test: 2-3 sprints | Actual phase boundaries |
| Token cost to plan vs execute | Parity test: 62K-79K | Cumulative `adf bundle` tokens across all tasks |

**Key question:** Which model's plan most accurately predicted the actual build? What's the typical expansion ratio from planned to actual?

### 2.4 ADF Routing Effectiveness

| Metric | How Measured | Frequency |
|---|---|---|
| Module trigger rate | `adf bundle --format json` → `triggerMatches` | Per task |
| Dead modules | `adf bundle` → `unmatchedModules` over time | Longitudinal |
| False negatives | Regressions in domain X when domain X module didn't trigger | Post-hoc analysis |
| Trigger keyword coverage | unique matched keywords / total defined triggers | Per milestone |

**Key question:** Are the manifest triggers accurate? Do on-demand modules fire when needed and stay quiet when not?

### 2.5 Governance Coverage

| Metric | How Measured | Frequency | CSA-001 Baseline |
|---|---|---|---|
| Test count | `vitest run` | Per CI run | 525 tests |
| Test pass rate | pass/total | Per CI run | 100% |
| Trailer coverage | `charter validate --format json` → governed % | Per CI run | — |
| Drift score | `charter drift --format json` → score | Per CI run | — |
| Evidence verdict | `charter adf evidence` → verdict | Per CI run | PASS |

### 2.6 Velocity Signal

| Metric | How Measured |
|---|---|
| Time from PRD to first deploy | Calendar days: PRD date → first `wrangler deploy` |
| Time per phase boundary | Calendar days between phase 1/2/3 milestones |
| Commits per phase | `git log --oneline` count between tags |
| LOC per phase | `adf evidence` metric deltas between milestones |

## 3. Data Collection Method

### 3.1 Evidence Ledger

The study design proposed appending a JSON line to `.charter/evidence-log.jsonl` on every CI run:

```bash
charter adf evidence --auto-measure --ci --format json
```

Current Charter emits a report for each invocation; persistent longitudinal logging must be supplied by CI artifact storage or another external collector.

### 3.2 Baseline Snapshot

The project retained a day-zero baseline snapshot. The proposed `charter adf baseline` command was not shipped:

```json
{
  "capturedAt": "2026-02-...",
  "source": "architect-v2-scaffold",
  "plannedComponents": 9,
  "plannedFiles": ["wrangler.toml", "worker/index.ts", "routes/..."],
  "plannedTestScenarios": 25,
  "plannedADRs": 5,
  "plannedSprints": 2,
  "planTokenCost": 62794,
  "scaffoldHash": "..."
}
```

### 3.3 Milestone Snapshots

At each phase boundary (matching the PRD's 3-phase roadmap), a full snapshot is captured:

- `charter adf evidence --auto-measure --format json > .charter/snapshots/phase-N.json`
- `charter audit --format json >> .charter/snapshots/phase-N.json`
- Git tag applied: `v0.N.0`

### 3.4 Trend Report

At project completion, the baseline and milestone notes were reconciled manually. The proposed `charter adf trend` command was not shipped.

## 4. Expected Findings (Hypotheses)

**H1 — Token flatness:** ADF context tokens per task will remain flat (<500) even as production LOC grows past 2,000. This would confirm that manifest routing scales.

**H2 — Ceiling compliance from day one:** 0% LOC ceiling violations throughout the build, matching CSA-001's result but without the corrective pressure of v1 god objects.

**H3 — Plan expansion ratio:** The actual build will produce 2-3x the components predicted by the scaffold, but the expansion will follow the existing component boundaries (new files within predicted domains, not new domains).

**H4 — Trigger accuracy:** >90% of on-demand module loads will be true positives (the task actually needed that context). <5% of tasks will show false-negative trigger misses.

**H5 — Model plan accuracy:** The model with the highest component count (Groq: 10) will most closely predict the actual module count, because finer decomposition better matches ADF's modular governance style.

## 5. Findings

*Build, test, and deploy complete. Data captured from single-session greenfield build (2026-02-26). All metrics measured post-deployment.*

### Phase 1: The Memory (Scorecard Engine)

| Metric | Value |
|---|---|
| Commit | `af297cb` |
| Files | 10 source files + 1 migration |
| LOC | ~650 |
| ADF token estimate (DEFAULT_LOAD) | 558 |
| Type errors | 0 |
| ADF constraint violations | 0 |
| Modules: | ingestion handler, queue consumer, ServiceTitan adapter, CallRail adapter, canonical entities, idempotency, confidence scoring, validation |

Observations: Ingestion pipeline with SHA-256 idempotency, tenant-isolated D1 schema, two adapters normalizing to canonical entities. All handler files thin (validate → enqueue → respond). Confidence scoring applied to every entity.

### Phase 2: The Action (Revenue Doctor)

| Metric | Value |
|---|---|
| Commit | `d5cf04f` |
| Files | 17 source files + 2 migrations |
| LOC | ~1,489 |
| ADF token estimate (DEFAULT_LOAD) | ~560 (inferred — no snapshot taken mid-phase) |
| Type errors | 0 |
| ADF constraint violations | 0 |
| Modules added: | LeakMonitor DO, leak detection rules, correlation engine, scorecard metrics, diagnostics handler |

Observations: Durable Object with alarm-based speed-to-lead timer (10min) and debounce. Correlation engine uses simplified co-movement analysis. Kill-switch (`REVENUE_WORKER_ENABLED`) enforced at router level. Engine boundary respected — no cross-engine imports.

### Phase 3: The Optimization

| Metric | Value |
|---|---|
| Commit | `6e858bd` |
| Files | 24 source files + 2 migrations |
| LOC | ~2,147 |
| ADF token estimate (DEFAULT_LOAD) | 569 |
| Type errors | 0 |
| ADF constraint violations | 0 |
| Modules added: | vanity kill detection, webhook manager/dispatcher, predictive health scoring, tenant knobs config |

Observations: Vanity kill joins call attribution → job → financial to compute cost-per-sale. Webhook dispatcher uses HMAC-SHA256 signing. Health scoring uses linear forecasting with seasonal notes. Tenant knobs KV-backed with sensible defaults.

### Test Suite

| Metric | Value |
|---|---|
| Commit | `18669bb` |
| Test framework | Vitest + @cloudflare/vitest-pool-workers |
| Total tests | 41 |
| Test suites | 8 |
| Pass rate | 100% |
| Test LOC | 551 |
| Production LOC | 2,074 |
| Test-to-production ratio | 0.27 |

Test suites: confidence (8), validation (3), CallRail adapter (5), ServiceTitan adapter (5), detector (7), correlation (4), health scoring (7), tenant knobs (2). The knobs test uses the Workers pool with live KV binding (isolated via `wrangler.test.toml`). All other tests are unit tests with no I/O.

Setup note: Vitest with `@cloudflare/vitest-pool-workers` required a separate `wrangler.test.toml` with placeholder resource IDs — the production `wrangler.toml` with real D1/KV IDs caused binding validation errors in the test pool. This is a Workers-specific testing pattern worth documenting.

### Deployment

| Metric | Value |
|---|---|
| Worker URL | *(redacted — personal dev deployment)* |
| Bundle size | 33.19 KiB (7.56 KiB gzipped) |
| Version ID | `6e660b90-cdf5-4cef-9617-45dafd38913f` |
| D1 database | `srr-db` (6 tables, 17 indexes) |
| KV namespace | `SRR_CONFIG_KV` |
| Queue | `srr-ingest` (producer + consumer) |
| Durable Object | `LeakMonitor` |
| Health check | `{"status":"ok","engines":{"scorecard":"active","doctor":"active"}}` |

Deployment method: D1 and KV created via MCP tools (authenticated through Claude Code's Cloudflare integration). Migrations applied via MCP `d1_database_query` (statement-by-statement) because `wrangler d1 migrations apply --remote` requires `CLOUDFLARE_API_TOKEN` which was not configured for WSL2's non-interactive shell at deploy time. Worker deployed via `wrangler deploy` with the token loaded from `.env`. Queue created via `wrangler queues create`.

Time from PRD to live deployment: **single session**.

### Context Economics (H1 — Token Flatness)

| Checkpoint | Production LOC | ADF Token Estimate | Growth |
|---|---|---|---|
| Phase 0 (baseline) | 0 | 558 | — |
| Phase 3 (complete) | 2,147 | 569 | +11 tokens (+2.0%) |

**H1 OBSERVED FOR DEFAULT LOAD:** Estimated default instruction context stayed effectively flat (+2%) while the broader phase snapshot grew to 2,147 LOC. Because these evidence snapshots did not simulate task-based routing, they do not establish routing precision, recall, or agent outcomes.

### Architectural Health (H2 — Ceiling Compliance)

| Metric | Ceiling | Actual | Status |
|---|---|---|---|
| entry_loc | 500 | ~65 (index.ts) | PASS |
| handler_loc | 120 | ~25-60 per handler | PASS (in backend.adf, not auto-measured) |
| adapter_loc | 200 | ~70-100 per adapter | PASS (in backend.adf, not auto-measured) |
| component_loc | 300 | N/A (no frontend yet) | N/A |

**H2 OBSERVED:** No ceiling violations were recorded in the retained build measurements. This is evidence of compliance in one build, not evidence that ADF alone caused the result.

### Plan-vs-Actual Reconciliation (H3)

| Metric | Anthropic Plan | Gemini Plan | Groq Plan | Actual |
|---|---|---|---|---|
| Components | 6 | 9 | 10 | 24 files / ~8 logical modules |
| Test scenarios | 10 | 25 | 16 | 41 tests across 8 suites |
| ADRs | 5 | 5 | 5 | 5 commits with governed structure |
| Sprints | 3 | 2 | 2 | 3 phases in 1 session |
| Token cost (plan) | 79,393 | 62,794 | 69,746 | 569 (governance only) |

**H3 SUPPORTED IN THIS CASE:** Actual file count (24) was 2.4-4x the planned component count (6-10), and test count (41) exceeded all three plans' highest estimate (25). The eight logical modules aligned with several predicted domain boundaries, while the three-phase structure matched the Anthropic plan. A single build is insufficient to generalize that LLM plans systematically predict domains better than file granularity.

### ADF Routing Observations (H4)

| Observation | Impact |
|---|---|
| Trigger keyword `ingest` did not match task word `ingestion` | False negative — backend.adf missed routing |
| `charter adf bundle` exact-token matching, no stemming | Systematic gap for morphological variants |
| `charter bootstrap` overwrote custom ADF content | ADX-004 filed, severity HIGH |
| `adf fmt --write` strips scaffold comments | ADX-002 P0 fix is ephemeral |

**H4 NOT MEASURED:** The February build exposed an exact-token stemming gap, but no per-task bundle logs were retained, so routing precision and recall cannot be calculated. Current Charter uses bounded prefix-stem matching and reports matched triggers and keywords; the historical `ingest`/`ingestion` gap has been addressed at the matcher level.

### Velocity Signal

| Metric | Value |
|---|---|
| Time from PRD to deployed platform | 1 session |
| Commits | 5 (foundation, bootstrap, Phase 1+2, Phase 3, tests) |
| Production LOC | 2,074 |
| Test LOC | 551 |
| Total LOC (prod + test) | 2,625 |
| Test count | 41 (100% pass) |
| Cloudflare resources provisioned | 4 (D1, KV, Queue, DO) |
| ADF DX feedback items generated | 4 (ADX-001 ref, ADX-002, ADX-003 ref, ADX-004) |
| Charter versions used during build | 2 (v0.3.2 → v0.3.3, mid-session upgrade) |
| Charter improvements shipped during build | 1 (v0.3.3 with bootstrap, ADX-002 fixes) |

## 6. Charter v0.4.0: Pre-Commit Ceiling Enforcement

During the SRR build, a gap was identified: LOC ceiling breaches could only be caught during CI runs (via `charter adf evidence`). A developer or agent committing a file that exceeded its ceiling would not know until the PR pipeline ran. This gap was acceptable but not ideal — it meant ceiling enforcement was reactive rather than preventive.

Charter v0.4.0 closes this gap with `charter hook install --pre-commit`, a git pre-commit hook that validates ADF LOC ceilings before every commit. If any file breaches its METRICS ceiling, the commit is blocked and the developer (or agent) is forced to split or refactor before proceeding.

### Impact on CSA-002 Hypotheses

**H2 (Ceiling Compliance):** With pre-commit hooks, configured ceiling violations can be detected before a normal commit instead of only in CI. Hooks can be bypassed and only validate declared metrics, so CI remains the authoritative gate. For this study, no violations were observed before the hook existed.

**Velocity impact:** The hook is a no-op when ceilings are respected (which they always were in the SRR build). It only adds friction when friction is warranted — a file that needs splitting. This aligns with ADF's design principle: governance should be invisible when you're doing the right thing.

### Integration

```bash
npm install --save-dev @stackbilt/cli@latest
npx charter hook install --pre-commit
```

The hook requires `.ai/manifest.adf` with METRICS sections in referenced modules. It's safe to install in repos without ADF — it's a no-op without the manifest.

### Relationship to ADX Feedback

This feature addresses the temporal gap surfaced in the SRR build: `adf evidence --auto-measure` runs in CI (post-push), but ceiling discipline should be enforced at commit time (pre-push). The pre-commit hook is the "left-shift" of ceiling enforcement — moving the gate as early as possible in the development loop.

## 7. Conclusion

The greenfield build of Smart Revenue Rescue — from empty repository to a deployed, tested backend in a single session — adds one observational data point to CSA-001:

**Default context remained nearly flat in this build.** The structural estimate increased 2%, from 558 to 569, while tested production code reached 2,074 LOC across 24 files. This measures default-load size; it does not measure task-routing quality or model performance.

**Ceiling compliance was observed from day one.** The retained measurements recorded no declared LOC-ceiling violations. Pre-commit and CI checks now make violations easier to catch, but the study cannot isolate the effect of ADF guidance from the architecture, model, or developer workflow.

**The plans were closer on domains than files in this instance.** Three models predicted 6-10 components; the actual build produced 24 files in eight logical modules. Test count (41) exceeded all three plans' highest estimate (25). More projects would be needed before treating that pattern as general.

**The feedback loop works.** The study surfaced 4 DX feedback items (ADX-001 through ADX-004), covering trigger keyword stemming, bootstrap merge strategy, scaffold comment ephemerality, and the pre-commit enforcement gap. One fix (v0.3.3 bootstrap) shipped during the build session itself. Charter v0.4.0's pre-commit hook directly addresses findings from this study. This demonstrates the intended feedback loop: ADF-governed development surfaces tooling gaps, which the charter team closes, which improves the next governed build.

**Single-session velocity was recorded, but governance overhead was not isolated.** The build reached four Cloudflare resources, six D1 tables, 41 passing tests, and a live health check in one session. Context loading and checks ran alongside development; the study did not capture a no-ADF baseline or separately time governance work.

### Open Questions for Frontend Phase

The backend build produced clear signals. The frontend phase (Mission Control dashboard) will test:

1. **Cross-module routing:** Will tasks that touch both backend and frontend correctly trigger both on-demand modules?
2. **Ceiling pressure under UI complexity:** Will `component_loc: 300` hold for React/dashboard components, or is the ceiling too tight for data-rich views?
3. **Confidence visualization:** The backend enforces confidence scores (0.0-1.0) on every metric. Will the frontend correctly render yellow (<0.7) and hide (<0.5) thresholds?
4. **Pre-commit hook under frontend churn:** Frontend development typically involves more rapid iteration. Will the pre-commit hook's ceiling check add noticeable friction?

## Appendix A: Raw Baseline Data

Parity test summaries, scaffold manifests, and governance preflight snapshots are stored in the SRR repository at their original paths and referenced by SHA hash for reproducibility.

## Appendix B: Deployment Manifest

| Resource | Type | Identifier |
|---|---|---|
| Worker | Cloudflare Workers | `smart-revenue-rescue` |
| D1 Database | Cloudflare D1 | `dadeaa55-6214-42b2-a7d3-3d675986807d` |
| KV Namespace | Cloudflare KV | `821e46808f7048ebbdcfaf7c6c27d973` |
| Queue | Cloudflare Queues | `srr-ingest` |
| Durable Object | Cloudflare DO | `LeakMonitor` |

D1 Schema: 6 tables (raw_events, call_events, job_events, financial_events, leak_events, incidents), 17 indexes. Applied via MCP `d1_database_query` tool.

## Appendix C: Test Suite Inventory

| Suite | File | Tests | Coverage Area |
|---|---|---|---|
| confidence | test/lib/confidence.test.ts | 8 | Field coverage, freshness decay, clamping |
| validation | test/lib/validation.test.ts | 3 | Header extraction, missing tenant/key |
| callrail | test/adapters/callrail.test.ts | 5 | Status resolution, direction handling |
| servicetitan | test/adapters/servicetitan.test.ts | 5 | Job status mapping, rework flag, invoices |
| detector | test/doctor/detector.test.ts | 7 | Leak detection rules, severity escalation |
| correlation | test/doctor/correlation.test.ts | 4 | Metric co-movement, severity thresholds |
| health | test/scorecard/health.test.ts | 7 | Trend direction, risk levels, forecasting |
| knobs | test/config/knobs.test.ts | 2 | KV-backed defaults, persistence |

## Appendix D: Git History

```
18669bb test: add 41 tests covering all modules — lib, adapters, engines, config
6e858bd feat: Phase 3 — vanity kill detection, webhooks, health scoring, tenant knobs
d5cf04f feat: Scorecard Engine + Doctor Engine — both engines operational
bb9f506 chore: integrate charter v0.3.3 bootstrap — CI workflow, lockfile, agent pointers
af297cb feat: Phase 1 foundation — ingestion pipeline, canonical entities, ADF governance
```

## Appendix E: Charter Version Timeline

| Version | Event | Impact on Build |
|---|---|---|
| v0.3.2 | Initial install | Project init, ADF scaffold, first evidence baseline |
| v0.3.3 | Mid-session upgrade | Bootstrap command, ADX-002 fixes, discoverability improvements |
| v0.4.0 | Post-build release | Pre-commit hook for LOC ceiling enforcement (`charter hook install --pre-commit`) |

## Appendix F: Evidence Log Schema

```typescript
interface EvidenceLogEntry {
  timestamp: string;          // ISO 8601
  charterVersion: string;     // e.g. "0.3.1"
  modulesLoaded: string[];    // e.g. ["core.adf", "state.adf"]
  tokenEstimate: number;
  tokenBudget: number | null;
  tokenUtilization: number | null;
  constraints: Array<{
    key: string;
    value: number;
    ceiling: number;
    unit: string;
    status: 'pass' | 'warn' | 'fail';
  }>;
  weightSummary: {
    loadBearing: number;
    advisory: number;
    unweighted: number;
  };
  syncStatus: 'in_sync' | 'drifted' | 'no_lock';
  verdict: 'PASS' | 'WARN' | 'FAIL';
}
```

---
title: "Charter Evidence Register: Reproducible Results, Revalidation, and Known Failures"
paper-id: CSA-003
version: "1.0"
status: published
date: 2026-08-24
authors:
  - Charter Kit Engineering
charter-version: "1.9.1"
---

# Charter Evidence Register: Reproducible Results, Revalidation, and Known Failures

This register separates what Charter's public artifacts demonstrate from what remains a hypothesis. It includes favorable and unfavorable results. None of the measurements below establish that Charter improves model task-success rates.

## Evidence Classes

| Class | Meaning |
|---|---|
| Reproducible | Inputs, evaluator, expected output, and command are committed publicly |
| Revalidated | A dated rerun exists, but the subject or all raw inputs are not independently public |
| Observational | Historical project measurements without a controlled comparison |
| Development evidence | Tests or self-governance checks that validate Charter behavior, not user outcomes |

## 1. Reproducible Context-Routing Benchmark

The [context-routing benchmark](../examples/context-routing-benchmark/) starts with the same 30 identified rules in a flat source, monolithic ADF file, and modular ADF fixture. Four pinned tasks are resolved against the modular manifest.

| Result | Measurement |
|---|---:|
| Rules preserved byte-for-byte | 30/30 |
| Task routes matching the reviewed snapshot | 4/4 |
| Estimated context reduction | 40.0%–77.4% |
| Mean estimated reduction | 58.1% |

Run:

```bash
pnpm run build
pnpm run benchmark:context
```

This demonstrates deterministic preservation, module selection, and relative instruction-context size. The estimator is approximately four characters per token; it is not a provider tokenizer. The benchmark does not execute a coding model or measure task success.

## 2. Reproducible Migration-Routing Harness

The [scenario harness](../harness/) injects synthetic vendor-file content into temporary repositories, runs `charter adf tidy`, and compares exact per-module item counts against reviewed expectations. Earlier reports used a lenient evaluator; the August snapshot requires exact counts and rejects unexpected modules.

| Result | Measurement |
|---|---:|
| Scenarios | 24 |
| Sessions | 38 |
| Extracted items | 178/178 |
| Vendor pointers restored | 38/38 |
| Sessions with exact module counts | 29/38 |
| Scenarios with every session exact | 16/24 |

Run:

```bash
pnpm run build
pnpm run benchmark:routing
```

The committed [expected snapshot](../harness/expected-results.json) intentionally includes eight failing scenarios. Most misses involve mixed-domain headings where sibling-coherence or phrase overrides collapse backend, infrastructure, and QA items into one module. These are known classifier limitations, not hidden exclusions.

The August rerun also found two pointer-restoration defects and a legacy-manifest compatibility regression. Charter `1.9.1` fixes those defects. The remaining routing mismatches stay frozen in the snapshot so future changes cannot silently improve or regress the reported result.

## 3. Dormant Greenfield Repository Revalidation

The subject of [CSA-002](./context-as-code-greenfield-v0.1.md) was revalidated on 2026-08-24 at commit `d0bff55d38cde1ae32b2a7ab304e8457ab43c802`. The repository had not been actively maintained since March 2026, making this a dormancy/freshness check rather than evidence of ongoing adoption.

| Check | August 2026 result |
|---|---:|
| Backend test suites | 8/8 passed |
| Backend tests | 47/47 passed |
| Root TypeScript check | Passed |
| Frontend production build | Passed; 73 modules transformed |
| Production files (`src`, `frontend/src`) | 60 |
| Production LOC (`.ts`, `.tsx`, `.css`) | 4,783 |
| Test files / LOC | 8 / 628 |
| Full ADF context estimate | 2,276 |
| Frontend-task context estimate | 1,768 (22.3% below all modules) |
| Backend-task context estimate | 1,729 (24.0% below all modules) |

The rerun found material negative evidence:

- The historical `(Triggers: ...)` manifest syntax was no longer recognized by current Charter until a `1.9.1` compatibility fix was added.
- The root lockfile audit reported 14 vulnerabilities (1 low, 12 high, 1 critical); the frontend lockfile reported 7 (1 low, 6 high). Counts may overlap and are dependency-tree findings, not confirmed exploitable paths.
- Current estimated context is not directly comparable to the February 558/569 figures because the default module set, project scope, and Charter version changed.

This revalidation shows that the dormant code still tests and builds, while also showing that governance files and dependencies can decay. It does not show that Charter prevented decay or improved the application.

## 4. Cross-Repository Structural Audit

An exploratory read-only audit covered all 16 non-empty ADF configurations found in locally owned sibling repositories on 2026-08-24. Repository names and per-repository results are withheld because most subjects are non-public.

| Structural estimate | Median | Mean | Range |
|---|---:|---:|---:|
| Modules per repository | 5.5 | 5.4 | 3–9 |
| Default-load context | 1,180 | 1,440 | 471–4,136 |
| All-module context | 2,342 | 2,745 | 633–10,135 |
| Default-load reduction vs all modules | 45.5% | 41.1% | 0.5%–79.8% |
| Mean reduction across four standard probe tasks | 39.7% | 37.0% | 0.4%–79.8% |

This aggregate shows that selective loading creates a measurable structural difference across multiple real configurations. It is not independently reproducible, the subjects are team-owned rather than external, prompt relevance was not manually judged, and no model outcomes were measured. It should be treated as exploratory evidence and a protocol seed for a future public-repository study.

## 5. Other Public Findings

| Artifact | Evidence class | What it supports | Main limitation |
|---|---|---|---|
| [CSA-001](./context-as-code-v1.1.md) | Observational | Historical retrofit measurements | No controlled baseline or public raw transcripts |
| [CSA-002](./context-as-code-greenfield-v0.1.md) | Observational + revalidated | Greenfield and dormancy case study | Single team-owned project |
| [ADX feedback series](./ux-feedback/README.md) | Development evidence | Concrete tooling failures and shipped responses | Mostly internal user journeys |
| Charter score badge | Development evidence | Current self-audit result | Self-measurement; not an outcome study |
| Test suite | Development evidence | Contract and regression behavior | Tests implementation correctness, not usefulness |

## Claims We Can and Cannot Make

Supported:

- Charter preserves the 30-rule public fixture byte-for-byte while routing four pinned tasks with 40.0%–77.4% less estimated context than the fixture monolith.
- The migration harness extracts all 178 expected items and restores all 38 vendor pointers, while exact module routing currently succeeds in 29/38 sessions.
- Selective loading produces smaller structural context bundles across the measured configurations.

Not supported:

- Charter improves coding-agent task success, code quality, or instruction adherence.
- Estimated token reductions equal provider billing savings.
- ADF caused the greenfield project's velocity, modularity, or passing tests.
- Internal or team-owned repository results generalize to outside users.

The next strong study should use public repositories, frozen task sets, a no-context baseline, a monolithic-instructions baseline, Charter routing, repeated model runs, and outcome/cost measures reported with uncertainty.

---
title: "CI Integration"
section: "charter"
order: 3
color: "#f59e0b"
tag: "03"
---

# CI Integration

Charter integrates with GitHub Actions via a reusable workflow template that runs governance checks and ADF evidence gating on every PR.

## Setup

```bash
charter setup --ci github --yes
```

This writes `.github/workflows/charter-governance.yml` to your repo.

## What the Workflow Does

On every push and pull request, the CI workflow runs:

1. `charter validate --ci` — checks all commits for governance trailers
2. `charter drift --ci` — scans for blessed-stack deviations
3. `charter adf evidence --auto-measure --ci` — validates metric ceilings (when `.ai/manifest.adf` is present)
4. `charter audit --format json` — captures governance posture snapshot

If any step exits `1`, the check fails and the merge is blocked.

## Evidence Gating

When your repo has an `.ai/` directory with metric ceilings defined, the CI workflow automatically validates those ceilings using `charter adf evidence --auto-measure --ci`.

This means LOC limits, module size constraints, and any other metrics you define in your ADF modules are enforced at merge time — not just at dev time.

**Constraint semantics in CI:**
- `value < ceiling` — PASS
- `value === ceiling` — WARN (surfaces in report, does not block)
- `value > ceiling` — FAIL (exits 1, blocks merge)

### Example Evidence Output

```
ADF Evidence Report
===================
Modules loaded: core.adf, state.adf
Token estimate: ~342
Token budget: 4000 (9%)

Auto-measured:
  entry_loc: 142 lines (src/index.ts)
  handler_loc: 88 lines (src/handler.ts)

Section weights:
  Load-bearing: 2
  Advisory: 0
  Unweighted: 3

Constraints:
  [ok] entry_loc: 142 / 500 [lines] -- PASS
  [ok] handler_loc: 88 / 300 [lines] -- PASS

Sync: all sources in sync

Verdict: PASS
```

## Adding Governed-By Trailers

Every commit should carry a `Governed-By:` trailer referencing an ADR or decision ID:

```
feat(auth): add JWT refresh endpoint

Implements token refresh per ADR-042.

Governed-By: ADR-042
```

Use `charter hook install --commit-msg` to install a git hook that prompts for or normalizes trailers at commit time.

## ADF Sync Check

If you use `charter adf sync --check` in CI, it verifies that the `.adf` source files match their locked hashes in `.adf.lock`. This catches unauthorized context modifications — if someone edits an `.adf` file without running `charter adf sync --write`, the check fails.

## Environment Variables

No secrets required for any governance check. The workflow is fully local/static — no external API calls.

---
title: "Agent DX Feedback: charter bootstrap on Pre-Configured Repo — Destructive Overwrite"
feedback-id: ADX-004
date: 2026-02-26
source: "Claude Opus 4.6 (Anthropic) testing v0.3.3 bootstrap on smart_revenue_recovery_adf"
severity: high
bucket: reliability-trust
status: shipped
related:
  - ADX-002 (bootstrap is the fix for ADX-002 friction; this tests that fix)
  - ADX-003 (install automation friction; bootstrap P0 now ships but has merge gap)
  - CSA-002 (greenfield measurement — bootstrap run is a data collection event)
tracked-issues: []
tracked-prs: []
---

# Agent DX Feedback: charter bootstrap on Pre-Configured Repo — Destructive Overwrite

## Observation

After building a fully-configured SRR project with custom ADF content (5 modules,
trigger keywords, SRR-specific constraints, confidence scoring rules, TypeScript
section), we upgraded to charter v0.3.3 and ran:

```bash
charter bootstrap --ci github --yes --format json
```

Bootstrap reported `"status": "success"` with all 5 steps passing. However, it
**overwrote 3 of 5 ADF files** with scaffold templates, destroying all custom content
in core.adf, manifest.adf, and state.adf. Only backend.adf and frontend.adf survived
because bootstrap doesn't scaffold those (they're on-demand modules the user creates).

The `--yes` flag auto-accepted the overwrites without warning.

## What Was Lost

| File | Custom content destroyed | Scaffold content that replaced it |
|---|---|---|
| `core.adf` | 9 load-bearing constraints, CONTEXT with 5 entries (including agent identity), ADVISORY with 4 entries, TYPESCRIPT section, all SRR-specific | 3 generic constraints ("Use Conventional Commits", "Never commit secrets", "Pure functions") |
| `manifest.adf` | 12 backend triggers, 12 frontend triggers, 4 routing rules, engine boundary guidance | 3 generic triggers per module ("React, CSS, UI" / "API, Node, DB") |
| `state.adf` | Phase 1 progress, evidence baseline reference, current/next sprint context | "Repository initialized with ADF context system" |

## What Was Preserved

- `backend.adf` — untouched (bootstrap doesn't scaffold on-demand modules)
- `frontend.adf` — untouched
- `.charter/snapshots/` — untouched

## What Was Added (Good)

- `.github/workflows/charter-governance.yml` — CI workflow (excellent)
- `.ai/.adf.lock` — lockfile from day one (excellent)
- `.cursorrules` + `agents.md` — thin pointers (excellent, ADX-002 P2 delivered)
- `package.json` scripts — `charter:detect`, `charter:setup` (good)
- `core.adf` rule-routing comment block — (excellent, ADX-002 P0 delivered)
- `CLAUDE.md` — cleaner pointer template with ADF link (good)

## Recovery

Manual restoration was required. The agent (Claude) had the previous content in
conversation context and could restore it, but the overwrite was silent — no diff
shown, no backup created. In a CI-only scenario (no agent in the loop), the custom
content would be lost unless the previous commit was checked.

Recovery steps:
1. Re-wrote core.adf with all custom SRR content + the bootstrap rule-routing comments
2. Re-wrote manifest.adf with full trigger keyword lists
3. Re-wrote state.adf with current phase context
4. Ran `charter adf fmt --write` on all restored files
5. Committed as a separate commit for audit trail

## Root Causes

### 1. Bootstrap assumes greenfield — no merge strategy for existing content

The `adf-init` step within bootstrap always writes scaffold templates. It doesn't
detect that core.adf already has custom content beyond the scaffold. The `--yes` flag
makes this worse by suppressing any confirmation.

### 2. No backup before overwrite

Running `charter adf fmt --write` is safe because it preserves content. But `bootstrap`
replaces file content entirely. No `.adf.bak` or git stash is created.

### 3. Success status despite data loss

The JSON output reported `"status": "success"` for the `adf-init` step. There was no
warning that existing custom ADF content was being replaced. The `warnings` array was
empty for this step.

### 4. Lockfile generated from scaffold content, not custom content

The `.adf.lock` was generated against the scaffold templates, not the custom content.
After restoring custom content, `sync --check` would report "No SYNC entries" because
the manifest doesn't declare sync entries. The lockfile hashes were immediately stale.

## Impact on CSA-002

This is a governance failure in the governance tool itself. Key data points:

| Metric | Value |
|---|---|
| Custom rules destroyed | 16 constraints + 5 context lines + 4 advisory + 3 TS rules |
| Files overwritten | 3 of 5 ADF files |
| Recovery time | ~5 minutes (agent had context; without context: would require git checkout) |
| Bootstrap exit code | 0 (success) |
| Warnings emitted | 0 about overwrites |

For CSA-002, this demonstrates that governance tooling itself needs governance — the
tool that prevents content drift caused content destruction.

## Additional Observation: `adf fmt --write` strips comments

The rule-routing decision tree that bootstrap ships in core.adf (the ADX-002 P0 fix)
is written as `#` comments. Running `charter adf fmt --write` strips those comments.
This means the ADX-002 fix is ephemeral — it exists only until the first format pass.

This might be intentional (comments are scaffolding guidance, not runtime context),
but it means agents working on later sessions won't see the rule-routing guide unless
they read the ADF authoring docs directly.

## Additional Observation: Trigger matching lacks stemming

Discovered during pre-commit evidence collection. Running:

```bash
charter adf bundle --task "Build ingestion pipeline for Scorecard Engine"
```

Returned `triggerMatches: []` — backend.adf was NOT triggered despite the task clearly
being a backend task. The trigger keyword `ingest` didn't match the task word `ingestion`.
The keyword tokenizer does exact matching without stemming.

This means trigger accuracy (CSA-002 Section 2.4) will show false negatives for any
keyword where the task description uses a different morphological form.

## Recommended Charter Improvements

### P0: Detect existing custom content before overwriting

```bash
charter bootstrap --ci github --yes
# Should detect: "core.adf has 35 lines of custom content beyond scaffold template"
# Should warn: "Use --force to overwrite, or --merge to append scaffold comments"
# Without --force: skip adf-init for files with custom content
```

### P1: Create backup before any ADF file replacement

```bash
# Before overwriting core.adf:
cp .ai/core.adf .ai/core.adf.bak.$(date +%s)
# Or: git stash push -m "charter-bootstrap-backup" -- .ai/
```

### P2: Add `--merge` strategy for bootstrap on existing repos

When running on a repo with existing ADF content:
- Append the rule-routing comment block to existing core.adf (don't replace)
- Preserve existing manifest.adf triggers (add new defaults only if missing)
- Never touch state.adf (it's runtime state, not scaffold)

### P3: Emit warnings for overwritten custom content

The JSON output should include:
```json
{
  "name": "adf-init",
  "status": "pass",
  "warnings": [
    "Overwrote .ai/core.adf (35 lines of custom content replaced with scaffold)",
    "Overwrote .ai/manifest.adf (custom triggers replaced with defaults)"
  ]
}
```

### P4: Preserve rule-routing guide through formatting

Consider making the rule-routing comment block a first-class ADF section (e.g.
`📖 GUIDE:`) rather than `#` comments, so `adf fmt` preserves it. Alternatively,
document that comments are stripped by fmt and provide the guide via
`charter adf guide` command instead.

### P5: Add stemming or prefix matching to trigger keywords

`ingest` should match `ingestion`, `ingesting`, `ingested`. Either:
- Use a simple stemmer (Porter or similar) on both trigger keywords and task tokens
- Use prefix matching (keyword is a prefix of the task token)
- Allow wildcard triggers: `ingest*`

## Appendix: Bootstrap JSON Output (annotated)

The detect step correctly identified the stack:
```json
{
  "stack": "fullstack",
  "confidence": "MEDIUM",
  "runtime": ["edge-worker", "node"],
  "warnings": [
    "Multiple runtime families detected",
    "Agent standards detected (CLAUDE.md)"
  ]
}
```

The second warning ("Agent standards detected") is the perfect hook — bootstrap
KNEW CLAUDE.md existed but didn't check whether ADF files had custom content.

---
title: "Getting Started"
section: "charter"
order: 1
color: "#2ea043"
tag: "01"
---

# Getting Started

Charter is a local-first governance toolkit with a built-in AI context compiler. It validates commit governance, detects stack drift, scores risk, and ships **ADF (Attention-Directed Format)** — a modular, AST-backed context system that replaces monolithic `.cursorrules` and `claude.md` files. Everything runs locally and in CI, with no SaaS dependency.

## Install

Recommended: local dev dependency per repo.

```bash
npm install --save-dev @stackbilt/cli
```

pnpm workspace root:

```bash
pnpm add -Dw @stackbilt/cli
```

Global (optional, puts `charter` on your PATH):

```bash
npm install -g @stackbilt/cli
```

## Bootstrap a Repo

```bash
# Preview what charter detects — no files written
npx charter setup --detect-only --format json

# Write governance baseline + optional CI workflow
npx charter setup --ci github --yes

# Mixed repos (frontend + backend): choose preset explicitly
npx charter setup --detect-only
npx charter setup --preset fullstack --ci github --yes
```

`setup` writes:
- `.charter/config.json` — governance baseline config
- `.charter/patterns/*.json` — blessed-stack pattern definitions
- `.charter/policies/*.md` — human-readable policy summary
- `.github/workflows/charter-governance.yml` — CI workflow (if `--ci github`)

## Set Up ADF Context

ADF turns your LLM context into a compiled, modular system. Scaffold the `.ai/` directory:

```bash
# Scaffold .ai/ with manifest, core, and state modules
npx charter adf init

# Verify everything parses and syncs
npx charter doctor --format json
```

This creates:

```text
.ai/
  manifest.adf    # Module registry: default-load vs on-demand with triggers
  core.adf        # Always-loaded: role, constraints, metric ceilings
  state.adf       # Session state: current task, decisions, blockers
```

Edit `.ai/core.adf` to define your project constraints and LOC ceilings. The `METRICS [load-bearing]` section enforces hard limits that CI can gate on.

## Verify the Setup

```bash
npx charter doctor --format json
npx charter
```

`charter` with no arguments prints a live governance snapshot: risk score, governed commit ratio, drift status.

`doctor` validates environment health including ADF readiness: manifest existence, module parse status, and sync lock integrity.

## Run an Evidence Check

If you have ADF set up with metric ceilings, run the evidence pipeline:

```bash
# Validate all metric ceilings and produce a structured report
npx charter adf evidence --auto-measure

# CI mode: exits 1 if any ceiling is breached
npx charter adf evidence --auto-measure --ci --format json
```

## What's Next

- [CLI Reference](/cli-reference) — full command surface
- [CI Integration](/ci-integration) — GitHub Actions workflow with evidence gating
- [Ecosystem](/ecosystem) — how Charter fits into the StackBilt platform

# CLI Reference

Use `npx charter ...` if Charter is installed as a local dev dependency. Use `charter ...` if installed globally.

## Governance Commands

### charter validate

Checks commit trailers for governance compliance. Every commit should carry a `Governed-By:` trailer linking it to an ADR or governance decision.

```bash
npx charter validate                       # check recent commits
npx charter validate --ci                  # CI mode — exits 1 on violations
npx charter validate --ci --format json    # machine-readable output
npx charter validate --range HEAD~5..HEAD  # specific commit range
```

**Default range detection:** When `--range` is omitted, Charter tries `main..HEAD` or `master..HEAD` first, then falls back to the most recent 5 commits.

JSON output includes `policyOffenders` (missing required trailers) and `riskOffenders` (high-risk paths without governance), plus `effectiveRangeSource` and `defaultCommitRange` for agent transparency.

### charter drift

Scans the codebase for deviations from your blessed stack patterns. Detects unapproved dependencies, frameworks, and patterns defined in `.charter/patterns/*.json`.

```bash
npx charter drift                         # scan + print report
npx charter drift --ci --format json      # CI mode
npx charter drift --path ./packages       # scan a specific directory
```

### charter audit

Generates a governance posture report: risk score, governed commit ratio, recent violations, and trend data. Policy score uses configurable section coverage.

```bash
npx charter audit
npx charter audit --format json
npx charter audit --range HEAD~10..HEAD
```

### charter classify

Classifies a subject or change request into a governance scope.

| Scope | Meaning |
|---|---|
| `SURFACE` | UI/copy only, low risk |
| `LOCAL` | Contained to one module |
| `CROSS_CUTTING` | Touches multiple systems, requires ADR |

```bash
npx charter classify "add OAuth callback flow"
npx charter classify "migrate auth provider" --format json
```

### charter hook

Installs git hooks for commit-time governance enforcement.

```bash
npx charter hook install --commit-msg                # trailer normalization hook
npx charter hook install --pre-commit                # ADF evidence gate hook
npx charter hook install --commit-msg --pre-commit   # both hooks
npx charter hook install --commit-msg --force        # overwrite existing hooks
```

- `--commit-msg` — normalizes `Governed-By` and `Resolves-Request` trailers via `git interpret-trailers`
- `--pre-commit` — runs ADF evidence checks (LOC ceiling validation) before each commit. Only gates when `.ai/manifest.adf` exists.
- `--force` — overwrite existing non-Charter hooks

Must specify at least one of `--commit-msg` or `--pre-commit`.

### charter bootstrap

One-command repo onboarding. Orchestrates detect + setup + ADF init + install + doctor in a single flow.

```bash
npx charter bootstrap                                         # interactive
npx charter bootstrap --preset worker --ci github --yes       # fully automated
npx charter bootstrap --preset worker --security-sensitive     # security posture baseline
npx charter bootstrap --skip-install --skip-doctor            # minimal
```

- `--ci github` — generate GitHub Actions governance workflow
- `--preset <worker|frontend|backend|fullstack|docs>` — stack preset
- `--security-sensitive` — generate `SECURITY.md`, seed hard-fail drift denies in `.charter/patterns/security-deny.json`, and warn in `doctor` when no `security*` or `l4*` test file exists
- `--skip-install` — skip dependency installation phase
- `--skip-doctor` — skip health check phase
- `-y, --yes` — accept all prompts

### charter setup

Bootstraps `.charter/` config and optionally writes CI workflow scaffolding. For full onboarding, prefer `charter bootstrap` which orchestrates setup + ADF init + install + doctor.

```bash
npx charter setup --detect-only --format json
npx charter setup --ci github --yes
npx charter setup --preset fullstack --ci github --yes
```

Setup-specific options:

- `--ci github` — generate GitHub Actions governance workflow
- `--preset <worker|frontend|backend|fullstack|docs>` — stack preset
- `--detect-only` — preview detection results without writing files
- `--no-dependency-sync` — skip rewriting `@stackbilt/cli` devDependency

### charter init

Scaffolds the `.charter/` config directory without running the full setup workflow.

```bash
npx charter init
npx charter init --preset worker
```

### charter doctor

Checks CLI installation and repository config health. Validates ADF readiness: manifest existence, manifest parse, default-load module presence, sync lock status, and agent config file migration status.

```bash
npx charter doctor                    # full diagnostics
npx charter doctor --adf-only         # ADF checks only (skip Charter config)
npx charter doctor --ci --format json # CI mode: exit 1 on warnings
```

- `--adf-only` — run only ADF readiness checks, skip Charter config validation
- `--ci` — non-interactive, exits with policy violation code on warnings

### charter why

Prints a quick explanation of Charter's governance value and adoption ROI.

```bash
npx charter why
```

## ADF Commands

ADF (Attention-Directed Format) is Charter's modular AI context compiler. These commands manage the `.ai/` directory.

### charter adf init

Scaffolds `.ai/` directory with preset-aware modules. The scaffolded `core.adf` includes a `[load-bearing]` CONSTRAINTS section and a `METRICS [load-bearing]` section with starter LOC ceilings.

```bash
npx charter adf init
npx charter adf init --ai-dir ./context       # custom directory
npx charter adf init --force                  # overwrite existing
npx charter adf init --emit-pointers          # generate thin pointer files
npx charter adf init --module testing         # add a single module to existing .ai/
```

- `--ai-dir <dir>` — custom directory path (default: `.ai`). Resolved to an absolute path at runtime.
- `--force` — overwrite existing files. Without this flag, existing `.adf` files are skipped and reported; only the missing `manifest.adf` is written.
- `--emit-pointers` — generate thin pointer files (`CLAUDE.md`, `.cursorrules`, `agents.md`)
- `--module <name>` — add a single module to existing `.ai/` (delegates to `adf create`)

**Default scaffolding** (worker/frontend/backend/fullstack presets):

| File | Purpose |
|------|---------|
| `manifest.adf` | Module registry with default-load and on-demand routing |
| `core.adf` | Universal constraints, metrics, and project context |
| `state.adf` | Current session state |
| `frontend.adf` | Frontend module scaffold (triggers: React, CSS, UI) |
| `backend.adf` | Backend module scaffold (triggers: API, Node, DB) |

**Docs preset** (`--preset docs`):

| File | Purpose |
|------|---------|
| `manifest.adf` | Docs-specific module routing |
| `core.adf` | Universal constraints and metrics |
| `state.adf` | Current session state |
| `decisions.adf` | ADR and decision tracking (triggers: ADR, decision, rationale) |
| `planning.adf` | Roadmap and milestone tracking (triggers: plan, milestone, phase, roadmap) |

### charter adf create

Creates a new ADF module file and registers it in the manifest under `DEFAULT_LOAD` or `ON_DEMAND`.

```bash
npx charter adf create api-patterns                           # on-demand module (default)
npx charter adf create core-rules --load default              # default-load module
npx charter adf create react --triggers "react,jsx,component" # on-demand with triggers
npx charter adf create api-patterns --force                   # overwrite existing
```

- `--load <default|on-demand>` — loading policy (default: `on-demand`)
- `--triggers "a,b,c"` — comma-separated trigger keywords (for on-demand modules)
- `--ai-dir <dir>` — path to ADF directory (default: `.ai`)
- `--force` — overwrite existing module file

### charter adf migrate

Scans existing agent config files (`CLAUDE.md`, `.cursorrules`, `agents.md`, `GEMINI.md`, `copilot-instructions.md`), classifies their content, and migrates structured blocks into ADF modules. Replaces originals with thin pointers.

```bash
npx charter adf migrate --dry-run                # preview migration plan
npx charter adf migrate --yes                    # execute migration
npx charter adf migrate --source CLAUDE.md       # migrate a single file
npx charter adf migrate --merge-strategy replace # overwrite existing sections
npx charter adf migrate --no-backup              # skip .pre-adf-migrate.bak files
```

- `--dry-run` — preview changes without writing files
- `--source <file>` — migrate a specific file instead of scanning all
- `--merge-strategy <append|dedupe|replace>` — how to handle duplicates (default: `dedupe`)
- `--no-backup` — skip creating backup files
- `--ai-dir <dir>` — path to ADF directory (default: `.ai`)

### charter adf fmt

Parses and reformats ADF files to canonical form. Enforces emoji decorations, canonical section ordering, and 2-space indent.

```bash
npx charter adf fmt .ai/core.adf --write   # reformat in-place
npx charter adf fmt .ai/core.adf --check   # CI: exit 1 if not canonical
```

### charter adf patch

Applies typed delta operations to ADF files. Agents issue patches instead of rewriting entire files — preventing silent memory corruption.

```bash
npx charter adf patch .ai/state.adf --ops '[{"op":"ADD_BULLET","section":"STATE","value":"Reviewing PR #42"}]'
npx charter adf patch .ai/state.adf --ops-file patches.json
```

**Operations:** `ADD_BULLET`, `REPLACE_BULLET`, `REMOVE_BULLET`, `ADD_SECTION`, `REPLACE_SECTION`, `REMOVE_SECTION`, `UPDATE_METRIC`.

With `--format json`, the output includes a `changes[]` array showing per-op before/after values:

```json
{
  "file": ".ai/core.adf",
  "patched": true,
  "opsApplied": 1,
  "changes": [
    { "op": "UPDATE_METRIC", "section": "METRICS", "key": "total_loc", "before": 280, "after": 312 }
  ]
}
```

For bullet ops, `before` is the original item text (or `null` for `ADD_BULLET`); `after` is `null` for `REMOVE_BULLET`.

### charter adf bundle

Resolves manifest modules for a given task and outputs merged context with token estimate. Only loads modules whose trigger keywords match the task.

```bash
npx charter adf bundle --task "Fix the React login component"
npx charter adf bundle --task "Add REST endpoint" --format json
```

JSON output includes `triggerMatches` (with `matchedKeywords` and `loadReason`), `unmatchedModules`, `tokenEstimate`, `tokenBudget`, `tokenUtilization`, and `perModuleTokens`.

### charter adf sync

Verifies source `.adf` files match locked hashes, or updates the lock file.

```bash
npx charter adf sync --check               # CI: exit 1 on drift
npx charter adf sync --write               # update .adf.lock
npx charter adf sync --check --format json
```

### charter adf evidence

Validates metric constraints and produces a structured evidence report. The core of Charter's ADF governance pipeline.

```bash
npx charter adf evidence --auto-measure                     # full report
npx charter adf evidence --auto-measure --ci --format json  # CI gating
npx charter adf evidence --task "auth module" --auto-measure
npx charter adf evidence --context '{"entry_loc": 142}'
npx charter adf evidence --context-file metrics.json
```

**`--auto-measure`** counts lines in source files referenced by the manifest `METRICS` section and injects them as context overrides.

**Constraint semantics:** `value < ceiling` = pass, `value === ceiling` = warn, `value > ceiling` = fail.

**CI mode:** exits 1 on any constraint failure. Warnings (at boundary) surface in the report but do not fail the build.

Output includes constraint results, weight summary (load-bearing / advisory / unweighted), sync status, advisory-only warnings, and a `nextActions` array.

### charter adf metrics recalibrate

Recalibrates metric baselines and ceilings from current measured LOC. Requires a rationale for every recalibration to maintain audit trail.

```bash
npx charter adf metrics recalibrate --auto-rationale                   # auto-generate rationale
npx charter adf metrics recalibrate --reason "post-refactor baseline"  # custom rationale
npx charter adf metrics recalibrate --headroom 20 --dry-run            # preview with 20% headroom
npx charter adf metrics recalibrate --auto-rationale --format json     # machine-readable
```

- `--headroom <percent>` — percentage above current LOC for ceiling calculation (default: `15`, range: 1–200)
- `--reason "<text>"` — required rationale text (mutually exclusive with `--auto-rationale`)
- `--auto-rationale` — auto-generate rationale from headroom and metric count
- `--dry-run` — preview recalibration without writing files
- `--ai-dir <dir>` — custom `.ai/` directory (default: `.ai`)

**Behavior:** Parses all METRICS sections across manifest modules, measures current source file line counts, calculates new ceilings as `ceil(current × (1 + headroom / 100))`, and appends entries to the `BUDGET_RATIONALES` section with format:

```
{metric}_{ISO_DATE}: {old} -> {new}, ceiling {oldCeiling} -> {newCeiling}; {rationale}
```

One of `--reason` or `--auto-rationale` is required.

### charter blast

Compute the blast radius of a change: which files transitively depend on the given seed files?

```bash
npx charter blast src/kernel/dispatch.ts                    # default depth 3
npx charter blast src/a.ts src/b.ts --depth 4               # multi-seed, custom depth
npx charter blast src/foo.ts --format json                  # structured output
npx charter blast src/foo.ts --root ./packages/server       # scan a subdirectory
```

- `<file>` — one or more seed file paths (required, positional)
- `--depth <n>` — max BFS depth through the reverse dependency graph (default: `3`)
- `--root <dir>` — project root to scan (default: `.`)
- `--format json` — emit structured JSON instead of the text summary

**How it works:** Walks the source tree under `--root`, extracts imports from every TS/JS file (ES modules, CommonJS, dynamic `import()`, re-exports; comments stripped), builds forward and reverse adjacency maps, and BFS-traverses the reverse graph from each seed up to `--depth`. Auto-detects tsconfig path aliases (including `extends` chains) so monorepo `@scope/package` imports resolve correctly.

**Output includes:**
- `affected` — relative paths of files that transitively import the seeds (excludes seeds themselves)
- `hotFiles` — top 20 most-imported files in the graph (architectural hubs)
- `summary.totalAffected`, `summary.seedCount`, `summary.depthHistogram`

**Governance signal:** blast radius ≥20 files triggers a `CROSS_CUTTING` warning in text mode. Use this as a gate to escalate wide-reaching changes to architectural review.

**Semantics:** zero runtime dependencies, no LLM calls, no TypeScript compiler API. Regex-based import extraction — trades some precision for universality across JavaScript/TypeScript/ESM/CommonJS projects.

### charter serve

Expose ADF project context as an MCP server over stdio, for use with Claude Code.

```bash
npx charter serve                             # stdio MCP server (default)
npx charter serve --ai-dir /abs/path/.ai      # explicit ADF directory
npx charter serve --name "my-project"         # override the server name shown in Claude Code
```

- `--ai-dir <dir>` — path to the `.ai/` ADF directory (default: `.ai`). **Always resolved to an absolute path at startup.** When wiring in `.mcp.json`, use an absolute path or a path relative to the project root — relative paths are resolved against the working directory at spawn time, which may differ from the project root in multi-repo setups.
- `--name <name>` — override the MCP server name (default: inferred from `core.adf` `PROJECT` section or directory name).

#### Wiring in `.mcp.json`

```json
{
  "mcpServers": {
    "charter": {
      "command": "npx",
      "args": ["@stackbilt/cli", "serve", "--ai-dir", "/absolute/path/to/.ai"]
    }
  }
}
```

Use an absolute path for `--ai-dir`. A relative path like `.ai` resolves against the MCP host's working directory at spawn time, which may not be the project root.

#### Startup errors

If startup validation fails (missing `.ai/` directory or `manifest.adf`), `charter serve` emits a structured JSON-RPC error to stdout before exiting so Claude Code can surface a human-readable message:

| Condition | Error message | Fix |
|-----------|--------------|-----|
| `.ai/` directory missing | `No .ai/ directory found.` | `charter init` |
| `manifest.adf` missing | `.ai/manifest.adf not found.` | `charter adf init` |

#### Registered MCP tools

| Tool | Description |
|------|-------------|
| `charter_brief` | **Call first.** Pre-digested repo brief — routes, hotspots, governance. |
| `getProjectContext` | ADF bundle resolved for a given task or trigger keywords. |
| `getProjectState` | Constraint validation results across all loaded modules. |
| `getArchitecturalDecisions` | Load-bearing constraints from `core.adf`. |
| `getRecentChanges` | Recent git commits classified by type. |
| `charter_blast` | Blast radius for one or more source files. |
| `charter_surface` | API surface — HTTP routes and D1/SQLite schema tables. |
| `updateEvidence` | **Write-back.** Measures metric source files, patches ADF with current values, returns before/after diff + live constraint status. |

##### `updateEvidence` — keeping ADF metrics accurate

Call after code changes that affect tracked metrics (e.g. after adding files to a module that has a `LOC` ceiling):

```json
// MCP call — no args needed for a full refresh
{ "tool": "updateEvidence" }

// Preview first without writing
{ "tool": "updateEvidence", "dryRun": true }

// Update specific metrics only
{ "tool": "updateEvidence", "metrics": ["total_loc", "test_count"] }
```

Returns:

```json
{
  "measured": [{ "metricKey": "total_loc", "sourcePath": "src/core.ts", "measured": 312 }],
  "changes": [{ "file": "core.adf", "metricKey": "total_loc", "section": "METRICS", "before": 280, "after": 312 }],
  "skipped": [],
  "written": ["core.adf"],
  "constraints": { "allPassing": true, "failCount": 0, "warnCount": 1, "items": [...] },
  "hint": "Run `charter adf sync --write` to update .adf.lock"
}
```

`updateEvidence` does **not** update `.adf.lock`. Run `charter adf sync --write` separately if you need lock hygiene (this preserves the drift-detection signal for CI).

### charter context

Pre-digested repo brief for AI agents. Composes routes (surface), hotspots (blast), sensitivity tags, and governance posture into a single bounded markdown document.

**The fastest way to orient an AI agent in a Charter-governed repo.** Reading the brief replaces 15-30 cold-boot discovery tool calls.

#### Usage

```bash
npx charter context                   # print brief + write .charter/context.md
npx charter context --stdout-only     # print only, no file write
npx charter context --verbose         # no token ceiling (for human reading)
npx charter context --write           # write .charter/context.md only (for hooks)
```

#### Brief sections

| Section | Source | Always present |
| ------- | ------ | -------------- |
| Identity | `.charter/config.json` + `package.json` | Yes |
| Surface | `charter surface` (routes + D1 tables) | Yes |
| Hotspots | `charter blast` (top hot files by importer count) | Yes |
| Sensitivity | `.charter/config.json` sensitivity tags | Yes |
| Governance | `.ai/manifest.adf` module routing | Yes |

#### Token budget

The brief is capped at **2000 tokens** (~8000 characters). When content exceeds the budget, sections are truncated in this order: hotspots tail → D1 tables → routes → governance ON_DEMAND entries. A `## Truncated` section is appended listing what was reduced.

Use `--verbose` to remove the ceiling for interactive sessions.

#### MCP tool

`charter serve` registers `charter_brief`. Agents should call this first:

> "CALL THIS FIRST when entering a Charter-governed repo. Returns routes, hotspots, sensitivity tags, and governance in a single pre-digested brief — replaces 15-30 discovery tool calls."

#### Post-commit hook (keep brief fresh)

```bash
echo 'charter context --write' >> .git/hooks/post-commit
chmod +x .git/hooks/post-commit
```

Or use `charter bootstrap` — it adds this as a suggested next step.

#### Blast seed strategy

Seeds for hotspot analysis are chosen by preset (from `.charter/config.json`):

| Preset | Seeds |
| ------ | ----- |
| worker | `src/index.*`, route files, wrangler entry |
| frontend | `src/App.*`, `src/main.*`, `src/index.*` |
| backend | `src/index.*`, `src/server.*`, `src/app.*` |
| fullstack | worker + frontend seeds |
| cli | `bin/` entries, `src/commands/*.ts` |
| docs | `README.md`, `docs/*.md` |
| unknown | `src/index.*`, `src/main.*` |

### charter surface

Extract the API surface of a project: HTTP routes and database schema tables.

```bash
npx charter surface                                 # text summary
npx charter surface --format json                   # machine-readable
npx charter surface --markdown                      # for .ai/surface.adf injection
npx charter surface --root ./packages/worker        # scan a subdirectory
npx charter surface --schema db/schema.sql          # explicit schema path
```

- `--root <dir>` — project root to scan (default: `.`)
- `--schema <path>` — explicit schema SQL file (default: auto-detect `*schema*.sql` under root)
- `--markdown` / `--md` — emit markdown suitable for `.ai/surface.adf` or AI mission brief injection
- `--format json` — emit structured JSON

**Detects:**
- **Routes** — Hono, Express, itty-router via regex. Requires path arguments to start with `/` to avoid false positives from unrelated method calls. Strips block and line comments before scanning so jsdoc examples don't match.
- **Schema** — D1/SQLite `CREATE TABLE` statements, column types (including parameterized like `VARCHAR(255)`), column flags: `PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `DEFAULT`. Skips table-level constraints (`FOREIGN KEY`, `CHECK`).
- **Prefixes** — `.basePath('/api/v1')` annotations on Hono routers

**Ignores:** `__tests__/`, `__mocks__/`, `__fixtures__/`, and any `*.test.*` / `*.spec.*` files — test fixtures contain route-like strings that aren't real routes.

**Exit codes:** returns `2` with a usage error if no routes or schema tables are detected (surface is designed for Cloudflare Worker / Hono / Express projects with a `schema.sql` file; falling through silently on a non-Worker project would be misleading).

**Use cases:**
- **Breaking-change detection** — diff the JSON output before and after a PR to identify removed endpoints or dropped columns. Feeds into version-bump automation.
- **Auto-generated AI context** — pipe `--markdown` output into `.ai/surface.adf` so LLM agents always know the API shape.
- **Mission brief fingerprinting** — inject the markdown output into autonomous task runner prompts so agents don't burn turns exploring project layout.

## Global Flags

| Flag | Effect |
|---|---|
| `--config <path>` | Path to `.charter/` directory (default: `.charter/`) |
| `--format json` | Machine-readable output with stable schemas |
| `--ci` | Non-interactive, deterministic exit codes |
| `--yes` | Accept all prompts (for automation) |
| `--preset <name>` | Stack preset (`worker`, `frontend`, `backend`, `fullstack`, `docs`) |
| `--detect-only` | Setup mode: detect stack/preset and exit |
| `--no-dependency-sync` | Setup mode: do not rewrite `@stackbilt/cli` devDependency |
| `--force` | Overwrite existing files (hooks, ADF modules, config) |

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success / pass |
| `1` | Policy violation (CI mode: governance threshold breached) |
| `2` | Runtime / config / usage error |

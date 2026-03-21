# Charter Kit

[![npm version](https://img.shields.io/npm/v/@stackbilt/cli?label=charter&color=5F7FFF&style=for-the-badge)](https://www.npmjs.com/package/@stackbilt/cli)

![Charter Kit hero](./stackbilt-charter-2.png)

## The Problem

You write a CLAUDE.md. You add a `.cursorrules`. You paste instructions into GEMINI.md. Your AI agent loads all of it into the context window -- 10,000 tokens of flat, unstructured rules competing with the actual work.

Half get ignored. You don't know which half.

## The Solution

Charter is an open-source CLI that replaces monolithic agent config files with **ADF (Attention-Directed Format)** -- a modular context system where agents load only the rules they need for the current task.

Instead of one big file, you get a manifest. The manifest declares modules, trigger keywords that load them on demand, token budgets, and weighted sections that tell the agent what's load-bearing vs. advisory.

```bash
npm install --save-dev @stackbilt/cli
npx charter bootstrap --yes   # detect stack, scaffold .ai/, migrate existing rules
```

## Five-Minute Adoption

Already have agent config files? Charter migrates them:

```bash
# See what would happen (dry run)
charter adf migrate --dry-run

# Migrate: classifies rules by strength, routes to ADF modules, replaces originals with thin pointers
charter adf migrate
```

Your `CLAUDE.md` / `.cursorrules` / `GEMINI.md` content gets classified (imperative vs. advisory vs. neutral), routed to the right module (frontend rules to `frontend.adf`, backend rules to `backend.adf`), and your originals become one-line pointers to `.ai/`. No content lost, no rewrite needed.

## How ADF Works

Charter manages context through the `.ai/` directory:

```text
.ai/
  manifest.adf    # Module registry: default-load vs on-demand with trigger keywords
  core.adf        # Always-loaded: role, constraints, output format, metric ceilings
  state.adf       # Session state: current task, decisions, blockers
  frontend.adf    # On-demand: loaded when task mentions "react", "css", etc.
  backend.adf     # On-demand: loaded when task mentions "endpoint", "REST", etc.
```

When you run `charter adf bundle --task "Fix the React login component"`, Charter:
1. Reads the manifest
2. Loads `core.adf` and `state.adf` (always loaded)
3. Sees "React" matches a trigger keyword -- loads `frontend.adf`
4. Skips `backend.adf` (no matching triggers)
5. Merges the loaded modules into a single context payload with token budget tracking

The agent gets exactly the rules it needs. Nothing more.

### Format Example

```text
ADF: 0.1

TASK:
  Build the user dashboard

CONTEXT:
  - React 18 with TypeScript
  - TailwindCSS for styling
  - REST API at /api/v2

CONSTRAINTS [load-bearing]:
  - No external state libraries
  - Must support SSR

METRICS [load-bearing]:
  entry_loc: 142 / 500 [lines]
  handler_loc: 88 / 300 [lines]

STATE:
  CURRENT: Implementing layout grid
  NEXT: Add data fetching
  BLOCKED: Waiting on API schema
```

Sections use emoji decorations for attention signaling, support four content types (text, list, key-value map, and metric with value/ceiling/unit), and follow a canonical ordering the formatter enforces. `[load-bearing]` vs `[advisory]` weight annotations distinguish measurable constraints from preferences. Metric entries (`key: value / ceiling [unit]`) define hard ceilings that the `evidence` command validates automatically.

## Self-Governance: Charter Enforces Its Own Rules

This isn't theoretical. Charter uses ADF to govern its own codebase. The `.ai/` directory in this repository contains the same modules and metric ceilings that any adopting repo would use.

Every commit runs through a pre-commit hook that executes `charter adf evidence --auto-measure`. If a source file exceeds its declared LOC ceiling, the commit is rejected. We can't ship code that violates our own governance rules -- even by accident, even at 2am.

Here is the actual output from Charter's own evidence check (v0.7.0):

```text
  ADF Evidence Report
  ===================
  Modules loaded: core.adf, state.adf
  Token estimate: ~494
  Token budget: 4000 (12%)

  Auto-measured:
    adf_commands_loc: 618 lines (packages/cli/src/commands/adf.ts)
    adf_bundle_loc: 175 lines (packages/cli/src/commands/adf-bundle.ts)
    adf_sync_loc: 213 lines (packages/cli/src/commands/adf-sync.ts)
    adf_evidence_loc: 272 lines (packages/cli/src/commands/adf-evidence.ts)
    adf_migrate_loc: 474 lines (packages/cli/src/commands/adf-migrate.ts)
    bundler_loc: 125 lines (packages/adf/src/bundler.ts)
    parser_loc: 214 lines (packages/adf/src/parser.ts)
    cli_entry_loc: 191 lines (packages/cli/src/index.ts)

  Constraints:
    [ok] adf_commands_loc: 618 / 650 [lines] -- PASS
    [ok] adf_bundle_loc: 175 / 200 [lines] -- PASS
    [ok] adf_sync_loc: 213 / 250 [lines] -- PASS
    [ok] adf_evidence_loc: 272 / 380 [lines] -- PASS
    [ok] adf_migrate_loc: 474 / 500 [lines] -- PASS
    [ok] bundler_loc: 125 / 500 [lines] -- PASS
    [ok] parser_loc: 214 / 300 [lines] -- PASS
    [ok] cli_entry_loc: 191 / 200 [lines] -- PASS

  Verdict: PASS
```

What this shows:

- **Metric ceilings enforce LOC limits on source files.** Each metric in a `.adf` module declares a ceiling. `--auto-measure` counts lines live from the sources referenced in the manifest.
- **Self-correcting architecture.** When `bundler_loc` hit 413/500, Charter's own evidence gate flagged the pressure. The file was split into three focused modules (`manifest.ts`, `merger.ts`, `bundler.ts`) -- now 125/500. The system caught the problem and the system verified the fix.
- **CI gating.** Generated governance workflows run `doctor --adf-only --ci` and `adf evidence --auto-measure --ci` on every PR, blocking merges on ceiling breaches.
- **Available to any repo.** This is the same system you get by running `charter adf init` in your own project.

## Quick Reference

```bash
# Scaffold .ai/ with starter modules
charter adf init

# Reformat to canonical form
charter adf fmt .ai/core.adf --write

# Apply a typed patch
charter adf patch .ai/state.adf --ops '[{"op":"ADD_BULLET","section":"STATE","value":"Reviewing PR #42"}]'

# Bundle context for a task (trigger-based module loading)
charter adf bundle --task "Fix the React login component"

# Migrate existing agent configs into ADF
charter adf migrate --dry-run

# Verify .adf files haven't drifted from locked hashes
charter adf sync --check

# Validate metric constraints
charter adf evidence --auto-measure

# Recalibrate metric ceilings
charter adf metrics recalibrate --headroom 15 --reason "Scope expansion" --dry-run

# Expose ADF context as an MCP server (for Claude Code / any MCP client)
charter serve
```

## Why Charter

- **Modular AI context** -- trigger-routed `.ai/` modules replace monolithic config files
- **Five-minute migration** -- classify and route existing CLAUDE.md / .cursorrules / GEMINI.md rules automatically
- **MCP server** -- `charter serve` exposes your ADF context as an MCP server; Claude Code can query constraints, architectural decisions, and recent changes without reading raw files
- **Evidence-based governance** -- metric ceilings with auto-measurement, structured pass/fail reports, CI gating
- **Self-regulating** -- pre-commit hooks enforce constraints before code lands
- **Commit governance** -- validate `Governed-By` and `Resolves-Request` trailers, score commit risk
- **Drift detection** -- scan for stack drift against blessed patterns
- **Stable JSON output** -- every command supports `--format json` with `nextActions` hints for agent workflows

## Install

```bash
npm install --save-dev @stackbilt/cli
```

For pnpm workspaces: `pnpm add -Dw @stackbilt/cli`. For global install: `npm install -g @stackbilt/cli`.

## Getting Started

### Human Workflow

```bash
charter                              # Repo risk/value snapshot
charter bootstrap --ci github        # One-command onboarding
charter doctor                       # Validate environment/config
charter validate                     # Check commit governance
charter drift                        # Scan for stack drift
charter audit                        # Governance summary
charter adf init                     # Scaffold .ai/ context directory

# Stack generation (Stackbilder engine)
charter login --key sb_live_xxx      # Store API key
stackbilt run "A real-time chat app on Cloudflare"   # Architect + scaffold in one step
stackbilt run --cloudflare-only --framework Hono --database D1
charter architect "A real-time chat app on Cloudflare"   # Or step-by-step:
charter scaffold --output ./my-project
```

### Claude Code Integration (MCP)

`charter serve` exposes your `.ai/` modules as an MCP server. Add it to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "charter": {
      "command": "charter",
      "args": ["serve"]
    }
  }
}
```

Claude Code can then call `getProjectContext`, `getArchitecturalDecisions`, `getProjectState`, and `getRecentChanges` directly — no manual `adf bundle` needed in the conversation.

### Agent Workflow

Prefer JSON mode and exit-code handling:

```bash
charter --format json
charter setup --ci github --yes --format json
charter doctor --format json
charter validate --format json --ci
charter drift --format json --ci
charter audit --format json
charter adf bundle --task "describe the task" --format json
charter adf evidence --auto-measure --format json --ci
charter adf sync --check --format json
```

Agent contract:
- Inputs: git repo + optional existing `.charter/`
- Stable machine output: `--format json` with `nextActions` hints where applicable
- Exit codes: `0` success, `1` policy violation, `2` runtime/usage error
- CI behavior: with `--ci`, treat `1` as gating failure and surface actionable remediation
- Evidence: `adf evidence --ci` exits 1 on metric ceiling breaches; warnings (at boundary) don't fail

<details>
<summary>Trailer Adoption Ramp</summary>

Teams often score lower early due to missing governance trailers. Use this ramp:
- Stage 1: run `charter validate --ci --format json` in PR CI and fail on policy violations.
- Stage 2: add a commit template in the repo that includes `Governed-By` and `Resolves-Request`.
- Stage 3: track audit trend; trailer coverage should rise naturally as PR gating normalizes behavior.

</details>

## Cross-Platform Support

Charter works across WSL, PowerShell, CMD, macOS, and Linux. All git operations use a unified invocation layer with cross-platform PATH resolution. Line endings are normalized via `.gitattributes`.

## Command Reference

- `charter`: show repo risk/value snapshot and recommended next action
- `charter bootstrap [--ci github] [--preset <name>] [--yes] [--skip-install] [--skip-doctor]`: one-command onboarding (detect + setup + ADF + migrate + install + doctor)
- `charter setup [--ci github] [--preset <worker|frontend|backend|fullstack|docs>] [--detect-only] [--no-dependency-sync]`: detect stack and scaffold `.charter/` baseline
- `charter init [--preset <worker|frontend|backend|fullstack>]`: scaffold `.charter/` templates only
- `charter doctor [--adf-only]`: validate environment/config state (`--adf-only` runs strict ADF wiring checks)
- `charter validate [--ci] [--range <revset>]`: validate commit governance and citations
- `charter drift [--path <dir>] [--ci]`: run drift scan
- `charter audit [--ci] [--range <revset>]`: produce governance audit summary
- `charter classify <subject>`: classify change scope heuristically
- `charter hook install --commit-msg [--force]`: install commit-msg trailer normalization hook
- `charter hook install --pre-commit [--force]`: install pre-commit ADF routing + evidence gate
- `charter adf init [--ai-dir <dir>] [--force]`: scaffold `.ai/` context directory
- `charter adf fmt <file> [--check] [--write]`: parse and reformat ADF files to canonical form
- `charter adf fmt --explain`: show canonical formatter section ordering
- `charter adf patch <file> --ops <json> | --ops-file <path>`: apply typed delta operations
- `charter adf create <module> [--triggers "a,b,c"] [--load default|on-demand]`: create and register a module
- `charter adf bundle --task "<prompt>" [--ai-dir <dir>]`: resolve manifest and output merged context
- `charter adf sync --check [--ai-dir <dir>]`: verify .adf files match locked hashes
- `charter adf sync --write [--ai-dir <dir>]`: update `.adf.lock` with current hashes
- `charter adf evidence [--task "<prompt>"] [--ai-dir <dir>] [--auto-measure] [--context '{"k":v}'] [--context-file <path>]`: validate metric constraints and produce evidence report
- `charter adf metrics recalibrate [--headroom <percent>] [--reason "<text>"|--auto-rationale] [--dry-run]`: recalibrate metric baselines/ceilings
- `charter adf migrate [--dry-run] [--source <file>] [--no-backup] [--merge-strategy append|dedupe|replace]`: migrate existing agent config files into ADF modules
- `charter serve [--name <name>] [--ai-dir <dir>]`: start an MCP server (stdio) exposing ADF context as tools and resources for Claude Code and other MCP clients
- `charter login --key <key>`: store Stackbilt API key for engine access (`~/.charter/credentials.json`)
- `charter login --logout`: clear stored credentials
- `charter architect <description>`: generate tech stack from project description via stackbilt-engine
- `charter architect --file <path>`: generate stack from spec file
- `charter architect --cloudflare-only --framework <name> --database <name>`: constrained stack generation
- `charter scaffold [--output <dir>] [--dry-run]`: write scaffold files from last `architect` build
- `charter run <description>` / `stackbilt run <description>`: architect + scaffold in one animated step
- `charter run --file <path>`: same, from spec file
- `charter telemetry report [--period <30m|24h|7d>]`: summarize local CLI telemetry
- `charter why`: explain adoption rationale and expected payoff

Global options: `--config <path>`, `--format text|json`, `--ci`, `--yes`.

## Exit Code Contract

- `0`: success/pass
- `1`: policy violation in CI mode
- `2`: runtime/config/usage error

## CI Integration

- Reusable template: `.github/workflows/governance.yml`
- Generated in target repos by `charter setup --ci github`: `.github/workflows/charter-governance.yml`
- The governance workflow runs `validate`, `drift`, ADF wiring integrity (`doctor --adf-only --ci`), ADF ceiling evidence (`adf evidence --auto-measure --ci`), and `audit` on every PR.

## Workspace Layout

```text
packages/
  types/      Shared contracts
  core/       Schemas, sanitization, errors
  adf/        ADF parser, formatter, patcher, bundler, evidence pipeline
  git/        Trailer parsing and risk scoring
  classify/   Heuristic classification
  validate/   Governance validation
  drift/      Pattern drift scanning
  cli/        `charter` command
  ci/         GitHub Actions integration helpers
```

## Development

- `pnpm run clean`
- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run test`

## SemVer and Stability Policy

Charter uses [Semantic Versioning](https://semver.org/) for this repository and for published `@stackbilt/*` packages.

Until `1.0.0`, Charter may still evolve quickly, but breaking changes should remain exceptional, deliberate, and clearly documented. The goal of `1.0.0` is simple: a connected coding agent or developer can rely on Charter's machine-facing contracts without source archaeology.

The following surfaces are semver-governed:

- **Package APIs** -- exported functions, classes, and types from published `@stackbilt/*` packages
- **CLI behavior** -- command names, flags, exit codes, and machine-readable `--format json` output
- **ADF behavior** -- parse, format, patch, bundle, sync, and evidence semantics
- **Generated artifacts** -- thin pointer files, `.ai/manifest.adf`, `.adf.lock`, and related scaffolded outputs
- **Governance schemas** -- evidence, audit, drift, doctor, and scorecard JSON envelopes

Versioning rules:

- **PATCH** -- bug fixes, docs, internal refactors, and non-breaking UX improvements
- **MINOR** -- additive commands, flags, fields, modules, templates, and advisory checks that do not break existing consumers
- **MAJOR** -- incompatible changes to CLI contracts, JSON schemas, ADF semantics, generated artifact conventions, or other machine-facing behavior that agents may rely on

For agent-facing workflows, schema stability is treated as a core product promise, not a nice-to-have.

## Research & White Papers

The [`papers/`](./papers/) directory contains Charter's research narrative:

| Entry Point | Purpose |
|---|---|
| [Papers Index](./papers/README.md) | Research papers, UX feedback, and release planning docs |
| [UX Feedback Index](./papers/ux-feedback/README.md) | Journey-bucketed ADX findings |
| [Release Plans Index](./papers/releases/README.md) | Versioned plans mapping feedback to implementation |
| [`@stackbilt/adf` API](./packages/adf/README.md) | Full ADF package API documentation |

## Release Docs

- `PUBLISHING.md`: first release/publish workflow
- `CHANGELOG.md`: user-visible change history
- `CONTRIBUTING.md`: contribution conventions
- `SECURITY.md`: vulnerability reporting

## License

Apache-2.0. See [LICENSE](./LICENSE).

<p>
  <a href="https://www.buymeacoffee.com/kurto" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-5F7FFF?style=for-the-badge&logo=buymeacoffee&logoColor=FFDD00" alt="Buy me a coffee" />
  </a>
</p>

# Charter

[![npm version](https://img.shields.io/npm/v/@stackbilt/cli?label=charter&color=5F7FFF&style=for-the-badge)](https://www.npmjs.com/package/@stackbilt/cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge)](./LICENSE)
[![Discord](https://img.shields.io/discord/1485683351393407006?color=7289da&label=Discord&logo=discord&logoColor=white&style=for-the-badge)](https://discord.gg/aJmE8wmQDS)

## Local-first AI agent governance for your repo.

Tell your AI agents what they can and can't do. Charter gives you modular context loading (ADF), measurable ceilings on every module, commit-time validation, and pre-merge blast-radius analysis. Zero product dependencies. No network calls. No credentials stored.

```bash
npx @stackbilt/cli bootstrap --yes
```

Detects your stack, scaffolds `.ai/`, migrates existing CLAUDE.md / `.cursorrules` / GEMINI.md into on-demand modules with trigger keywords.

## What you get

- **Modular agent context (ADF)** — replace monolithic CLAUDE.md with trigger-driven on-demand module loading. Agents pull only the rules each task needs.
- **Measurable constraints** — per-module metric ceilings (LOC, complexity, bloat) validated at commit time and in CI.
- **Codebase analysis** — `charter blast` reverse-dependency graphs, `charter surface` route/schema fingerprints. Deterministic, zero runtime deps.
- **Drift + audit** — anti-pattern scans, commit governance, CI-ready exit codes.
- **MCP server** — `charter serve` exposes project context to Claude Code, Codex, and Cursor.

Compose with the broader [Stackbilt ecosystem](https://github.com/Stackbilt-dev) — [audit-chain](https://github.com/Stackbilt-dev/audit-chain), [worker-observability](https://github.com/Stackbilt-dev/worker-observability), [llm-providers](https://github.com/Stackbilt-dev/llm-providers), [adf](https://www.npmjs.com/package/@stackbilt/adf) — when you need them.

## Install

```bash
npm install --save-dev @stackbilt/cli
```

For pnpm workspaces: `pnpm add -Dw @stackbilt/cli`. For global install: `npm install -g @stackbilt/cli`.

### Non-Node repos (C++, Go, Rust, etc.)

Charter works as a local governance tool in any repo — Node is not required as your primary build system. Add it as a dev dependency and invoke it without a global install:

```bash
# Install (WSL-safe mode if you hit symlink errors — see below)
npm install --save-dev @stackbilt/cli --no-bin-links

# Run via npx (resolves from local node_modules, no global install needed)
npx --no-install charter bootstrap --yes
npx --no-install charter doctor --adf-only

# Or invoke directly
./node_modules/.bin/charter doctor --adf-only
```

Add to your `package.json` scripts for convenience:

```json
"scripts": {
  "governance:check": "charter audit --ci",
  "governance:doctor": "charter doctor --adf-only"
}
```

### WSL / DrvFs installs

Two distinct issues can appear when the repo lives on a Windows-mounted filesystem (`/mnt/c/...`, `/mnt/d/...`):

| Symptom | Package manager | Fix |
|---------|----------------|-----|
| `EPERM: operation not permitted, symlink` on `.bin/charter` | npm | `npm install --save-dev @stackbilt/cli --no-bin-links` — skips symlink creation; use `npx --no-install charter` or `./node_modules/.bin/charter` to invoke |
| `EACCES` on atomic rename during install | pnpm | `pnpm add --force` or move the repo to a Linux-native path (`~/projects/`) |

Both flags are safe for CI environments where the filesystem is Linux-native — the workarounds only matter locally on DrvFs mounts.

### npm peer-dependency conflicts on install/upgrade

Installing or upgrading `@stackbilt/cli` can fail under npm's strict peer resolver with an `ERESOLVE` error — for example, a conflict involving `zod` when your app already depends on a package whose peer range differs from Charter's (`zod@^3`):

```text
npm error ERESOLVE could not resolve
npm error While resolving: your-app@x.y.z
npm error Found: zod@3.x  …  peer zod@"^4.0.0" from agents@0.12.3
```

This is a conflict in your existing dependency tree that npm surfaces while re-resolving — Charter's runtime is unaffected once installed. Fix it one of two ways:

| Fix | When |
|-----|------|
| `npm install --save-dev @stackbilt/cli --legacy-peer-deps` | Fastest unblock; tells npm to use the looser legacy resolution it used before v7 |
| Align the conflicting dependency's version in your app (e.g. upgrade/downgrade `zod` so one range satisfies both) | Preferred long-term; removes the conflict at its source |

`pnpm` and `yarn` use a more permissive resolver and generally install without this flag.

## AI agent governance with ADF

Charter replaces monolithic agent config files (CLAUDE.md, .cursorrules, GEMINI.md) with **ADF (Attention-Directed Format)** -- a modular context system where agents load only the rules they need.

**The problem:** You write 10,000 tokens of flat rules. Your agent loads all of it. Half gets ignored. You don't know which half.

**The fix:** A manifest that declares modules, trigger keywords that load them on demand, token budgets, and weighted sections that tell the agent what matters.

```bash
charter bootstrap --yes   # detect stack, scaffold .ai/, migrate existing rules
```

### How it works

```text
.ai/
  manifest.adf    # Module registry: default vs on-demand with trigger keywords
  core.adf        # Always loaded: role, constraints, metric ceilings
  state.adf       # Session state: current task, decisions, blockers
  frontend.adf    # On-demand: loaded when task mentions "react", "css", etc.
  backend.adf     # On-demand: loaded when task mentions "endpoint", "REST", etc.
```

When you run `charter adf bundle --task "Fix the React login component"`, Charter loads `core.adf` + `state.adf` (always), adds `frontend.adf` (trigger match on "React"), skips `backend.adf`. The agent gets exactly the rules it needs.

### Five-minute migration

Already have agent config files? Charter migrates them:

```bash
charter adf migrate --dry-run   # Preview what would happen
charter adf migrate             # Classify rules, route to ADF modules, replace originals
```

Your existing content gets classified by strength (imperative vs. advisory), routed to the right module, and originals become one-line pointers to `.ai/`. No content lost.

### Metric ceilings

ADF modules can declare measurable constraints:

```text
METRICS [load-bearing]:
  entry_loc: 142 / 500 [lines]
  handler_loc: 88 / 300 [lines]
```

`charter adf evidence --auto-measure` validates these live. Pre-commit hooks reject code that exceeds ceilings. CI workflows gate merges. Charter enforces its own rules on its own codebase -- every commit.

### MCP server for Claude Code and Codex

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

Claude Code can query `getProjectContext`, `getArchitecturalDecisions`, `getProjectState`, and `getRecentChanges` directly.

Codex/Cursor can use the same MCP wiring via `.mcp.json`:

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

The `charter_brief` MCP tool composes routes, hotspots, and governance into a single pre-digested brief — call it first in any agent session to skip 15-30 cold-boot discovery calls.

For live session continuity snapshots, use `charter context-refresh` to produce `.ai/context.adf` + `.ai/context.snapshot.json` (with optional GitHub source and TTL controls).

## Which command do I run?

| Situation | Command |
|---|---|
| I want to inspect a repo without changing anything | `charter setup --detect-only --format json` |
| I want the fastest full repo onboarding path | `charter bootstrap --ci github` |
| I want to install GitHub PR governance | `charter setup --ci github --yes` |
| I want to initialize ADF context modules | `charter adf init` |
| I want to compile task-specific agent context | `charter adf bundle --task "Fix the login flow"` |
| I want to enforce metric/file-size ceilings | `charter adf evidence --auto-measure --ci` |
| I want to migrate existing agent docs | `charter adf migrate --dry-run` |
| I want to validate governance in CI | `charter validate --ci --format json` |
| I want to check pattern drift | `charter drift --ci --format json` |
| I want to audit governance coverage | `charter audit --ci --format json` |
| I want to install commit trailer normalization | `charter hook install --commit-msg` |
| I want to install ADF pre-commit checks | `charter hook install --pre-commit` |
| I want session context for agent workflows | `charter context-refresh --once` or `charter hook print --claude` |
| I want to start the MCP server for Claude Code / Codex / Cursor | `charter serve` |

## Commands

### Govern

```bash
charter                                  # Repo risk/value snapshot
charter bootstrap --ci github            # One-command onboarding
charter bootstrap --security-sensitive   # SECURITY.md + hard security drift denies
charter context                          # pre-digested repo brief for AI agents (routes, hotspots, governance)
charter context-refresh                  # live session snapshot (.ai/context.adf + .ai/context.snapshot.json)
charter doctor                           # Environment/config health check
charter validate                         # Commit governance (trailers)
charter drift                            # Pattern drift scanning
charter audit                            # Governance summary
```

### ADF

```bash
charter adf init                         # Scaffold .ai/ directory
charter adf bundle --task "..."          # Merge context for a task
charter adf evidence --auto-measure      # Validate metric constraints
charter adf migrate                      # Migrate existing configs
charter adf sync --check                 # Verify files match lock
charter adf fmt .ai/core.adf --write     # Reformat to canonical form
charter adf metrics recalibrate          # Adjust ceilings to current state
charter serve                            # MCP server for Claude Code, Codex, Cursor
```

### Analyze

```bash
charter blast src/foo.ts                 # Blast radius: files that transitively import the seed
charter blast src/a.ts src/b.ts --depth 4  # Multi-seed, custom BFS depth
charter surface                          # Extract routes (Hono/Express) + D1 schema
charter surface --markdown               # Emit as markdown for .ai/surface.adf or AI context
```

Deterministic codebase analysis — no LLM calls, zero runtime dependencies. `blast` warns on large radiuses (≥20 files) as a CROSS_CUTTING signal; `surface` is a lightweight alternative to full AST walks for Cloudflare Worker projects.

All commands support `--format json` with `nextActions` hints for agent workflows.

### Score badge

`charter score` can emit a [shields.io endpoint](https://shields.io/badges/endpoint-badge) JSON payload so you can display your repo's AI-readiness grade as a live badge in your README.

```bash
# Print shields.io endpoint JSON to stdout
charter score --badge

# Also write to .charter/badge.json for serving via raw.githubusercontent.com
charter score --badge --write
```

Once `.charter/badge.json` is committed and pushed, add this to your README (replace `<org>`, `<repo>`, and `<branch>`):

```markdown
[![Agent context](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/<org>/<repo>/<branch>/.charter/badge.json)](https://github.com/Stackbilt-dev/charter)
```

Example output for a score of 92 (grade A):

```json
{"schemaVersion":1,"label":"agent context","message":"A (92)","color":"brightgreen"}
```

Color scale: A = brightgreen, B = green, C = yellowgreen, D = yellow, F = red.

### Exit codes

- `0`: success
- `1`: policy violation (CI mode)
- `2`: runtime/usage error

## Resume Guide

Need to resume `context-refresh` roadmap work quickly next session?

- See [docs/context-refresh-resume.md](./docs/context-refresh-resume.md) for current status, shipped commits, Phase 3 remaining scope, and exact validation commands.

## Modular packages

Charter is built as a monorepo. Individual packages are published to npm and usable independently:

| Package | Purpose |
|---------|---------|
| `@stackbilt/adf` | ADF parser, formatter, patcher, bundler, evidence pipeline |
| `@stackbilt/git` | Trailer parsing, commit risk scoring |
| `@stackbilt/classify` | Heuristic change classification |
| `@stackbilt/validate` | Governance validation |
| `@stackbilt/drift` | Anti-pattern scanning |
| `@stackbilt/blast` | Reverse dependency graph + blast radius analysis |
| `@stackbilt/surface` | API surface extraction (routes + D1 schema) |
| `@stackbilt/core` | Schemas, sanitization, error contracts |
| `@stackbilt/types` | Shared TypeScript contracts |
| `@stackbilt/ci` | GitHub Actions integration helpers |

## Development

```bash
pnpm install && pnpm run build && pnpm run test
```

Full publish workflow: see [PUBLISHING.md](./PUBLISHING.md).

## License

Apache-2.0. See [LICENSE](./LICENSE).

---

Built by [Kurt Overmier](https://github.com/kurtovermier) / [Stackbilt](https://stackbilt.dev)

<p>
  <a href="https://www.buymeacoffee.com/kurto" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-5F7FFF?style=for-the-badge&logo=buymeacoffee&logoColor=FFDD00" alt="Buy me a coffee" />
  </a>
</p>

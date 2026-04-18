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
- **MCP server** — `charter serve` exposes project context to Claude Code.

Compose with the broader [Stackbilt ecosystem](https://github.com/Stackbilt-dev) — [audit-chain](https://github.com/Stackbilt-dev/audit-chain), [worker-observability](https://github.com/Stackbilt-dev/worker-observability), [llm-providers](https://github.com/Stackbilt-dev/llm-providers), [adf](https://www.npmjs.com/package/@stackbilt/adf) — when you need them.

## Install

```bash
npm install --save-dev @stackbilt/cli
```

For pnpm workspaces: `pnpm add -Dw @stackbilt/cli`. For global install: `npm install -g @stackbilt/cli`.

> **WSL2 note:** If your project lives on the Windows filesystem (`/mnt/c/...`), pnpm may fail with `EACCES` permission errors due to WSL2/NTFS cross-filesystem limitations with atomic renames. Use `pnpm add --force` to work around this, or move your project to a Linux-native path (e.g., `~/projects/`) for best performance.

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

### MCP server for Claude Code

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

## Commands

### Govern

```bash
charter                                  # Repo risk/value snapshot
charter bootstrap --ci github            # One-command onboarding
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
charter serve                            # MCP server for Claude Code
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

### Build (deprecated — moving to `@stackbilt/build`)

> These four commands reach external Stackbilt endpoints and are being extracted into a separate `@stackbilt/build` npm package. Governance-only users don't need them. Migration tracked in [RFC #112](https://github.com/Stackbilt-dev/charter/issues/112).

```bash
stackbilt run "description"              # Architect + scaffold in one step
charter architect "description"          # Generate stack selection
charter scaffold --output ./my-project   # Write files from last build
charter login --key sb_live_xxx          # Store API key (deprecated — prefer STACKBILT_API_KEY env var)
```

### Exit codes

- `0`: success
- `1`: policy violation (CI mode)
- `2`: runtime/usage error

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

# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and follows Semantic Versioning.

## [0.3.3] - 2026-02-26

### Added
- **`charter bootstrap` command**: One-command repo onboarding that orchestrates detect → setup → ADF init → install → doctor in a single frictionless flow. Supports `--ci github`, `--preset`, `--skip-install`, `--skip-doctor`, and `--format json` for full machine-readable output including next-step plans.
- **Thin pointer generation**: `charter adf init --emit-pointers` (and bootstrap) generates thin `CLAUDE.md`, `.cursorrules`, and `agents.md` files that redirect to `.ai/` — preventing rule duplication across agent config files.
- **Rule-routing decision tree**: `adf init` scaffold now includes a commented decision tree in `core.adf` guiding agents on where rules belong (CLAUDE.md vs core.adf vs domain modules), derived from ADX-002 agent DX feedback.
- **Section taxonomy documentation**: Generated `core.adf` template documents the open section taxonomy (CONTEXT, CONSTRAINTS, ADVISORY, METRICS), weight tags (`[load-bearing]`, `[advisory]`), and custom section rules.
- **`charter adf sync --explain`**: New flag outputs the `.adf.lock` schema documentation (format, hash algorithm, commands, purpose) in both text and JSON, eliminating lockfile archaeology friction reported in ADX-001.
- **Agent DX feedback papers**: ADX-002 (rule routing friction), ADX-003 (install automation friction), and RM-001 (vNext roadmap draft) added to papers/.
- **GitHub Actions governance workflow**: Bootstrap and setup now generate `.github/workflows/charter-governance.yml` for PR governance checks.

### Changed
- **Scaffold templates shared**: ADF scaffold constants (`MANIFEST_SCAFFOLD`, `CORE_SCAFFOLD`, `STATE_SCAFFOLD`) and pointer templates are now exported from the adf command module and shared with bootstrap, eliminating template drift.
- **Setup functions exported**: `detectStack()`, `loadPackageContexts()`, `detectPackageManager()`, and other setup utilities are now exported for reuse by the bootstrap command.

## [0.3.2] - 2026-02-26

### Added
- **Lockfile types exported**: `AdfLockfile` and `AdfSyncStatus` interfaces now exported from `@stackbilt/adf` public API, giving agents `.d.ts` visibility into the `.adf.lock` schema without reverse-engineering compiled output.
- **Lockfile schema documented**: `.adf.lock` format (flat JSON map of `filename → sha256-prefix-16`) documented in the `@stackbilt/adf` README.
- **`pnpm run dev` watch script**: New `tsc --build --watch` dev script for incremental rebuilds during local development via `tsconfig.build.json`.
- **Research papers directory**: `papers/` with versioned white papers (CSA-001: Context-as-Code v1.1, CSA-002: Greenfield measurement rubric draft) and Architect v2 integration brief.

### Changed
- **Build uses `tsconfig.build.json`**: Root build script replaced hardcoded 9-path `tsc --build` invocation with a `tsconfig.build.json` reference file. TypeScript resolves build order from project references automatically.
- **Publish workflow simplified**: PUBLISHING.md no longer instructs manual `workspace:^` replacement — PNPM handles this at publish time. Publish commands no longer need `--access public` flag.
- **`publishConfig.access: "public"`** declared in all 9 packages (previously only cli and adf).
- **`sideEffects: false`** declared in all 9 packages for bundler tree-shaking.

## [0.3.1] - 2026-02-25

### Added
- **CI evidence gating**: Governance workflow template (`governance.yml`) now runs `charter adf evidence --auto-measure --ci` on PRs when `.ai/manifest.adf` is present, automatically validating metric ceilings before merge.
- **Scorecard evidence**: Charter's own `governance-scorecard.yml` now includes ADF evidence output alongside validate and drift results.

## [0.3.0] - 2026-02-25

### Added
- **Metric content type**: ADF parser now supports `key: value / ceiling [unit]` syntax for numeric metrics with hard ceilings. Metric entries are auto-detected by lowercase key and value/ceiling/unit structure.
- **Weight annotations**: ADF sections can carry `[load-bearing]` or `[advisory]` weight annotations (e.g., `CONSTRAINTS [load-bearing]:`). Weight is preserved through parse/format/patch/merge cycles.
- **`UPDATE_METRIC` patch op**: New patch operation updates a metric entry's value by key while keeping ceiling and unit immutable.
- **Token budgets**: Manifest `BUDGET` section with `MAX_TOKENS` sets a global token budget. `bundleModules()` reports `tokenBudget`, `tokenUtilization`, and `perModuleTokens`.
- **Per-module budgets**: ON_DEMAND entries support `[budget: N]` suffix for module-level token limits. Budget overruns reported in `moduleBudgetOverruns`.
- **`charter adf sync`**: New subcommand with `--check` (verify source `.adf` hashes against `.adf.lock`, exit 1 on drift) and `--write` (update lock file).
- **Cadence scheduling**: Manifest `CADENCE` section declares check frequency expectations (e.g., `LINT_PASS: every commit`). Cadence entries reported in bundle output.
- **Constraint validation**: New `validateConstraints()` API checks all metric entries against their ceilings. Status semantics: `value < ceiling` = pass, `value === ceiling` = warn, `value > ceiling` = fail.
- **`charter adf evidence`**: New subcommand produces structured evidence reports with constraint results, weight summary, sync status, and verdict. Supports `--task`, `--context`, `--context-file`, and `--auto-measure` flags. In `--ci` mode, exits 1 on constraint failures.
- **`computeWeightSummary()`**: Standalone API to count sections by weight category (load-bearing, advisory, unweighted).
- **Scaffold LOC guardrail**: `charter adf init` now scaffolds `core.adf` with a `[load-bearing]` CONSTRAINTS section and a `METRICS [load-bearing]` section containing `entry_loc: 0 / 500 [lines]`.
- **Auto-measurement**: `charter adf evidence --auto-measure` counts lines in files referenced by the manifest `METRICS` section and injects them as context overrides.
- **Manifest METRICS section**: `parseManifest()` now reads a `METRICS` map section mapping metric keys to source file paths for auto-measurement.
- **Advisory-only warnings**: `bundleModules()` flags on-demand modules loaded without any `[load-bearing]` sections. Reported in both bundle and evidence output.
- **`--ops-file` flag**: `charter adf patch` accepts `--ops-file <path>` as an alternative to inline `--ops <json>`.
- **`--context-file` flag**: `charter adf evidence` accepts `--context-file <path>` as an alternative to inline `--context <json>`.
- **Doctor ADF checks**: `charter doctor` now validates ADF readiness: manifest existence, manifest parse, default-load module presence/parseability, and sync lock status.
- **Trigger observability**: `triggerMatches` now includes `matchedKeywords` (which task keywords matched each trigger) and `loadReason` (`'default'` or `'trigger'`). New `unmatchedModules` field lists on-demand modules not resolved for the current task.
- **`nextActions` in JSON output**: `adf init`, `adf evidence`, and `adf sync --check` now include a `nextActions` array in JSON output suggesting logical follow-up commands based on results.
- 178 tests across 12 test files (up from 48 in v0.2.0).

### Changed
- `bundleModules()` now accepts an optional `taskKeywords` parameter for richer trigger reporting.
- ADF format example in root README updated to show metric sections and weight annotations.
- Root, CLI, and ADF package README documentation comprehensively updated for all Phase 1-7 features.
- Help text for `charter adf` updated to list all six subcommands (init, fmt, patch, bundle, sync, evidence).
- Charter's own `.ai/` directory now uses ADF metric ceilings to enforce LOC limits on its own source files (`adf_commands_loc: 835/900`, `bundler_loc: 389/500`, `parser_loc: 214/300`, `cli_entry_loc: 142/200`), validating the full evidence pipeline end-to-end.

## [0.2.0] - 2026-02-24

### Added
- New `@stackbilt/adf` package: AST-backed parser, formatter, patcher, and bundler for the ADF (Attention-Directed Format) standard. Zero runtime dependencies.
- New `charter adf` command namespace with four subcommands:
  - `charter adf init` scaffolds `.ai/` directory with `manifest.adf`, `core.adf`, and `state.adf` modules.
  - `charter adf fmt <file>` parses and reformats ADF files to canonical form (`--check` for CI gating, `--write` for in-place reformat).
  - `charter adf patch <file> --ops <json>` applies typed delta operations (ADD_BULLET, REPLACE_BULLET, REMOVE_BULLET, ADD_SECTION, REPLACE_SECTION, REMOVE_SECTION) for safe agent memory updates.
  - `charter adf bundle --task "<prompt>"` resolves manifest modules via keyword trigger matching and outputs merged context with token estimate.
- ADF parser supports three content types: text (inline values), list (dash-prefixed items), and map (KEY: value pairs for STATE sub-keys).
- ADF formatter auto-injects standard emoji decorations and sorts sections by canonical key order (TASK, ROLE, CONTEXT, OUTPUT, CONSTRAINTS, RULES, DEFAULT_LOAD, ON_DEMAND, FILES, TOOLS, RISKS, STATE).
- ADF patcher is immutable -- original documents are never mutated. Throws `AdfPatchError` with context on invalid operations.
- ADF bundler merges duplicate sections across modules (lists concatenated, texts joined, maps concatenated) and reports trigger match details.
- 48 new tests covering parser, formatter, patcher, and bundler.

### Changed
- All internal `@stackbilt/*` dependency specifiers now use `workspace:^` protocol for consistent monorepo resolution.
- Workspace layout documentation updated across README, CLAUDE.md, AGENTS.md, CONTRIBUTING.md, PUBLISHING.md, and SECURITY.md.
- Package dependency flow now includes: `adf (NEW -- zero deps, self-contained AST) <- cli`.

## [0.1.20] - 2026-02-17

### Added
- New `charter hook install --commit-msg` command to install a commit-msg hook that normalizes `Governed-By` and `Resolves-Request` trailers using `git interpret-trailers`.
- `setup --detect-only` output now includes `agentStandards` and detects repository-level agent governance files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`).
- `drift` and `audit` output now include pattern customization signal (`patternsCustomized`) when metadata is present in pattern files.

### Changed
- Setup-generated GitHub workflow is now pnpm-aware and emits `pnpm/action-setup` + `pnpm install --frozen-lockfile` when pnpm is detected.
- Stack detection now scans monorepo manifests more broadly (`packages/*` and `pnpm-workspace.yaml` paths) and reports `monorepo`/`hasPnpm`.
- `charter classify` is now surfaced earlier in onboarding/setup guidance for LM-agent-first workflows.
- Pattern scaffold output now stores metadata envelope (`customized`, `preset`, `generatedAt`, `patterns`) while remaining backward-compatible in loaders.

### Fixed
- Trailer parsing now follows terminal contiguous git trailer block semantics, matching `git interpret-trailers` behavior.
- `validate` now emits explicit trailer parsing warnings when governance-like lines are present but not parsed as valid trailers.
- Commit parsing in `validate`, `audit`, and quickstart snapshot flow now uses full commit body (`%B`) so trailer/body analysis is accurate.

## [0.1.19] - 2026-02-17

### Added
- `validate` now emits `effectiveRangeSource` and `defaultCommitRange` for explicit default-range traceability.
- `policyOffenders` entries now include `policyReason` while keeping `riskReason` for backward compatibility.

### Changed
- Root and CLI docs now recommend `npx --no-install charter --version` for deterministic post-upgrade version checks.
- Agent docs now clarify strict branching: use `strictTrailerMode.mode` and offender classification fields.

### Fixed
- Reduced semantic ambiguity by making policy-offender reasoning explicitly policy-scoped.

## [0.1.18] - 2026-02-17

### Added
- Setup baseline mutation metadata now includes `configHashBefore`, `configHashAfter`, and `writesPerformed` in `mutationPlan`/`appliedMutations`.
- `validate.strictTrailerMode` now includes explicit `mode` (`STRICT_ONLY`, `RISK_ONLY`, `STRICT_AND_RISK`, `NONE`).

### Changed
- `validate` policy offender payload is now policy-context focused and no longer carries risk-rule metadata by default.
- Setup no longer rewrites `.charter/config.json` on reruns unless an explicit force path is used and content differs.

### Fixed
- Eliminated baseline idempotency false-positive updates caused by unconditional writes during repeated setup runs.

## [0.1.17] - 2026-02-17

### Added
- `validate` JSON now includes `strictTrailerMode` and split evidence arrays: `evidence.policyOffenders` (strict-policy failures) and `evidence.riskOffenders` (threshold-driven risk failures).
- `setup` JSON now includes explicit `mutationPlan` and `appliedMutations` blocks for baseline/workflow/scripts/dependencies.

### Changed
- `setup` now supports `--no-dependency-sync` to skip rewriting `devDependencies["@stackbilt/cli"]`.
- `validate` text output now prints separate policy-vs-risk offender sections to reduce explainability ambiguity.

### Fixed
- Clarified offender semantics so strict no-trailer failures no longer overload threshold-risk offender reporting.

## [0.1.16] - 2026-02-17

### Added
- `validate` now emits commit-level evidence even for zero-trailer failures, including `riskRuleId`, `matchedSignals`, and `thresholdSource`.
- `drift --format json` now includes explicit decision metadata (`status`, `minScore`, `thresholdPercent`, `configPath`).

### Changed
- `setup` now treats multi-runtime detection as mixed stack (`mixedStack: true`) with consistent fullstack recommendation semantics.
- Generated GitHub workflow now runs Charter via repo-local `npx` after dependency install instead of global CLI install.
- `setup` now pins local `@stackbilt/cli` devDependency to the active CLI version for local/CI parity.
- Setup workflow telemetry now distinguishes `created` vs `updated` for truthful idempotency reporting.

### Fixed
- Script synchronization no longer depends on setup path differences when preset inference converges on fullstack.

## [0.1.15] - 2026-02-17

### Added
- `validate` JSON output now includes an evidence block with offending commit details (`sha`, `riskLevel`, `riskReason`, `missingTrailers`).
- `setup --detect-only` now surfaces runtime ambiguity warnings when multiple runtime families are detected without a clear stack split.

### Changed
- `setup` now synchronizes `package.json` onboarding scripts to the selected preset (`charter:setup`) instead of only adding missing entries.

### Fixed
- `audit --range` now fails with a runtime error on invalid git revspecs (matching `validate` semantics) instead of silently returning zero commits.
- `validate` text output now includes offending short SHAs for faster remediation loops.

## [0.1.14] - 2026-02-17

### Added
- Documentation runbook updates for mixed-stack setup decision flow and LM-agent decision rules.
- `setup` now adds optional onboarding scripts to root `package.json` when missing: `charter:detect` and `charter:setup`.
- `validate` and `audit` now include explicit commit range in output for easier score interpretation.

### Changed
- Root and CLI README now lead with detect-first setup (`setup --detect-only`) and explicit CI gating commands (`validate/drift --ci`).
- Publishing guide now verifies `detected.sources` in setup detection output and includes drift/audit checks in post-publish validation.
- Generated GitHub workflow from `setup --ci github` now installs a pinned CLI version for reproducible CI behavior.
- Default baseline config now enforces stricter trailer policy (`validation.citationStrictness: "FAIL"`).

## [0.1.13] - 2026-02-17

### Added
- `setup --detect-only --format json` now includes `detected.sources` listing which `package.json` files were used for detection.

### Changed
- Stack detection now merges dependencies from root and nested manifests (`client/`, `frontend/`, `web/`, `apps/*/`), improving React/Vite signal detection in mixed repos.

## [0.1.12] - 2026-02-17

### Added
- Mixed-stack setup guidance now appears directly in `setup --detect-only` and setup completion output.
- Framework-aware baseline specialization for detected Cloudflare, Hono, and React/Vite signals.

### Changed
- Auto-detection now prioritizes `fullstack` for mixed frontend + backend/worker repositories.
- Setup now uses repo path signals (for example `client/`, `apps/web`) to improve mixed-stack inference.
- Docs now recommend detect-first + explicit fullstack preset for mixed repos.

## [0.1.11] - 2026-02-17

### Added
- `setup` stack auto-detection with preset selection (`worker|frontend|backend|fullstack`) and `--detect-only` preview mode.
- Configurable policy coverage checklist in `.charter/config.json` under `audit.policyCoverage.requiredSections`.

### Changed
- `setup` now scaffolds richer preset-based baseline patterns and infers project name from local `package.json` (fallback: directory name).
- `audit` policy score now uses required section coverage instead of markdown file count.
- Root and CLI docs updated with preset and detection guidance.

### Fixed
- Policy scoring now rewards governance coverage quality over policy-file quantity.

## [0.1.10] - 2026-02-17

### Changed
- Root and CLI README install guidance now leads with local repo install (`npm i -D @stackbilt/cli` + `npx charter`) and keeps global install as optional.
- Audit output now includes explicit scoring formulas and actionable remediation steps for trailer coverage, pattern definitions, and policy docs.

### Fixed
- `charter validate` now returns runtime error (`exit 2`) when git commit loading fails (for example invalid revision/range), instead of incorrectly returning PASS.
- Validation output now distinguishes true "no commits" from internal git failures.

## [0.1.9] - 2026-02-17

### Changed
- Synchronized all published `@stackbilt/*` packages to version `0.1.9` with aligned internal dependency ranges.

## [0.1.8] - 2026-02-17

### Added
- New first-run UX: `charter` now prints a governance value/risk snapshot with a single recommended next action.
- New `charter why` command to explain adoption rationale and expected operational payoff.

### Changed
- `setup` command output rewritten to focus on concrete outcomes (guardrails active, CI policy gate, immediate follow-up commands).
- CLI and root docs updated for human and agent onboarding paths.

## [0.1.6] - 2026-02-17

### Fixed
- Cross-platform git invocation in `validate` and `audit` (removed shell-specific quoting/redirection issues on Windows).
- `charter validate` and `charter audit` no longer emit `%an`/shell noise on Windows.

## [0.1.5] - 2026-02-17

### Fixed
- `charter --version` now reports package version dynamically instead of a hardcoded value.

## [0.1.4] - 2026-02-17

### Fixed
- Replaced published internal dependency references from `workspace:*` to semver ranges so npm consumers can install successfully.
- Published patched internal package dependency chain used by CLI.

## [0.1.0] - 2026-02-16

### Added
- Initial Charter Kit workspace with modular `@stackbilt/*` packages.
- CLI command surface: `init`, `validate`, `drift`, `audit`, `classify`.
- Governance workflow template in `.github/workflows/governance.yml`.

### Changed
- Introduced seamless CLI setup with `setup` and diagnostics via `doctor`.
- Standardized command exit-code contract for human and LM-agent workflows.
- Improved cross-platform build scripts and docs for public contribution.

### Security
- Added repository security policy and reporting process.

[0.3.2]: https://github.com/stackbilt-dev/charter-kit/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/stackbilt-dev/charter-kit/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/stackbilt-dev/charter-kit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/stackbilt-dev/charter-kit/compare/v0.1.20...v0.2.0
[0.1.20]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.20
[0.1.19]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.19
[0.1.18]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.18
[0.1.17]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.17
[0.1.16]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.16
[0.1.15]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.15
[0.1.14]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.14
[0.1.13]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.13
[0.1.12]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.12
[0.1.11]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.11
[0.1.10]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.10
[0.1.9]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.9
[0.1.8]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.8
[0.1.6]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.6
[0.1.5]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.5
[0.1.4]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.4
[0.1.0]: https://github.com/stackbilt-dev/charter-kit/releases/tag/v0.1.0

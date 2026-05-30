# Charter Roadmap: v0.13 → v1.0

> ⚠️ **SUPERSEDED — historical record (archived 2026-05-30).**
> This roadmap is essentially complete and is kept only for provenance.
> The repo shipped **v1.0.0**; 11 of the 12 sequenced issues are closed
> (#164 #163 #161 #160 #159 #162 #123 #122 #140 #155 #139) — only **#116**
> (MCP gateway `charter_brief`) remains open. Parts B/4b deliverables exist
> (`.github/VERSIONING.md`, `.github/workflows/codeql.yml`, `CODE_OF_CONDUCT.md`),
> and Part G Phase 2 has executed (commercial commands `run`/`architect`/
> `scaffold`/`login` removed from `@stackbilt/cli` in #127/#183).
> **For current direction, use the issue board, not this file.**

> **Synthesized from**: full issue triage (19 open issues), OSS hygiene audit (12 packages), and commercial-split impact analysis.  
> **Date**: 2026-05-23  
> **Acceptance criterion**: `charter audit` run on the charter repo itself exits with a passing score — i.e., Charter governs itself.

---

## Thesis

Charter's credibility rests on one thing: **it must govern itself**. The repo currently scores **0/100** on its own audit (`charter score` reports 102 false-positive broken path references; `charter audit` finds 0 patterns, 0 policy docs). Fixing that is not just issue #159 — it's the through-line for all OSS polish work. Every bug fix, hygiene improvement, and CI hardening either directly enables self-governance or removes noise that obscures it.

Once PRs 1–3 land (false positives cleared, stack detection working), run `charter audit` on the charter repo to establish the actual baseline score. Set the v0.13 acceptance threshold from that measurement — not from a guess.

---

## Commercial-Split Posture (No Firm Date — Plan Both Paths)

The four commercial commands (`run`, `architect`, `scaffold`, `login`) and their supporting files (`http-client.ts`, `credentials.ts`, `types/scaffold-contract-types.ts`) will eventually move to `@stackbilt/build` in a new repo. There is no fixed date for this. The key boundary:

- **11 governance packages** (`types`, `core`, `adf`, `git`, `classify`, `validate`, `drift`, `blast`, `surface`, `policies`, `ci`) are split-stable: all OSS polish on them carries forward unchanged.
- **`@stackbilt/cli`**: governance-command sections (audit, drift, doctor, adf, serve, score, blast, surface, context) are split-stable. Commercial-command sections of README and any new tests targeting `run`/`architect`/`scaffold`/`login` logic are throwaway.

**Rule**: Do all pre-split OSS work scoped to governance-only surface. Do not expand test coverage for the four commercial commands — their thin existing coverage (`deprecated-commands.test.ts`) is the correct migration safety net.

---

## Part A — Bug Fixes (PR 1–3, ship before anything else)

These three PRs are blocking: they cause false signal that masks real governance problems.

### PR 1 · Path Resolver — Filter Non-File Strings (`packages/cli/src/commands/score.ts`)

**Closes**: #164 (URL/env-var false positives), #163 (Windows paths + cross-repo refs)

**Root cause**: `looksLikePath()` and `extractPathCandidates()` in `score.ts` (~lines 980–1040) match HTTP routes (`/api/v1/users`), env-var assignments (`DATABASE_URL=http://…`), and Windows absolute paths (`C:\Users\…`) as broken file references.

**Changes**:
- `looksLikePath()`: add exclusion guards — strings starting with `http://`/`https://`, strings matching `[A-Z_]+=[^\s]` (env-var assignment), strings containing `://`, bare HTTP paths starting with `/` followed by two or more path segments with no extension.
- `resolveReferencedPath()` (~lines 1011–1029): replace `startsWith('/')` absolute-path check with `path.isAbsolute()` (handles `C:\` and `/`). Add normalize for Windows drive-letter paths.
- Cross-repo references: when a candidate path contains no local anchor and starts with a known sibling-repo prefix, emit a `[skip:cross-repo]` annotation instead of `[broken]`.
- Add test cases for each false-positive category.

### PR 2 · CLI Version — Read from CLI Package `package.json` (`packages/cli/src/commands/context.ts`)

**Closes**: #161

**Root cause**: `buildContextModel()` in `context.ts` (~lines 470–479) reads version from `path.join(root, 'package.json')`, where `root` is cwd. When `charter context` is run from the charter monorepo root, cwd is the workspace root (`package.json` at v0.10.0), not the CLI package dir.

**Change**: After reading the root `package.json`, if `pkg.name` does not match `@stackbilt/cli`, resolve the CLI package directory from `__dirname` and read `packages/cli/package.json` (or walk `__dirname` upward to the nearest `package.json` with `"name": "@stackbilt/cli"`). Use that version for the brief. This is isolated to the version field — all other context (routes, hotspots, patterns) should still resolve relative to cwd.

### PR 3 · Stack Detection — TypeScript Monorepos (`packages/cli/src/commands/setup.ts`)

**Closes**: #160 (TypeScript monorepo detection), partially unblocks #162 and #159

**Root cause**: `loadPackageContexts()` (~line 645) only checks for `pnpm-workspace.yaml`. The monorepo flag (~line 458) only sets true for pnpm.

**Changes**:
- Parse `tsconfig.json` at root for `"references"` array → TypeScript project-references layout.
- Parse root `package.json` `"workspaces"` field → npm/yarn workspaces.
- Mark `monorepo: true` for any of the three cases.
- `detectStack()` should return `"typescript-monorepo"` preset when `tsconfig.json` + multi-package layout detected.
- Hotspot analysis fallback: when direct file-churn analysis returns empty (no git history for sub-packages), fall back to top-level package directory churn.

---

## Part B — OSS Hygiene (PR 4, all 12 packages, split-safe)

**One PR** touching all 12 `package.json` files. Quick wins with outsized impact on npm discoverability and supply-chain trust.

### PR 4 · Package Metadata Sweep

**Gaps found** (all 12 packages):

| Gap | Impact | Fix |
|-----|--------|-----|
| `keywords` missing on all 12 | npm search invisibility | Add 3–5 per package (e.g. `["governance","charter","typescript","monorepo","cli"]` for cli; package-specific terms for others) |
| `publishConfig.provenance: true` missing on all 12 | attestation doesn't attach to npm metadata | Add `"provenance": true` to existing `publishConfig` block in every package.json |
| Root `package.json` missing `engines` field | no Node version signal at repo level | Add `"engines": { "node": ">=18.0.0" }` to root |
| `author` field missing on 11/12 packages | trust/accountability gap | Add `"author": "Stackbilt LLC"` to all 11 |

**What's already correct** (do not change): `repository.directory` (all correct), `exports` map (proper ESM/CJS), `sideEffects: false`, `engines` per-package, `files` whitelist, `bugs`, `homepage`, `license`, `publishConfig.access: "public"`.

**Also in this PR**:
- Create root `.npmignore` blocking `*.test.ts`, `*.spec.ts`, `__tests__/`, `tsconfig*.json`, `*.tsbuildinfo`, `*.map` as defense-in-depth alongside `files` whitelists.

### PR 4b · GitHub Repo Hygiene (`.github/`)

**Not filed as an issue — OSS hygiene gap**

Current state of `.github/`:
- `ISSUE_TEMPLATE/` (bug_report, feature_request, config) — ✓ present
- `PULL_REQUEST_TEMPLATE.md` — ✓ present
- `dependabot.yml` (npm + github-actions, weekly) — ✓ present
- `CODEOWNERS` — ✓ present but only covers `/.ai/*`; all other paths unowned
- `CODE_OF_CONDUCT.md` — **missing**
- CodeQL / code scanning workflow — **missing**

**Changes**:
1. Add `CODE_OF_CONDUCT.md` at repo root using the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) template. Enforcement contact: `admin@stackbilt.dev` (matches SECURITY.md).
2. Add `.github/workflows/codeql.yml` — CodeQL on push to main, schedule weekly. Target: JavaScript/TypeScript. This enables GitHub's code scanning dashboard and closes a "top notch OSS" signal gap.
3. Expand `CODEOWNERS`: add `* @Stackbilt-dev/charter-maintainers` as a catch-all so all PRs require review, with more specific overrides for `packages/cli/ @Stackbilt-dev/cli-team` etc.

This PR can be bundled with PR 4 (package-metadata-sweep) or shipped independently.

---

## Part C — Test Coverage at Export Boundary (PR 5)

**Closes**: OSS hygiene gap (no issue filed)

The CLAUDE.md policy says "every public export must have test coverage." Four packages currently violate this:

| Package | Untested export | Suggested test location |
|---------|-----------------|------------------------|
| `@stackbilt/ci` | `setOutput`, `setSummary`, `annotateDriftViolations`, `annotateValidationStatus`, `formatPRComment` — all 5 have zero unit tests | `packages/ci/src/__tests__/ci.test.ts` |
| `@stackbilt/classify` | `formatChangeClassification()` | `packages/classify/src/__tests__/format.test.ts` |
| `@stackbilt/validate` | `classifyMessage()` boundary behavior | `packages/validate/src/__tests__/classify.test.ts` |
| `@stackbilt/surface` | `formatSurfaceMarkdown()` | `packages/surface/src/__tests__/format.test.ts` |

---

## Part D — Dogfood: Make Charter Pass Its Own Audit (PR 6)

**Closes**: #159

This is the credibility PR. After PRs 1–3 land (false positives gone, stack detection working), the charter repo should be able to score itself. What's still needed:

1. **`.charter/patterns/`**: Add at minimum one pattern file capturing the governance trailer pattern used in this repo (Conventional Commits + issue references). Use `charter adf populate` output as a starting point, then hand-edit.
2. **Policy documentation**: The audit checks for policy files covering Security, Versioning, and Contributing. The files already exist (`SECURITY.md`, `CONTRIBUTING.md`, `PUBLISHING.md`) but may not match the section headings the audit expects. Align or add a `docs/governance-policy.md` that explicitly covers what the audit scanner expects.
3. **`.charter/config.json`**: Add `policyFiles` array pointing to the existing files, and `patternDir: ".charter/patterns"`.

**Acceptance test**: `charter audit --format text` on the charter repo exits 0 with score > 60/100.

---

## Part E — UX & DX Improvements (PR 7–9, v0.13 target)

### PR 7 · Default `charter` Command — Risk-First View (`packages/cli/src/commands/why.ts`)

**Closes**: #162, partially #139

**Change**: In `quickstartCommand()`, detect whether `.charter/` exists. If yes, skip the adoption pitch and render a "governance posture" view: risk-signal summary (unreviewed high-risk commits, drift violations, coverage %), next recommended action. If no, keep the current adoption pitch. The "Why teams use Charter" block should never appear on an installed repo.

### PR 8 · CI Tag Unification (`.github/workflows/release.yml`)

**Closes**: #123, #122

**Changes**:
- Extract the tag-format regex into a reusable script (`scripts/validate-tag.sh`) shared by both `publish-release` and `publish-npm` jobs.
- Add a `needs: [verify-tag]` edge from `publish-npm` to the tag-verification job so it cannot proceed on a malformed tag.
- Create `.github/VERSIONING.md` documenting the unified-versioning invariant: all workspace packages share a single version; the release tag is the source of truth; if independent versioning is ever adopted, the guard in `release.yml` must be replaced with per-package metadata.
- Annotate the workspace version loop in `release.yml` with a comment pointing to `VERSIONING.md`.

### PR 9 · README Quick-Start Decision Table

**Closes**: #140

One markdown table near the top of `README.md` (after the install command, before the deep reference):

| Situation | Command |
|-----------|---------|
| First time in repo | `charter setup` |
| Daily commit check | `charter audit` |
| See what changed | `charter drift` |
| AI context for current session | `charter context` |
| Full governance posture report | `charter score` |
| Check blast radius of a change | `charter blast <file>` |

Keep the table to 6–8 rows max. Link each command to its anchor in the CLI reference.

---

## Part F — Feature Work (v0.13, lower urgency)

These are non-blocking and can be worked in parallel with Parts A–E or deferred to a dedicated v0.13 sprint.

### `context-refresh` enhancements (#155)
- `charter context-refresh --watch` mode: re-emit brief on file changes using `fs.watch()`.
- `--ttl-minutes N`: emit a refreshed brief every N minutes (for long agent sessions).
- Both are additive; the command already exists.

### MCP gateway brief exposure (#116)
- In `packages/cli/src/commands/serve.ts`, register a `charter_brief` MCP tool/resource.
- Input: optional `repo` path (defaults to cwd).
- Output: the same JSON that `charter context --format json` produces.
- Per-tenant targeting: accept a `tenantId` header and resolve repo path from a config map.

### Bootstrap fragility (#139, partial)
- `charter bootstrap --yes` failing the `install` step in locked environments should not report partial status if setup/adf/doctor all succeeded. Treat `install` as best-effort; report a warning, not a failure.

### Repo intelligence module (#138)
- Optional: `charter gh-intel` (requires `gh` CLI in PATH).
- Pulls: recent PR patterns, open issue count, CODEOWNERS, branch protection rules.
- Appends a `## Repo Intelligence` section to the ADF context bundle.

---

## Part G — v1.0 Commercial Split (when scheduled)

**Do not execute until a firm date is set.** The plan is clear:

1. **Phase 1** (new repo): Stand up `Stackbilt-dev/stackbilt-build`, create `@stackbilt/build` package skeleton, copy `run.ts`, `architect.ts`, `scaffold.ts`, `login.ts`, `http-client.ts`, `credentials.ts`. Port `login.test.ts` and the commercial cases from `deprecated-commands.test.ts`.

2. **Phase 2** (this repo): Remove the four command files from `packages/cli/src/commands/`. Replace their switch-case entries in `src/index.ts` with calls to `deprecation-warning.ts` that point users to `@stackbilt/build`. Remove `auth-wiring.test.ts` commercial cases.

3. **Phase 3** (release.yml): Remove `@stackbilt/cli` from the monorepo publish sweep (or carve it out into a separate job that ships on its own version cadence).

4. **Phase 4** (docs): Rewrite `packages/cli/README.md` commercial-command sections as redirect stubs. Update root `README.md` to reflect the split.

**Pre-split work to defer** (throwaway cost if done now):
- New test coverage for `run`, `architect`, or `scaffold` command logic.
- `@stackbilt/cli` keywords/description framing that emphasizes `run`/`architect`.
- Any CLI README section covering the four commercial commands in depth.

---

## Sequenced PR Order

```
PR 1  path-resolver-fixes          → closes #164, #163
PR 2  cli-version-fix              → closes #161
PR 3  ts-monorepo-stack-detection  → closes #160
  ↓
PR 4  package-metadata-sweep       → OSS hygiene (all 12 packages)
PR 5  export-boundary-tests        → @stackbilt/ci, classify, validate, surface
  ↓
PR 6  dogfood-self-governance      → closes #159  ← credibility gate
  ↓
PR 7  default-command-risk-view    → closes #162
PR 8  ci-tag-unification           → closes #123, #122
PR 9  readme-quickstart-table      → closes #140
  ↓
PR 10 context-refresh-enhancements → closes #155
PR 11 mcp-brief-exposure           → closes #116
PR 12 bootstrap-fragility-fix      → closes #139 (partial)
  ↓
  [v0.13 cut]
  ↓
  [when commercial split date is set → Part G]
```

PRs 1–3 are dependencies for PR 6 (false positives must be gone before self-audit is meaningful). PRs 4–5 are independent and can be batched. PR 6 is the milestone gate — "Charter governs itself" is the v0.13 headline.

---

## Issues Not Covered by This Roadmap

| Issue | Status |
|-------|--------|
| #90 — configurable dependency orchestration | Deferred: requires design review; no clear scope yet |
| #102 — drift code-gen-aware scanning | Deferred to post-v0.13: useful but not blocking |
| #115 — portfolio .charter coverage audit | Deferred: operational task, not a code change |
| #138 — GitHub CLI repo intelligence | Listed in Part F as optional |

---

## Measuring Success

At v0.13 cut, these should all be true:

- [ ] `charter score` on the charter repo exits with < 10 broken references (was 102+)
- [ ] `charter audit` on the charter repo exits with score ≥ baseline+30 (measure baseline after PR 1–3, then set threshold)
- [ ] `charter --version` and `charter context` both report the same version
- [ ] All 12 package.json files have `keywords`, `author`, and `publishConfig.provenance: true`
- [ ] `pnpm test` remains 490+/490 passing
- [ ] `@stackbilt/ci`, `@stackbilt/classify`, `@stackbilt/validate`, `@stackbilt/surface` all have export-boundary unit tests

# CI Integration

Charter integrates with GitHub Actions via a reusable workflow template that runs governance checks and ADF evidence gating on every PR.

## Setup

```bash
charter setup --ci github --yes
```

This writes `.github/workflows/charter-governance.yml` to your repo.

### Re-running setup or bootstrap

Re-running `charter setup --ci github` or `charter bootstrap --ci github` never silently overwrites a workflow you changed, and never silently widens what CI may do ([#374](https://github.com/Stackbilt-dev/charter/issues/374)):

- **Missing:** the workflow is created.
- **Identical to the current template:** left alone.
- **A workflow Charter generated, with the same permissions:** refreshed to the current template. This covers switching between the npm and pnpm forms, and copies that differ only in a BOM, CRLF line endings, trailing whitespace or a pinned `@stackbilt/cli@x.y.z` version (a pin is treated as template text, so a pin you changed by hand is refreshed).
- **An older Charter template whose refresh would widen permissions:** kept, with a warning. Templates before the score-badge steps ran on `pull_request` only with `permissions: contents: read`. The current template has `contents: write`, also runs on `push` to `main`/`master` and on `workflow_dispatch`, and has a step that commits `.charter/badge.json` and runs `git push`. Upgrading therefore grants the workflow's `GITHUB_TOKEN` write access, and on a protected default branch the push step fails unless the token may push. Review that, then run the command again with `--force` to upgrade.
- **Edited by hand:** kept byte for byte, with a warning.

With `--force`, a kept workflow is first copied to `.charter/.backup/github-workflows-charter-governance.yml.<timestamp>` (gitignored), then replaced. The output names the backup and, when it applies, what widened. If the backup fails, the workflow is not replaced and the command exits 1. To replace only the workflow without the rest of `--force`, delete it and re-run.

## What the Workflow Does

On every push and pull request, the CI workflow runs:

1. `charter validate --ci` — checks all commits for governance trailers
2. `charter drift --ci` — scans for blessed-stack deviations
3. `charter adf evidence --auto-measure --ci` — validates metric ceilings (when `.ai/manifest.adf` is present)
4. `charter audit --format json` — captures governance posture snapshot
5. `charter score --badge --write` — refreshes `.charter/badge.json` on pushes to the default branch

If any step exits `1`, the check fails and the merge is blocked.

## Score Badge Refresh

The generated GitHub workflow refreshes `.charter/badge.json` on pushes to `main` or `master`, then commits the file only when the Shields payload changed. Shields renders from the committed JSON at the raw GitHub URL; the workflow is what keeps that JSON current after Charter, ADF, or governance changes land.

Add the badge to your README after the first workflow run has committed `.charter/badge.json`:

```markdown
[![Agent context](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2F<org>%2F<repo>%2F<branch>%2F.charter%2Fbadge.json)](https://github.com/Stackbilt-dev/charter)
```

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

Use `charter hook install --commit-msg` to install a git hook that normalizes trailers at commit time and, when `git.requireTrailers` is on under a blocking policy, rejects a commit missing them before it reaches CI.

## ADF Sync Check

If you use `charter adf sync --check` in CI, it verifies that the `.adf` source files match their locked hashes in `.adf.lock`. This catches unauthorized context modifications — if someone edits an `.adf` file without running `charter adf sync --write`, the check fails.

## Environment Variables

No secrets required for any governance check. The workflow is fully local/static — no external API calls.

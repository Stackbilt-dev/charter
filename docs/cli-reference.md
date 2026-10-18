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

When `git.requireTrailers` is enabled, trailer presence is evaluated per commit.
A trailer on one commit does not satisfy other commits in the selected range.
`validation.citationStrictness` controls whether missing per-commit trailers fail
or warn.

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
npx charter hook install --commit-msg                # trailer gate + normalization hook
npx charter hook install --pre-commit                # vendor tidy + ADF evidence gate hook
npx charter hook install --commit-msg --pre-commit   # both hooks
npx charter hook install --commit-msg --force        # overwrite existing hooks
```

- `--commit-msg` — normalizes `Governed-By` and `Resolves-Request` trailers via `git interpret-trailers`; rejects a message with neither trailer in its final trailer block whenever `charter validate --ci` would fail it, reading `.charter/config.json` with `validate`'s defaults (`requireTrailers` on unless falsy, `citationStrictness` `FAIL`, an unparseable file treated as the defaults). It blocks under `FAIL`/`STRICT` or `ci.failOnWarn` and warns under advisory strictness. No `.charter/config.json` at all, or no `node` on `PATH`, skips the gate with a warning. `#` lines are stripped before the check, as the default editor cleanup does, so under `-m` or `--cleanup=verbatim` a trailer followed by a `#...` line can pass locally and fail CI.
- `--pre-commit` — tidies the staged vendor files, then runs ADF evidence checks (LOC ceiling validation) before each commit. Only gates when `.ai/manifest.adf` exists.
  - Tidy covers only staged vendor files (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`, `agents.md`, `GEMINI.md`, `copilot-instructions.md`), each passed with `adf tidy --source`. A file carrying the compile banner is skipped without calling the CLI.
  - A staged vendor file that also has unstaged changes is skipped, with a message.
  - If tidy would write into a `.ai/` module that has unstaged changes or is untracked, nothing is tidied for that commit, with a message.
  - Only the files tidy wrote that its dry run planned are re-staged, never `.ai/*.adf` as a whole. A gitignored module is written but not staged, and the hook says so. A file the hook cannot stage, or one the real run wrote beyond the plan, is named and left unstaged. Skip tidy with `CHARTER_SKIP_TIDY=1`.
  - The tidy block never fails the commit: a tidy failure prints one line and the hook carries on.
  - The evidence gate after it can. In the generated hook it runs `charter doctor --adf-only --ci --staged --tidy-skipped "<files>"` ([#357](https://github.com/Stackbilt-dev/charter/issues/357)). Vendor bloat blocks the commit only in a staged vendor file that the tidy block did not skip. A staged file that tidy ran on but could not clean still blocks, and so does one left untidied because tidy failed or `CHARTER_SKIP_TIDY=1` is set. Bloat in unstaged vendor files, and in files tidy skipped, shows as an INFO row. A planned-module skip (tidy would write into a module with unstaged or untracked work) skips tidy for every staged vendor file in that commit, so it lifts the bloat gate for all of them. Scoping is by file name: the bloat check still reads each vendor file in the working tree, not its staged content. Every other doctor check blocks as usual. CI's plain `charter doctor --ci` still fails on all vendor bloat. The skip message says how to tidy the file: stage or stash the unstaged work and commit again, or run `charter adf tidy --source <file>` and `git add` the result.
  - The scoped doctor runs in every repo, including one whose custom `verify:adf` leaves doctor out: such a repo now gets `charter doctor --adf-only --ci --staged …` on every commit. Next, if `package.json` has a `verify:adf` script (`charter setup` and `charter bootstrap` add one), the gate runs it; otherwise it runs `charter adf evidence --auto-measure --ci`. `verify:adf` runs with `<pm> run verify:adf`, where `<pm>` is the package manager described in the next item.
  - Every Charter call in the generated hook (tidy, the scoped doctor, `adf evidence`) runs through the repo's package manager ([#366](https://github.com/Stackbilt-dev/charter/issues/366)), picked once at the top of the hook. The hook walks these candidates in order and takes the first one whose marker exists **and** whose binary is on `PATH`:
    1. Yarn Plug'n'Play (`.pnp.cjs` or `.pnp.js` at the repo root, or a `.yarnrc.yml` line `nodeLinker: pnp`, optionally quoted) with `yarn` on `PATH`: Yarn.
    2. `pnpm-lock.yaml` with `pnpm` on `PATH`: pnpm.
    3. `yarn.lock` with `yarn` on `PATH`: Yarn.
    4. Otherwise: npm.

    So a repo with both lockfiles uses pnpm, or Yarn when only Yarn is installed. If the first marker found has no binary on `PATH`, the hook prints a warning on stderr naming the runner it uses instead. Under Plug'n'Play the warning adds `corepack enable`, since PnP packages load only through Yarn. `verify:adf` runs with the same package manager (`<pm> run verify:adf`).
  - Charter then runs as `yarn charter` (`yarn --silent charter` on Yarn 1, so its run banner stays out of the output tidy parses), `pnpm exec charter`, or `npm exec --no -- @stackbilt/cli`. The npm form names Charter's own package, never the bare name `charter`: that is an unrelated registry package, which a plain `npx charter` fetches where Charter is not installed. None of the three installs a package, and the hook never runs a downloaded one. Network use that remains:
    - With `@stackbilt/cli` installed locally, `npm exec` makes no registry request; the hook passes `--no-update-notifier`, so npm's own version check is off too.
    - Without a local install, `npm exec` requests `@stackbilt/cli`'s metadata from the registry. Offline that request fails, after npm's retries (up to about a minute with default settings).
    - Corepack may download Yarn or pnpm itself the first time the hook calls one.
  - **Global installs:** without a local install, `npm exec --no -- @stackbilt/cli` runs a globally installed `@stackbilt/cli` of any version when the registry is reachable. A global 1.x CLI lacks the flags this hook passes (`--staged`, `--print-paths`). Install `@stackbilt/cli` as a devDependency, so the hook runs the version the repo pins.
  - If a gate step fails, the hook prints the command to re-run it. If the CLI itself cannot run (its `--version` fails too), it adds that Charter could not be run with that command and should be added as a devDependency. A doctor that ran and reported problems gets no such line.
  - On Windows the hook runs under Git for Windows' `sh`, which finds `yarn`, `pnpm` and `npm` as an extensionless shim (as npm and corepack install them) or an `.exe`. A package manager present only as a `.cmd` file is not found there, so the cascade skips it. A `package.json` script named `charter` shadows the binary for `yarn charter`.
  - The doctor inside `verify:adf` would check vendor bloat across the whole tree again. To prevent that, the hook sets `CHARTER_HOOK_SCOPED_DOCTOR` to a one-time token for that run and writes the token to its own file in the git directory (`charter-hook-scoped-doctor-<token>`, one per hook run, so overlapping commits in one worktree do not interfere), which it removes on exit. If the file cannot be written, the hook prints one `[pre-commit]` line saying so, and that time the doctor inside `verify:adf` checks every vendor file. When the two match, doctor reports `adf vendor bloat (checked by pre-commit hook)` as INFO and prints a line on stderr. All its other checks still block, and so do the script's other commands. The variable without the matching file does nothing, so `charter doctor --ci` in CI keeps full strictness even if the variable is set there. Run by hand, `npm run verify:adf` checks every vendor file, as CI does.
  - A hook installed before [#320](https://github.com/Stackbilt-dev/charter/issues/320) re-stages all of `.ai/*.adf`. A hook installed before #357 blocks on vendor bloat outside the commit, and so, in a repo with a `verify:adf` script, does one from the first #357 fix, which also ran `pnpm run verify:adf` by name. Re-run `charter hook install --pre-commit` to replace any of them (no `--force` needed for a Charter-managed hook). `charter doctor` reports an old hook as INFO. It reports a hook from the first #357 fix only where `package.json` has a `verify:adf` script, since without one that hook already runs the scoped gate. A hook installed before #366 calls a bare `npx charter`. It fails under Yarn Plug'n'Play unless Charter is installed globally, and where Charter is not installed at all it fetches the unrelated `charter` package. Reinstalling is recommended in every repo and needed under Plug'n'Play, where `charter doctor` reports such a hook as INFO. Elsewhere `npx charter` still finds `node_modules/.bin`, so doctor shows no row for it.
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

- `--ci github` — generate the GitHub Actions governance workflow, `.github/workflows/charter-governance.yml` ([#374](https://github.com/Stackbilt-dev/charter/issues/374)). A missing workflow is created and an identical one is left alone. Without `--force` an existing workflow is refreshed only when it is the current npm or pnpm template (a switch between them is named: `Updated .github/workflows/charter-governance.yml (package manager npm → pnpm; adds pnpm/action-setup@v4)`, `setup.details.workflow.packageManagerChange`). Every older Charter template ran on `pull_request` only with `contents: read`; it is kept with a warning that says what refreshing it changes, `contents: read → write; adds push and workflow_dispatch triggers; adds a step that commits and pushes to the repo` (`setup.details.workflow`: `reason: "would-widen-permissions"`, `changes`; when the upgrade would also switch package manager, the warning and the `Replaced` line add `package manager npm → pnpm (adds pnpm/action-setup@v4)` and JSON adds `packageManagerChange`). A workflow that matches no Charter template is kept with a warning that states what `--force` would install (the current Charter template grants `contents: write` and `pull-requests: write`, runs on `push`, `pull_request` and `workflow_dispatch`, and has a step that commits and pushes to the repo) and asks you to review it (`reason: "hand-edited"`, `templatePermissions`); Charter does not describe what a hand edit changed. A kept workflow is listed in `setup.details.kept`. Templates are compared after normalizing: a leading BOM is dropped, CRLF becomes LF, and trailing whitespace and trailing blank lines are ignored. A pinned `@stackbilt/cli@x.y.z` is normalized too, but the only template that pinned one (04b1442) predates the current permissions, so a pinned workflow is always kept unless `--force`, whatever version it pins. Under `--force` the workflow is first copied to `.charter/.backup/github-workflows-charter-governance.yml.<timestamp>` (gitignored), then replaced: phase 2 prints `Replaced .github/workflows/charter-governance.yml (backup: …; changes: …)` for an older template, or `(backup: …; the current Charter template grants …)` for a hand-edited one (`setup.details.replaced: [{ file, backup, reason, note }]`). If the backup fails it is not replaced: phase 2 prints `Not replaced … (backup failed; see warning)`, the file is listed in `setup.details.notReplaced: [{ file, detail, reason }]`, the setup step fails, JSON `status` is `partial`, the summary reads `Bootstrap finished with failures.`, and bootstrap exits 1. `kept`, `created` and `updated` use the platform path separator, as for `.charter/` files; `replaced`, `notReplaced` and `workflow` use `/`. To replace only the workflow, delete it and re-run. Before this change bootstrap overwrote the workflow whenever it differed.
- `--preset <worker|frontend|backend|fullstack|docs|rust-wasm>` — stack preset
- `--security-sensitive` — generate `SECURITY.md`, seed hard-fail drift denies in `.charter/patterns/security-deny.json`, and warn in `doctor` when no `security*` or `l4*` test file exists
- `--skip-install` — skip dependency installation phase
- `--skip-doctor` — skip health check phase
- `.charter/` — bootstrap creates each missing `.charter/` file (and `SECURITY.md` under `--security-sensitive`) and never overwrites an existing one, whatever `--yes`, `--force` or `--reset-adf` say ([#369](https://github.com/Stackbilt-dev/charter/issues/369)). Phase 2 prints `Created` only for files it wrote and names the ones it kept (`setup.details.kept` in JSON). Use [`charter init --force`](#charter-init) to replace them, with backups.
- `--force` — rewrite Charter thin pointers from the current template and replace `.mcp.json`'s `mcpServers.charter` entry (other keys are kept). An existing, differing entry is replaced only under `--force`, never under `--yes` alone; `.mcp.json` is first copied to `.charter/.backup/mcp.json.<timestamp>` (gitignored), the phase-2 line reads `Updated .mcp.json (backup: …)` (`setup.details.mcpBackup` in JSON), and if the backup fails the entry is left as is with a warning. Adding the entry to an existing `.mcp.json` that has none rewrites the whole file as 2-space-indented JSON; when that would change any byte besides the added entry (key layout, indentation, a missing final newline), `.mcp.json` is backed up the same way first, with or without `--force`, and nothing is written if the backup fails (a warning; bootstrap still exits 0, since nothing was asked to be replaced) ([#374](https://github.com/Stackbilt-dev/charter/issues/374)). Under `--ci github`, `--force` also replaces a hand-edited governance workflow, or an older template whose refresh would widen CI permissions, with a backup (see `--ci`). If a backup `--force` needs fails (the workflow's, or `.mcp.json`'s when replacing `mcpServers.charter`), that file is not replaced, it is listed in `setup.details.notReplaced`, and bootstrap exits 1. For `.ai/*.adf` it **merges** the preset template instead of replacing it ([#354](https://github.com/Stackbilt-dev/charter/issues/354)): a file gains the whole template sections it lacks (for example `RULES`), and `manifest.adf` gains an entry, with the template's triggers, for each preset module it has no entry for. A section the file already has is never edited, so custom triggers, `RULES` lines, `METRICS` ceilings and constraints survive byte for byte, as do line endings and the trailing-newline state. Each edit is re-parsed before it is written; a file that cannot be parsed, or that the edit would change elsewhere, is left as is with a warning naming `--reset-adf`. Each file is reported as `Created`, `Merged … added …` or `Unchanged by merge:` (phase 6 may still fill a section that is exactly the template's text, and says so). `--force` never overwrites a hand-authored vendor file (one with no Charter marker), compiled output (the `adf compile` banner, or a file recorded `compiled`), or a file recorded `unmanaged`: each is skipped with a warning naming the next step. Vendor files are not backed up, so a hand-authored file is left for phase 4 to migrate into `.ai/` (with `--yes`).
- `--reset-adf` — replace each `.ai/*.adf` scaffold file (`manifest.adf`, `core.adf`, `state.adf` and the preset's modules) with the preset template. This is what `--force` did before 2.1. Each file is copied to `.ai/.backup/<name>.<timestamp>` first (a backup never overwrites an earlier one, and a file whose backup fails is not replaced), and `.ai/.backup/.gitignore` (`*`) keeps the backups out of git. Each replaced file is printed as `Replaced .ai/<file> (backup: …)`. After phase 6 a reset report lists, per file, what the backup holds that the file as the run left it does not: lost sections, lost items, changed `METRICS` rows, changed section decorations or weights, changed manifest entries (every `DEFAULT_LOAD`/`ON_DEMAND` section) and `VENDORS` entries not carried over (`adf-init.details.scaffolds[].lost` in JSON). If some backups fail, those files are kept and listed (`N of M file(s) not reset`, `details.notReset`); if all fail, bootstrap exits 1. It needs `--yes`, or a `y` at the interactive prompt that lists the files, unless no existing scaffold file differs from the template (an empty or absent `.ai/`, or one whose files all still match the template): then there is nothing to replace, the run goes ahead without asking, and JSON carries `resetAdf: { kind: "nothing-to-replace" }`. Otherwise (CI, pipes, `--format json`, or an `N`) bootstrap exits 1 and writes nothing to the project (`.ai/`, `.charter/` config, hooks, pointers, `.mcp.json`, `package.json`). The CLI's own gitignored usage log, `.charter/telemetry/events.ndjson`, is still appended, as after every command. It does not imply `--force`: pointers and `.mcp.json` are rewritten only when `--force` is passed too. Valid `VENDORS` entries are carried over to the replaced `manifest.adf`, and modules whose entries the template dropped are re-registered with their file stem as trigger.
- `-y, --yes` — accept all prompts. It does not overwrite anything: before 2.1 it also replaced the `.charter/` templates and `.mcp.json`'s `mcpServers.charter` entry.

**Phase 6 (populate).** Bootstrap fills `CONTEXT` (in `core.adf`, `backend.adf`, `frontend.adf`) only while it is absent, empty, or exactly the template's text, and `STATE` (in `state.adf`) only while it is empty or exactly the template's text (an absent `STATE` is not added), whatever `--yes` or `--force` say; any line of your own leaves it alone. Generated values are cleaned to one line (control characters removed, whitespace collapsed). A file whose edit fails the re-parse check is left as is and listed under `populate.details.refused`. Edits are made in place: only the filled section's lines (or an added `CONSTRAINTS` bullet) change, and line endings are kept. Each change is printed (`Filled CONTEXT in .ai/core.adf`). Before 2.1 it ran `adf populate --force` and replaced hand-written `CONTEXT`/`STATE` on every bootstrap. Run `charter adf populate --force` to overwrite them on purpose.

**Vendor modes.** Phase 3 decides each pointer file from its `VENDORS` entry (see [`charter adf vendor`](#charter-adf-vendor)) and its markers, first match wins: recorded `compiled` or a compile banner on disk → skipped (absent and recorded `compiled` → skipped, run `adf compile --write`); recorded `unmanaged` → left alone; absent → pointer written; no Charter marker → skipped as custom content, with or without `--force`; a Charter pointer → kept, or rewritten under `--force`. Phase 4 migrates only hand-authored files with no `VENDORS` entry; a file recorded `unmanaged` is not migrated, and the warning names `charter adf migrate --source <file>` for doing it anyway.

### charter setup

Bootstraps `.charter/` config and optionally writes CI workflow scaffolding. For full onboarding, prefer `charter bootstrap` which orchestrates setup + ADF init + install + doctor.

```bash
npx charter setup --detect-only --format json
npx charter setup --ci github --yes
npx charter setup --preset fullstack --ci github --yes
npx charter setup --preset rust-wasm --ci github --yes
```

Setup-specific options:

- `--ci github` — generate the GitHub Actions governance workflow, `.github/workflows/charter-governance.yml`, by the same rules as [`bootstrap --ci github`](#charter-bootstrap) ([#374](https://github.com/Stackbilt-dev/charter/issues/374)): a missing workflow is created; the current npm or pnpm template is refreshed (`CI policy gate: updated`, naming a package-manager switch, `workflow.packageManagerChange`); an older Charter template is kept (`CI policy gate: kept (older Charter template; upgrading it changes CI permissions, see warning)`, `workflow.reason: "would-widen-permissions"`, `workflow.changes`); and any other workflow is kept (`CI policy gate: kept (not the Charter template)`, `workflow.reason: "hand-edited"`). Both carry `workflow.kept: true`, `workflow.templatePermissions` and a warning. `--force` backs the workflow up to `.charter/.backup/github-workflows-charter-governance.yml.<timestamp>` before replacing it (`CI policy gate: replaced, backup: …`, `workflow.backup`, and an entry with `reason` in top-level `replaced`); if that backup fails, it prints `CI policy gate: not replaced (backup failed)`, sets `workflow.notReplaced: true`, adds `{ file, detail, reason }` to `notReplaced` and exits 1. The comparison normalizes as bootstrap's does (BOM, CRLF, trailing whitespace and blank lines; a pinned workflow is always kept). Before this change setup never refreshed an existing workflow without `--force`, and `--force` overwrote it with no backup.
- `--preset <worker|frontend|backend|fullstack|docs|rust-wasm>` — stack preset
- `--detect-only` — preview detection results without writing files
- `--no-dependency-sync` — skip rewriting `@stackbilt/cli` devDependency
- `--force` — replace existing `.charter/` templates the way [`charter init --force`](#charter-init) does, backing each up to `.charter/.backup/` first (`replaced` and `notReplaced` in JSON). Without it, setup creates missing `.charter/` files and keeps existing ones. With `--ci github` it also replaces a hand-edited or permission-widening governance workflow, with a backup, and exits 1 if that backup fails (see `--ci`).

### charter init

Scaffolds the `.charter/` config directory without running the full setup workflow.

```bash
npx charter init
npx charter init --preset worker
npx charter init --force                      # replace existing templates (backed up first)
```

- Without `--force` (with or without `--yes`), `init` creates each missing file (`config.json`, `patterns/blessed-stack.json`, `policies/governance.md`, `.gitignore`, and with `--security-sensitive` `patterns/security-deny.json` and `SECURITY.md`) and never overwrites one that exists. A kept `config.json` that lacks newer keys still works: defaults fill them when it is loaded. Before 2.1, `--yes` alone overwrote every template file without a backup ([#369](https://github.com/Stackbilt-dev/charter/issues/369)).
- `--force` — replace each existing file that differs from the template (`patterns/blessed-stack.json` is compared as JSON with its `generatedAt` timestamp ignored, so an untouched copy is neither kept nor replaced; one that does not parse counts as differing). Each one is first copied to `.charter/.backup/<name>.<timestamp>` (`patterns/blessed-stack.json` becomes `patterns-blessed-stack.json.<timestamp>`; a backup never overwrites an earlier one), and `.charter/.backup/.gitignore` (`*`) keeps the backups out of git. A file whose backup fails is not replaced, and if none could be, `init` exits 1. Text output prints `Replaced <file> (backup: <path>)` per file. `--format json` adds `createdFiles`, `kept` (existing files that differ and were left as is), `replaced` (`{ file, backup }`), `notReplaced` (`{ file, detail }`) and, when non-empty, `warnings` (for example a `.backup/.gitignore` that could not be written; that never stops the run). The existing keys keep their meaning: `created` is whether `config.json` was absent, `files` is the full template list, or `[]` when `config.json` existed and `--force` was not passed (as before), and `writesPerformed` counts the files written, which is now non-zero when a missing file is created in an existing `.charter/`. `setup --force` exits 1 in the same case as `init --force`, and `init --guided` warns and exits 1 the same way.
- `--guided` — ask three questions (primary language/framework, Cloudflare Workers, auth governance) and pick the preset from the answers: a Cloudflare `y` gives `worker`, otherwise a recognized language decides, otherwise `--preset <name>` if given, else `fullstack`. `--force` works as above. Answers are read one line each, typed or piped, so `printf 'typescript\ny\ny\n' | charter init --guided` writes the same files as typing those answers. Nothing in the project is written until the last answer has arrived. If stdin closes first (a short pipe, `</dev/null`, or Ctrl-D on an empty line), it prints `Aborted; nothing was written.` on stderr and exits 1; Ctrl-C at the terminal prompt prints the same and exits 130 (on a pipe, Ctrl-C is a process signal the CLI does not handle). Guided mode needs text output and a person: `--format json` exits 1 before asking anything, with one JSON document `{ "error", "errorCode": "GUIDED_REQUIRES_TEXT", "guided": true, "writesPerformed": 0 }` on stdout, and `--ci` exits 1 before asking anything, with a message on stderr (with both flags, the JSON refusal applies). Both name `charter init --preset <...>` as the alternative. In every case the CLI's own usage log, `.charter/telemetry/events.ndjson`, is still appended, as after every command; it is gitignored only once `.charter/.gitignore` exists, so after an aborted run in a fresh directory `.charter/` shows up as untracked. Through 2.1.0, piped stdin stopped partway through the questions and exited 0 with nothing written, even when every answer was piped ([#375](https://github.com/Stackbilt-dev/charter/issues/375)).

This writes `.charter/.gitignore`, which marks the local-only parts of `.charter/` — `.cache/`, `context.md`, and `telemetry/`. Everything else under `.charter/` (config, patterns, policies) is meant to be committed.

#### Upgrading: untracking already-committed telemetry

`.charter/telemetry/events.ndjson` is per-machine usage data. Releases before the `telemetry/` ignore rule did not exclude it, so repos bootstrapped with an older CLI may already have it committed — where it grows with every command and conflicts on every merge between machines.

Adding the ignore rule does **not** untrack a file that is already in the index. `charter init` and `charter bootstrap` keep an existing `.charter/.gitignore` as it is ([#369](https://github.com/Stackbilt-dev/charter/issues/369)), so add the `telemetry/` line by hand, or run `charter init --force` to replace it with the template (the old copy goes to `.charter/.backup/`). Existing repos must also untrack the file once:

```bash
git rm -r --cached .charter/telemetry
git commit -m "chore: stop tracking local charter telemetry"
```

This removes it from version control while leaving it on disk, so `charter telemetry report` keeps working.

### charter doctor

Checks CLI installation and repository config health. Validates ADF readiness: manifest existence, manifest parse, default-load module presence, sync lock status, and agent config file migration status. When trailers are required with `FAIL`/`STRICT` citation validation, doctor also warns unless an active git hook or GitHub Actions workflow invokes `charter validate --ci`. It additionally reports when `<configPath>/telemetry` is tracked in the git index — see [Tracked telemetry](#tracked-telemetry) below.

```bash
npx charter doctor                    # full diagnostics
npx charter doctor --adf-only         # ADF checks only (skip Charter config)
npx charter doctor --ci --format json # CI mode: exit 1 on warnings
```

- `--adf-only` — run only ADF readiness checks, skip Charter config validation
- `--ci` — non-interactive, exits with policy violation code on warnings
- `--staged` — the pre-commit hook's gate ([#357](https://github.com/Stackbilt-dev/charter/issues/357)): the `adf vendor bloat` check counts only vendor files staged in the git index (staged deletions excluded). It selects files by name and still reads their working-tree content, not the staged blob. Bloat in other vendor files moves to an INFO row, `adf vendor bloat (not blocking)`, so it does not fail `--ci`. No other check is scoped. If the index cannot be read, every vendor file counts, as without the flag.
- `--tidy-skipped "<files>"` — with `--staged` only: space-separated vendor files the hook's tidy block skipped. Their bloat goes to the same INFO row. The value may be empty (`""`). Used without `--staged`, it is a usage error (exit 2).
- `CHARTER_HOOK_SCOPED_DOCTOR` (environment) — set only by the generated pre-commit hook while it runs `verify:adf`, after its own `--staged` doctor. Doctor honours it only when its value has the hook's token form (`<pid>-<seconds>`) and the file `charter-hook-scoped-doctor-<token>` in the git directory holds that token. It then reports the `adf vendor bloat` check as INFO (`adf vendor bloat (checked by pre-commit hook)`) and says so on stderr. No other check changes. The variable on its own (no matching file) has no effect, and `--staged` takes precedence over it.

The hook installed by `charter hook install --commit-msg` counts as a local
trailer gate: it rejects a commit with no trailer under a strict policy. A
commit-msg hook installed before the gate existed only normalizes trailers that
are present; doctor names it and asks for a re-install. The local hook checks
only the commit being written, so CI should still run `charter validate --ci`;
the workflow generated by `charter setup --ci github` includes that step.

A `pre-commit hook` INFO row appears when the active hooks directory (honouring
`core.hooksPath`) holds a Charter pre-commit hook generated before staged-only
tidy ([#320](https://github.com/Stackbilt-dev/charter/issues/320)). That hook re-stages
all of `.ai/*.adf`; re-run `charter hook install --pre-commit`. The row also
appears for a hook from before the commit-scoped gate
([#357](https://github.com/Stackbilt-dev/charter/issues/357)), which blocks on vendor
bloat in files the commit does not include. It also appears for a hook from the
first #357 fix when `package.json` has a `verify:adf` script, because that hook's
gate stays unscoped there and runs the script with `pnpm` by name. Without the
script, that hook already runs the scoped gate, so it gets no row. The fix in
each case is the same. A current, foreign
or missing hook adds no row. It is INFO, not WARN, so `--ci` does not fail on upgrade.

#### Vendor file modes

The `adf vendor mode` check compares each vendor file's `VENDORS` entry (see [`charter adf vendor`](#charter-adf-vendor)) with the markers in the file. It runs under `--adf-only`, so the pre-commit hook runs it too. It is one check whose status is its worst row, and `--format json` adds a `rows` array to that check only: `kind`, `status`, `file`, `recordedMode`, `inferredMode`, `source`, `raw`, `remedy`.

| Row | When | Status |
|---|---|---|
| `recorded-ok` | entry matches the file (a recorded `unmanaged` file always matches) | PASS |
| `recorded-unmanaged-absent` | recorded `unmanaged`, no file | PASS |
| `inferred` | file with no entry; one line for all of them, naming `charter adf vendor init` | INFO |
| `recorded-drift` | recorded `pointer` or `compiled`, but the file looks like another mode. The content-preserving fix (`adf vendor set <file> <mode>`) is named first; for a recorded `compiled` file the regenerate command says what it would discard | WARN |
| `recorded-absent` | recorded `pointer` or `compiled`, no file. Recreate with `adf vendor restore <file>` or `adf compile --target <t> --write` | WARN |
| `entry-problem` | a malformed, unknown-file or not-allowed entry (WARN); a duplicate entry, which names the ignored line to delete because a later entry wins (INFO) | WARN / INFO |
| `alias-recorded` | both `AGENTS.md` and `agents.md` recorded for one file | INFO |
| `legacy-spelling` | the file `AGENTS.md` recorded under the legacy name `agents.md`. Names `charter adf vendor rename-legacy` | INFO |
| `legacy-tracked` | git tracks `agents.md` under its pre-#297 lowercase name, and not `AGENTS.md`. Names `charter adf vendor rename-legacy` | INFO |
| `legacy-both-distinct` | git tracks both `agents.md` and `AGENTS.md`, and they are two different files. Move what you need into `AGENTS.md`, then `git rm agents.md` | INFO |
| `legacy-both-one-file` | git has both index entries for one file (a case-insensitive checkout). Drop the stale entry: `git rm --cached agents.md` | INFO |
| `section-not-list` | `VENDORS` does not read as a list | WARN |

The three `legacy-*` index rows read only the git index (`git ls-files -- agents.md AGENTS.md`, then an exact-case filter, with any `GIT_*_PATHSPECS` variables removed from git's environment), so they are the same on case-sensitive and case-insensitive checkouts. An untracked `agents.md`, or a directory outside git, gives no row. They are INFO because Charter's own pre-#297 bootstrap created this state, so they never fail `doctor --ci`.

A repo without a `VENDORS` section gets only the `inferred` INFO line, so upgrading never fails `doctor --ci`. A WARN appears only where an explicit record is contradicted or ignored. Doctor never writes the record or a vendor file.

The `adf agent config`, `adf vendor bloat` and `adf cold start` checks read the record too. Each physical file is checked once (`AGENTS.md` and `agents.md` on a case-insensitive filesystem are one file). A hand-authored file recorded `unmanaged` no longer warns that it "contains stack rules", and the PASS line counts thin pointers and compiled files separately. Bloat and cold start look only at pointers: a file in pointer mode that looks like a pointer on disk.

#### Tracked telemetry

Charter appends to `<configPath>/telemetry/events.ndjson` on every run. In a
repo bootstrapped before that path was added to the generated
`<configPath>/.gitignore`, nothing stopped the log from being staged, so it may
already be tracked — and once it is, every `git add -A` stages it again, because
an ignore entry alone never untracks a file already in the index.

`doctor` reads the git index for `<configPath>/telemetry` and, when anything
there is tracked, names the files and the two-step remedy: ensure `telemetry/`
is ignored, *then* `git rm -r --cached "<configPath>/telemetry"`. In that order,
because after the untrack the file is still on disk and a reflexive `git add -A`
would otherwise re-stage it. The log is never deleted, so `charter telemetry
report` keeps working.

This is advisory (`INFO`) and never fails CI — the condition is state Charter's
own bootstrap created, not something you opted into, so it cannot break an
existing repo's build on upgrade. The check reads only the git index (never the
filesystem), so it behaves identically on case-sensitive and case-insensitive
checkouts, and it is skipped under `--adf-only` and outside a git repository.

#### Source LOC budgets (god-object drift)

The ADF `entry_loc` metric only caps the single entry file. To stop *other*
runtime source files from quietly growing into god-objects, declare per-path LOC
budgets in `.charter/config.json`. `charter doctor` then measures matching files
and reports them:

```jsonc
{
  "locBudgets": {
    "defaultWarn": 300,
    "defaultFail": 600,
    "paths": [
      { "pattern": "src/index.ts", "warn": 200, "fail": 500, "reason": "entry should stay thin" },
      { "pattern": "src/**", "warn": 300, "fail": 600 }
    ]
  }
}
```

- **Patterns** match repo-relative paths: `*` within a single path segment, `**`
  across segments, everything else literal. The first matching rule wins, so list
  more specific patterns first. Per-rule `warn`/`fail` fall back to
  `defaultWarn`/`defaultFail`.
- **Enforcement is opt-in and graduated.** A file *over its `fail` ceiling* is a
  `WARN` doctor check — under `--ci` this exits non-zero, failing the build. A
  file *over `warn` but within `fail`* is advisory (`INFO`) and never fails CI.
  Set `"enabled": false` to keep a config block without enforcing it.
- **No budgets configured?** `doctor` emits a soft, non-blocking `INFO` nudge so
  teams know `entry_loc` alone leaves other files uncovered — it never fails an
  existing repo's CI on upgrade.

### charter why

Prints a quick explanation of Charter's governance value and adoption ROI.

```bash
npx charter why
```

### charter score

Deterministic local AI-readiness audit. Grades the repo across agent config, grounding,
architecture, testing, governance and freshness, and prints a letter grade out of 100. No network
calls and no model inference — the same repo scores the same every run.

```bash
npx charter score                     # full report
npx charter score --format json       # machine-readable
npx charter score --ci                # exit 1 when the score is below 60
npx charter score --badge             # shields.io endpoint JSON on stdout
npx charter score --badge --write     # also write .charter/badge.json
```

- `--ai-dir <dir>` — override the ADF directory (default: `.ai`)
- `--ci` — exit 1 when the score is below 60
- `--badge` — print shields.io endpoint JSON instead of the full report
- `--badge --write` — additionally write the badge JSON to `.charter/badge.json`

**Agent config and vendor modes.** `CLAUDE.md`, `.cursorrules` and `AGENTS.md` (or `agents.md`) score higher when they are substantive. A hand-authored or compiled file is judged on its own text. A thin pointer is as substantive as the compiled file it routes to: score compiles that target from `.ai/` in memory (nothing is written) and counts the pointer as substantive when either its text or that output is. Scores can therefore only rise compared with earlier versions. `--format json` adds `mode`, `source` and `substantiveVia` (`file`, `ai-dir` or `none`) to each of these files under `signals.agentConfig`. Recommendations never tell you to hand-edit a pointer or a compiled `CLAUDE.md`; when one has little to route to, the recommendation is to add content to `<ai-dir>/core.adf` or run `charter adf populate`. The `VENDORS` section is ignored when checking manifest path references.

**Grounding and path references.** The grounding dimension counts how many file paths referenced
in your docs actually resolve. A reference that does not exist at its literal path is retried by
filename: if exactly one file in the repository has that basename *and* the referenced path's
trailing segments match that file's, it counts as resolved. This is what stops a fenced directory
tree — where the prefix is carried by indentation rather than written out — from scoring as dozens
of broken references. Ambiguous basenames, and paths whose directories disagree with the match,
stay broken, so a genuinely stale reference is still reported ([#293](https://github.com/Stackbilt-dev/charter/issues/293)).

The file inventory comes from `git ls-files --cached --others --exclude-standard` where available,
so dependencies and build output cannot resolve a reference.

### charter telemetry

Reports local command telemetry. Reads `<configPath>/telemetry/events.ndjson`, which Charter
appends to on every run. **Command metadata only** — no prompt text and no code content.

```bash
npx charter telemetry report                  # default: last 7d
npx charter telemetry report --period 24h     # 30m | 24h | 7d
```

The log is local and is not uploaded anywhere. It should not be committed: `charter doctor`
reports when it is tracked in the git index and names the fix — see
[Tracked telemetry](#tracked-telemetry).

### charter stamp-policies

Stamps the policy-repo reference into the repo's governance config so policy citations resolve to
a pinned commit rather than a moving branch.

```bash
npx charter stamp-policies                              # resolve the ref automatically
npx charter stamp-policies --dry-run                    # preview without writing
npx charter stamp-policies --policy-repo-ref <sha>      # pin explicitly
npx charter stamp-policies --no-fix-pins                # stamp without rewriting existing pins
npx charter stamp-policies --path <dir>                 # target another checkout
```

- `--policy-repo-ref <sha>` — explicit ref; otherwise `CHARTER_POLICY_REPO_REF` is used, and
  failing that the ref is resolved automatically
- `--dry-run` — report what would change without writing
- `--no-fix-pins` — leave existing pins untouched
- `--path <dir>` — operate on a different repository (default: `.`)

## ADF Commands

ADF (Attention-Directed Format) is Charter's modular AI context compiler. These commands manage the `.ai/` directory.

### charter adf init

Scaffolds `.ai/` directory with preset-aware modules. The scaffolded `core.adf` includes a `[load-bearing]` CONSTRAINTS section and a `METRICS [load-bearing]` section with starter LOC ceilings.

```bash
npx charter adf init
npx charter adf init --ai-dir ./context       # custom directory
npx charter adf init --force                  # merge the template into existing files
npx charter adf init --reset-adf --yes        # replace existing files (backed up first)
npx charter adf init --emit-pointers          # generate thin pointer files
npx charter adf init --module testing         # add a single module to existing .ai/
```

- `--ai-dir <dir>` — custom directory path (default: `.ai`). Resolved to an absolute path at runtime.
- Without `--force` or `--reset-adf`, an existing `manifest.adf` makes `adf init` a no-op. When `manifest.adf` is missing, it is written and existing `.adf` files are skipped and reported.
- `--force` — **merge** the preset template into existing files, exactly as [`bootstrap --force`](#charter-bootstrap) does ([#370](https://github.com/Stackbilt-dev/charter/issues/370)): missing scaffold files are created, a file gains the whole template sections it lacks (`manifest.adf` never gains `DEFAULT_LOAD`, `ON_DEMAND` or `VENDORS` sections as text), and `manifest.adf` gains an entry, with the template's triggers, for each preset module it has no entry for. A section the file already has is never edited, line endings are kept, and a second run changes nothing. A file the re-parse guard refuses is left as is with a warning naming `charter adf init --reset-adf --yes`. An existing `.adf.lock` is kept. Before 2.1, `--force` replaced every file with the template, without a backup.
- `--reset-adf` — replace each scaffold file that differs from the template. It needs `--yes` or a `y` at the interactive prompt, unless nothing differs (an empty or absent `.ai/`, or one whose files all still match the template), in which case it just creates the files as plain `adf init` does, as `bootstrap --reset-adf` does too; otherwise (CI, pipes, `--format json`, or an `N`) `adf init` exits 1 and writes nothing. Each file is copied to `.ai/.backup/<name>.<timestamp>` first (gitignored by `.ai/.backup/.gitignore`); a file whose backup fails is not replaced, and if none could be, `adf init` exits 1. Each replaced file is printed as `Replaced .ai/<file> (backup: …)` followed by what it lost (sections, items, `METRICS` rows, manifest entries). Valid `VENDORS` entries are carried over.
- `--format json` with `--force` or `--reset-adf` adds `mode`, `scaffolds` (one outcome per file, with the loss report), `replaced` (`{ file, backup }`) and `warnings`, plus `notReset`, `backupGitignore` and `resetAdf` under `--reset-adf`. `created` is `true` only when `manifest.adf` did not exist, and `files` lists only files this run wrote. A run that only creates files (an empty `.ai/`) prints exactly what plain `adf init` prints, text and JSON (`nextActions` included), under `--force` and `--reset-adf --yes` alike. With `--emit-pointers`, the pointer lines follow the merge or reset report.
- `--emit-pointers` — generate thin pointer files (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`). The generated `CLAUDE.md` includes a `## Session Start` section with guidance to call the `charter_context` MCP tool at session start, giving agents the live constraint surface before any other action.
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

**Rust/WASM preset** (`--preset rust-wasm`):

| File | Purpose |
|------|---------|
| `manifest.adf` | Rust/WASM-specific module routing (triggers: Cargo, WASM, wasm-pack, wasm-bindgen, cdylib, wasm32) |
| `core.adf` | Universal constraints and metrics |
| `state.adf` | Current session state |
| `rust-wasm.adf` | Library constraints: pure exports, dual crate-type, wasm-pack build/test gates, pkg/ publish boundary |

`charter bootstrap --preset rust-wasm` also scaffolds: `Cargo.toml` (cdylib + rlib), `src/lib.rs`, `tests/integration.rs`, root `package.json` (private, wasm-pack scripts), `.gitignore` (excludes `pkg/`, `target/`), and `.github/workflows/ci.yml` (Rust toolchain + wasm32 target + wasm-pack test + wasm-pack build steps).

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

Scans existing agent config files (`CLAUDE.md`, `.cursorrules`, `AGENTS.md` or legacy `agents.md`, `GEMINI.md`, `copilot-instructions.md`), classifies their content, and migrates structured blocks into ADF modules. Replaces originals with thin pointers.

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

Without `--source`, a file recorded `unmanaged` in `VENDORS` is skipped with a note. Naming it with `--source` migrates it and changes its entry to `pointer` before the pointer is written; if the migration then fails, the entry goes back to `unmanaged`.

Every module that receives content is registered in `manifest.adf`, after the module merge and before the pointer is written, so the `CLAUDE.md` module index lists it. `core.adf` and `state.adf` go to `DEFAULT_LOAD`. Other modules go to `ON_DEMAND`, with up to 6 triggers inferred from the headings routed there. The heading word the router matched (e.g. `deployment`) counts double, and words that already trigger another module are left out. When nothing usable is left, the module's lowercase file stem is the trigger. Registration is append-only: an existing entry is never rewritten or moved, and its triggers are never merged. New bullets are inserted as text after the section's last item. Every other byte of the manifest is left as it was, including comments, section order and line endings. Already-registered modules are reported with their existing section and triggers. When `core.adf` is listed under `ON_DEMAND`, migrate warns instead of moving it. When `manifest.adf` is missing, registration is skipped with a warning to run `charter adf init`. The plan shows one `REGISTER` line per module, for example `REGISTER .ai/manifest.adf  (infra.adf → ON_DEMAND: deployment, docker [planned])`, and `--format json` adds `sources[].registrations[]` with `module`, `loadPolicy`, `triggers`, `triggerSources`, `reason`, `status` (`planned`, `added`, `already-registered` or `skipped`) and, when skipped, `skipReason`. A `--dry-run` across several sources reports each module once. It does not simulate an earlier source's new triggers when routing a later source, though a real run does.

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

Sync tracks only manifest `SYNC` sources. With none declared, it says so and points to `charter adf vendor status` (also in JSON `nextActions`), since a stale `adf compile --check` is about vendor modes, not SYNC.

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

### charter adf compile

Outbound compiler: renders the `.ai/*.adf` source tree into flat vendor agent-config files. The inverse of `charter adf migrate` and `charter adf tidy`, which fold vendor content back into `.ai/`.

```bash
npx charter adf compile --target claude                 # print to stdout
npx charter adf compile --target all --write            # re-render targets in compiled mode (or absent)
npx charter adf compile --target all --write --mode compiled # also switch pointer/unmanaged files to compiled
npx charter adf compile --target all --check            # CI drift gate, by each file's mode
npx charter adf compile --target claude --write --force # overwrite hand-authored content (never changes mode)
```

- `--target <claude|agents|cursor|gemini|all>` — vendor target: `claude`→`CLAUDE.md`, `agents`→`AGENTS.md`, `cursor`→`.cursorrules`, `gemini`→`GEMINI.md`. `all` requires `--write` or `--check`.
- `--write` — write output to the repo root for each target in compiled mode or absent, subject to the overwrite guard below
- `--mode compiled` — with `--write`, also convert targets in `pointer` or `unmanaged` mode. The `VENDORS` record is set to `compiled` before the file is written; if it cannot be recorded, nothing is written (`refused-record`, exit 1). If the file write itself fails, that target's record is restored, the target is reported as `refused-record` with `writeError`, and the remaining targets are still processed (exit 1). `compiled` is the only accepted value: to make a file a pointer, run `charter adf vendor set <file> pointer`. `--mode` without `--write`, or another value, exits 2.
- `--check` — verify each target by its mode; exit 1 on drift (see below)
- `--force` — with `--write`, bypass the overwrite guard. It never changes a file's mode: a pointer or unmanaged target still needs `--mode compiled`.
- `--ai-dir <dir>` — custom `.ai/` directory (default: `.ai`)

Default with no `--write` or `--check` prints to stdout, single target only.

**Modes.** Each target's mode comes from the `VENDORS` record in `manifest.adf` (see [`charter adf vendor`](#charter-adf-vendor)). A file with no entry is classified by its markers: the compile banner means `compiled`, a pointer marker means `pointer`, anything else is `unmanaged`. A missing file with no entry is compiled as before.

`--write` per target:

| Mode | `--target all` | single `--target` | with `--mode compiled` |
|---|---|---|---|
| compiled, or absent and unrecorded | written | written | written |
| pointer | skipped (its `[skip]` line names the command), exit 0 | refused, exit 1 | record set to compiled, then written as `Written CLAUDE.md (mode: pointer -> compiled)` |
| unmanaged | skipped, exit 0 | refused, exit 1 | as pointer, but an existing hand-authored file also needs `--force` |

**Legacy `agents.md` key.** When `AGENTS.md` is recorded under the legacy name `agents.md` (one physical file on a case-insensitive filesystem), `--target agents|all --write --mode compiled` refuses that target as `refused-legacy-spelling` (exit 1): nothing is rendered and the record is not touched, because the git path is still lowercase. Its remedy is `charter adf vendor rename-legacy && charter adf compile --target agents --write --mode compiled`. Without `--mode`, the target is skipped or refused as before, and its remedy is that same rename-first command.

When every target is skipped, compile says that nothing was written and how to switch. JSON output keeps `written`, `refused` and `nextActions`, and adds `skipped` and `targets` (one row per target: `state`, `source`, `status`, `recordedMode`, `previousMode`, `remedy`, `writeError`, `retainedSections`, `retainedSource`, `retainedSkipped`, `retainedAmbiguous`). `previousMode` (`pointer` or `unmanaged`) is how a JSON consumer tells a conversion from a re-compile.

**Retained sections.** Compiled output keeps your own `## Environment` section and the other sections `adf tidy` retains (`## Session ...` other than `## Session Start`, and headings containing Protocol, Receipt, Provenance or Registration). They live in a block at the very end of the file, after the module index:

```markdown
<!-- charter:retained:start -->
<!-- Kept verbatim by charter adf compile. Edit freely between the retained markers. -->

## Environment
- Use WSL for builds
<!-- charter:retained:end -->
```

`--write` carries them from wherever they are:

- An existing block is copied as it stands, so an edit inside it survives every re-compile, and a section you delete from it stays deleted. Delete the whole block (both markers) to stop carrying anything.
- A compiled file with retained sections outside the block (for example a hand-added `## Environment`) gets them moved into the block. An all-caps heading the compiler could have produced (`## PROTOCOL`, a section since removed from `.ai/`) is never carried, and neither is `## Module Index`.
- A pointer converted with `--mode compiled` carries the retained sections that differ from its template.
- A hand-authored file converted with `--mode compiled --force` carries its retained sections; the rest is discarded.

A file with nothing to carry gets no block, so its output is byte-identical to the plain render. The block uses the HTML markers in every target, `.cursorrules` included. Sections keep their source order, and the output is LF. A carried section whose heading matches a compiled one (say `## CONTEXT`) is kept, with a warning on stderr. The written line names what was kept: `Written CLAUDE.md (kept ## Environment)`. `adf compile` without `--write` prints the plain render, with no block. `adf tidy`, `doctor` and `adf migrate` ignore the block, because it is a Charter sentinel.

A retained-looking section can really be rendered `.ai/` text: a `## Session notes` or `## Environment` line inside a `.ai/` text value, left in the compiled file after you edited or removed that value. Compile handles such sections as follows:

- If its heading appears in a current `.ai/` module, it is compiler output. It is not carried. Compile prints `<file>: <heading> was not carried: it looks like compiler output from .ai/. If it is yours, move it into the retained block.` and lists it in the row's `retainedSkipped`.
- If it sits inside a generated section's span (from a `## KEY` heading to the next generated heading or the module index) that no longer matches the current render, and no `.ai/` module holds its heading, it could be stale output or your own text. `--write` will not drop it. That target is refused as `refused-ambiguous` (exit 1, nothing written, `VENDORS` unchanged), named in `retainedAmbiguous`. The first remedy keeps it: wrap it in place between `<!-- charter:retained:start -->` and `<!-- charter:retained:end -->` (the two lines are printed), then re-run `--write`. The second, `--write --force`, discards it and lists it in `retainedSkipped`. `--check` reads such a file as `stale` with `staleReason: "retained-ambiguous"` and gives the same two remedies.
- A section appended after the last rendered section is still carried when that section matches the current render.

Parsing follows Markdown. A `## ` line, a module index fence or a retained marker inside a ```` ``` ```` or `~~~` code fence is text, and an indented `    ## x` is code, not a heading. Marker lines match with the same loose whitespace that `stripCharterSentinels` accepts (`<!--charter:retained:start-->` works). A marker line that the render itself contains, quoted in a `.ai/` text value, never starts the block.

Converting a pointer refuses (exit 1, nothing written, `VENDORS` unchanged) when content the output would not carry would be lost. This also applies to a file recorded `compiled` that still looks like a pointer, under plain `--write`:

- `refused-bloated`: the pointer carries items `adf tidy` would extract. The first remedy is `charter adf tidy --source <file>` (moves them into `.ai/`, then re-run). The second is `--mode compiled --force`, which discards N item(s).
- `refused-would-drop`: other lines of yours (an extra note, an edited title, edited `## Session Start` text) would be lost. Charter pointer-template lines and the module index do not count. Move them under `## Environment` or into a `.ai/` module, or pass `--force`, which discards N line(s).

`--force` skips these refusals but never drops retained sections. `refused-retained` is retired: a pointer with notes under a retained heading is now written, with the notes carried.

Limitations:
- Outside the block, only retained-heading sections are kept. A non-retained section after the block, or the non-retained content of a second `charter:retained` block, is dropped, as before.
- Edits to a compiled file's own `## Session Start`, `## Module Index` or preamble are not kept. The banner says DO NOT EDIT, and that is by design.
- `--check` still compares bytes, so a CRLF checkout of a compiled file reads stale.

`--check` per target:

| Status | When | Exit |
|---|---|---|
| `fresh` / `stale` | compiled: the file equals / differs from what `--write` would write, which is the render plus the file's own retained block (remedy: `compile --target <t> --write`). `staleReason` is `retained-ambiguous` when a legacy section may be stale `.ai/` output or yours (see retained sections), `retained-unfenced` when retained sections sit outside the block (the remedy keeps them), else `content` | 0 / 1 |
| `missing` | no file on disk (a recorded pointer suggests `adf vendor restore <file>` or `adf vendor set <file> unmanaged`) | 1 |
| `pointer-ok` | pointer with nothing `adf tidy` would extract | 0 |
| `pointer-bloated` | pointer carrying content that belongs in `.ai/` (remedy: `adf tidy --source <file>`) | 1 |
| `mode-drift` | recorded `compiled` or `pointer`, but the file looks like another mode. Both fixes are printed, the content-preserving one first; regenerating says how many items it would discard | 1 |
| `skipped-unmanaged` | unmanaged: not checked | 0 |

No `--check` remedy suggests `compile --write` for a pointer or unmanaged file. An edit inside the retained block never makes a file stale. A compiled file with a hand-added `## Environment` outside the block reads `stale` (`retained-unfenced`) until one `--write` moves it into the block. The comparison is still byte for byte, so a CRLF checkout of a compiled file reads stale. JSON output keeps `stale` (stale, bloated and drifted files), `current`, `missing`, `upToDate` and `nextActions`, and adds `skipped` and `targets` (each row has `staleReason`, null unless stale).

**Overwrite guard.** With `--write` and no `--force`, compile writes an existing file only when it recognises it as Charter-owned — either compiler output (carrying the compile banner) or a Charter thin pointer. A hand-authored file with no Charter marker is refused (`refused-hand-authored`). A pointer is refused only over content the output would not carry (`refused-bloated`, `refused-would-drop`; see retained sections above).

These refusals happen before the record is touched, so a refused target never changes `VENDORS`.

### charter adf tidy

Scans vendor config files for content added beyond the thin pointer, classifies it, routes it into ADF modules, and restores the pointer. Runs automatically in the generated pre-commit hook.

```bash
npx charter adf tidy                        # classify and route, restore pointers
npx charter adf tidy --dry-run              # preview without modifying files
npx charter adf tidy --dry-run --ci         # exit 1 if bloat found (pre-commit gating)
npx charter adf tidy --source CLAUDE.md     # single file
npx charter adf tidy --source CLAUDE.md --source GEMINI.md --dry-run --print-paths   # what the hook runs
```

- `--dry-run` — preview without modifying files
- `--ci` — exit 1 if bloat is found; combine with `--dry-run` for gating
- `--source <file>` — tidy this file instead of scanning all vendor configs. Repeat it to tidy several files, in argument order. Two names for one file (`AGENTS.md` and `agents.md` on a case-insensitive filesystem, or a hard link) are tidied once. A `--source` with no value is a usage error (exit 2).
- `--print-paths` — print one line per file tidy writes (or would write, under `--dry-run`): `vendor <path>` lines, then `module <path>` lines, repo-relative with `/`. Nothing else goes to stdout; warnings go to stderr. No lines means tidy writes nothing. Cannot be combined with `--format json` (exit 2).
- `--ai-dir <dir>` — custom `.ai/` directory (default: `.ai`)

Retained headings (`## Environment`, `## Module Index`, `## Session*`, and operational protocol headings) are kept in the vendor file verbatim rather than routed into `.ai/`.

Tidy reads each vendor file's mode from the `VENDORS` record and processes only pointers. Compiler output is skipped. A file carrying the `GENERATED by charter adf compile` banner is not a thin pointer — it is the full ruleset rendered *from* `.ai/` — so tidy reports it and leaves it alone rather than folding `.ai/` back into itself ([#296](https://github.com/Stackbilt-dev/charter/issues/296)). Edit the `.ai/` modules and re-run `charter adf compile --write` instead. The banner wins whatever the record says. A file recorded `compiled` without a banner is also skipped (status `compiled`); its warning names the content-preserving fix first (`adf vendor set <file> pointer`, then `adf tidy --source <file>`) and says how many items regenerating would discard, and an `unmanaged` file (recorded, or hand-authored with no Charter marker; it used to report `not-found`) gets status `unmanaged`. A file recorded `pointer` that has no pointer marker is skipped rather than guessed at. JSON rows add `vendorFile`, `mode`, `source` and `skipReason`, and the JSON result adds `paths` (`vendor`, `modules`), the files `--print-paths` lists. A `--source` path that is not a repo-root vendor name keeps the marker logic. `AGENTS.md` and `agents.md` that are one file on disk are tidied once. Tidy never writes the record.

### charter adf populate

Auto-fills ADF files from codebase signals — `package.json`, README, and stack detection. Populates `CONTEXT` in `core.adf`, `backend.adf` and `frontend.adf`, and `STATE` in `state.adf`.

```bash
npx charter adf populate --dry-run   # preview
npx charter adf populate             # fill empty sections
npx charter adf populate --force     # overwrite existing custom content
```

- `--dry-run` — preview without writing
- `--force` — overwrite sections that already hold custom content
- `--ai-dir <dir>` — custom `.ai/` directory (default: `.ai`)

Without `--force` (or `--yes`), `CONTEXT` is filled only while it is absent, empty, or exactly the template's text, and `STATE` only while it is empty or exactly the template's text (an absent `STATE` is not added); one line of your own leaves it alone. Edits are in place: only the filled section's lines, or an added `CONSTRAINTS` bullet, change, and line endings and the rest of the file are kept byte for byte. A file the edit cannot be applied to cleanly (re-parse check) is reported with `status: "refused"` and a reason naming the section that would not re-parse.

### charter adf context

Resolves which ADF modules apply to a set of file paths and/or explicit keywords, deriving keywords from file extensions and directory names (for example `src/components/*.tsx` → `react`, `ui`, `frontend`).

```bash
npx charter adf context --files "src/api/routes.ts,src/db/schema.sql"
npx charter adf context --keywords "auth,migration"
npx charter adf context --files "src/ui/Button.tsx" --bundle
```

- `--files <paths>` — comma-separated file paths to derive keywords from
- `--keywords <text>` — additional keywords, in addition to any derived. Accepts a comma-separated list or free text: the value is split on whitespace and `,;:()[]{}`, and single characters are dropped.
- `--bundle` — emit the merged ADF document instead of the resolution summary
- `--ai-dir <dir>` — custom `.ai/` directory (default: `.ai`)

Reports the derived keywords and each resolved module as `DEFAULT` or `ON_DEMAND`.

### charter adf suggest

Diagnostics over `.charter/telemetry/events.ndjson`: dead modules, recurring unmatched keywords, and modules that load while a downstream command still fails. Report-only — no module attribution is guessed and nothing is applied automatically.

```bash
npx charter adf suggest
npx charter adf suggest --min-occurrences 5
npx charter adf suggest --emit-ops /tmp/ops.json
```

- `--min-occurrences <n>` — threshold before a signal is reported (default: `3`)
- `--window-minutes <n>` — time-window fallback for joining a resolution to a later command outcome when no `sessionId` is set (default: `60`)
- `--emit-ops <file>` — write non-ambiguous candidates as `REPLACE_BULLET` ops for review, then apply with `charter adf patch --ops-file <file>`
- `--ai-dir <dir>` — custom `.ai/` directory (default: `.ai`)

Also reports co-occurrence trigger candidates — a weaker, non-failure-backed heuristic where a keyword often appears alongside one that already triggers a module.

### charter adf vendor

Show or record each vendor file's mode: a thin `pointer` to `.ai/`, `compiled` output of `charter adf compile`, or `unmanaged` (hand-authored, left alone). The record is a `VENDORS` list in `<ai-dir>/manifest.adf`. Vendor files are read from the repository root.

```bash
npx charter adf vendor status                       # recorded or inferred mode of each vendor file
npx charter adf vendor status --all --format json   # include absent names
npx charter adf vendor set CLAUDE.md compiled       # record one file's mode
npx charter adf vendor set CLAUDE.md pointer --dry-run
npx charter adf vendor init                         # record inferred modes for unrecorded files
npx charter adf vendor restore CLAUDE.md            # rewrite one pointer from its template
npx charter adf vendor rename-legacy --dry-run      # plan renaming a pre-#297 agents.md to AGENTS.md
```

```
🏷 VENDORS:
  - CLAUDE.md: pointer
  - AGENTS.md: compiled
```

- `status`: read-only. A file with a valid entry shows its recorded mode, plus `(recorded; file looks compiled)` when the markers on disk disagree. A file without one shows the mode inferred from its markers, the way `adf tidy` classifies it: the compile banner means `compiled`, a pointer marker means `pointer`, and anything else is `unmanaged`. Malformed, duplicate (the last entry wins), unknown-file and not-allowed entries are reported and ignored. A missing manifest exits 0 with a warning.
- `set <file> <mode>`: records or replaces one entry, editing only that line. Only `CLAUDE.md`, `AGENTS.md`, `.cursorrules` and `GEMINI.md` may be `compiled`. `agents.md` and `copilot-instructions.md` have no compile target, so `compiled` is refused with exit 1. An unknown file or mode, or a missing manifest, exits 2. The file does not have to exist yet.
- `init`: records the inferred mode of every vendor file on disk that has no entry. It never changes an existing entry, and a second run writes nothing.
- `restore <file>`: rewrites one file as its thin pointer template (`CLAUDE.md` gets the hybrid template with the module index filled in, as bootstrap writes it). It runs only when the file's mode is `pointer` (recorded or inferred), or the file is absent with no entry, and it refuses (exit 1, file untouched) whenever content would be lost: `mode-not-pointer` (record the intent first with `vendor set <file> pointer`), `hand-authored` (run `adf migrate --source <file>`), `pointer-bloated` (run `adf tidy --source <file>`), and `compiled-differs` (a compiled file that differs from what `.ai/` compiles to now, checked in memory; keep it with `vendor set <file> compiled`). A compiled file's retained block, and retained sections outside one, are not a difference: they are carried into the pointer as plain sections and listed in `keptSections`. The `retained-divergent` refusal is retired. A block holding anything a pointer cannot keep as a retained section is refused as `would-drop`, naming it, and the file is left as it is. That covers a non-retained heading such as `## My Notes`, and text before the first heading (`adf tidy` would move it out of the pointer). The first remedy is `vendor set <file> compiled`, which keeps the file compiled. Otherwise, move that content under `## Environment` or into a `.ai/` module first. For a pointer, every non-blank line must survive: a line that is not from a Charter pointer template (current or earlier) or the generated module index, and that the new pointer would not carry, is refused as `hand-authored` with the first few lines named. Retained sections of a pointer are carried over verbatim and listed. It is the fix for a recorded pointer that now holds compiled output. A file with no entry gets `pointer` recorded before the file is written; if that cannot be recorded, nothing is written (`record-write`), and if the file write fails, the manifest is put back byte for byte (`write-failed`, with `writeError`). A result identical to the file on disk is `unchanged` and writes nothing. `--dry-run` reports `planned`. An unknown file name exits 2. JSON output: `file`, `status` (`restored`, `planned`, `unchanged`, `refused`), `refusal`, `keptSections`, `remedy`, `writeError`; text lines go to stderr under `--format json`.

One physical file has one entry. When two vendor names are the same file (`AGENTS.md` and `agents.md` on a case-insensitive filesystem, or a hard link), every writer records it under the spelling already recorded, or `AGENTS.md` when neither is. `status` shows it once. `set` names the spelling it used.
- `rename-legacy`: renames a lowercase `agents.md` (written by bootstrap before #297) to `AGENTS.md`, and moves its `VENDORS` key with it. The record moves first, through the same text-level writer and re-parse guard as `set`: `agents.md: <mode>` becomes `AGENTS.md: <mode>`, or, when `AGENTS.md` is already recorded with the same mode, the `agents.md` line is removed. The rename is two steps through `agents.md.charter-rename`, because a one-step case-only rename is a no-op or an error on a case-insensitive filesystem.
  - **Index effect.** When git tracks `agents.md`, both steps are `git mv`, so the rename is **staged** (`git diff --cached` shows `R agents.md -> AGENTS.md`) and no other path is. `manifest.adf` is left unstaged, and the output names the command: `git add .ai/manifest.adf && git commit`, with `AGENTS.md` added to the `git add` when its title line was rewritten. A plain `git commit` also records anything you had already staged, and the output says so. An untracked `agents.md`, or a directory outside git, is renamed on disk only (`method: fs`). When the file is already `AGENTS.md`, only the key moves (`record-only`).
  - **Content effect.** The only content edit is a first line that is exactly `# agents.md` (the old template title), rewritten to `# AGENTS.md` and left unstaged with the manifest. Mentions of `agents.md` in `.ai/*.adf` and root `*.md` files are listed, never edited.
  - **Refusals** (exit 1, nothing changed): `both-distinct` (git tracks both spellings, or the disk has two different files: Charter never merges or deletes them), `dirty` (`agents.md` has staged or unstaged changes, so commit or stash first), `tmp-exists`, `record-conflict` (both keys recorded with different modes, or more than one `agents.md` line), `index-unreadable` (inside a git work tree but `git ls-files` failed: it never falls back to a plain rename of a file git may track), `not-repo-root` (run below the repository root, or outside git with an `--ai-dir` above the current directory: run it from the root, so a nested `docs/agents.md` is never renamed), `record-write` (the record cannot be read or edited safely). If either rename step fails, the completed step is undone and the record put back (`rename-failed`).
  - Nothing renames `agents.md` automatically: bootstrap, tidy, compile and the pre-commit hook never call this. `--format json` prints one result: `status`, `method`, `from`, `to`, `staged`, `record`, `titleUpdated`, `references`, `refusal`, `remedy`, `error`.
- `set AGENTS.md compiled` on a file recorded as `agents.md` exits 1 and names `rename-legacy` first. `pointer` and `unmanaged` still write through the recorded `agents.md` spelling.
- `--dry-run`: with `set`, `init`, `restore` or `rename-legacy`, report the change without writing
- `--all`: with `status`, also list vendor names that are absent and unrecorded
- `--ai-dir <dir>`: custom `.ai/` directory (default: `.ai`)

`bootstrap` and `adf init --emit-pointers` record `pointer` for each pointer file they write. `adf migrate` records `pointer` for each source it replaces with a pointer, and `adf compile --write` records `compiled` for each target it writes (with `--mode compiled`, replacing the entry). The other writers only add missing entries. If a file is already recorded with another mode, the entry is kept and a warning names `adf vendor set` as the way to change it. Nothing is recorded under `--dry-run`, and a failed record write is only a warning, except under `adf compile --write --mode compiled`, where the target is refused (`refused-record`) and its file is not written. Every manifest edit is text-level and keeps line endings and every other byte, and the block it writes is already in `adf fmt` canonical form. It is re-parsed before writing, and if the result would change anything else, nothing is written.

`adf compile` (`--check` and `--write`), `adf tidy`, `doctor`, `score`, `bootstrap` and `adf migrate` act on the record; see their sections. The pre-commit hook passes each staged vendor file to `adf tidy --source`, so it acts on the record too. Its compile-banner check only saves the CLI call on commits that stage compiled output alone. `score` skips the section when it checks manifest path references.

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

Expose ADF project context as an MCP server over stdio, for use with Claude Code, Codex, and Cursor.

```bash
npx charter serve                             # stdio MCP server (default)
npx charter serve --ai-dir /abs/path/.ai      # explicit ADF directory
npx charter serve --name "my-project"         # override the server name shown in MCP clients
```

- `--ai-dir <dir>` — path to the `.ai/` ADF directory (default: `.ai`). **Always resolved to an absolute path at startup**, relative to the working directory the server was spawned in. When wiring in `.mcp.json`, use the repo-relative `.ai` — `.mcp.json` is a committed, shared file, so an absolute path breaks it for every other clone and for CI.
- `--name <name>` — override the MCP server name (default: inferred from `core.adf` `PROJECT` section or directory name).

#### Wiring in `.mcp.json`

```json
{
  "mcpServers": {
    "charter": {
      "command": "npx",
      "args": ["@stackbilt/cli", "serve", "--ai-dir", ".ai"]
    }
  }
}
```

Use the repo-relative `.ai` — this is what `charter bootstrap` generates. `.mcp.json` is committed and shared, so an absolute path here leaks your local directory layout and breaks the server for every other clone and for CI.

`.ai` resolves against the working directory the MCP client spawns the server in, which is normally the project root. If your client spawns it somewhere else, set the client's `cwd`, or pass an absolute `--ai-dir` and keep the whole file out of version control — add `.mcp.json` to `.gitignore` (and `git rm --cached .mcp.json` if it is already tracked). An absolute path is only a problem in a file other people clone. A wrong working directory fails loudly rather than silently: `charter serve` emits a startup error naming the path it resolved (see [Startup errors](#startup-errors)).

`charter bootstrap` warns about an absolute `--ai-dir` only when git actually tracks `.mcp.json`, so a deliberately machine-local config stays quiet.

#### Startup errors

If startup validation fails (missing `.ai/` directory or `manifest.adf`), `charter serve` emits a structured JSON-RPC error to stdout before exiting so MCP clients can surface a human-readable message:

| Condition | Error message | Fix |
|-----------|--------------|-----|
| `.ai/` directory missing | `No .ai/ directory found.` | `charter init` |
| `manifest.adf` missing | `.ai/manifest.adf not found.` | `charter adf init` |

#### Registered MCP tools

| Tool | Description |
|------|-------------|
| `charter_brief` | **Call first.** Pre-digested repo brief — routes, hotspots, governance. |
| `charter_context` | Session continuity snapshot reader/refresher (`.ai/context.snapshot.json`). Use `refresh=true` to run `context-refresh` before reading. |
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
| Identity | `.charter/config.json`, `manifest.adf` (`PRESET`/`STACK`), and `package.json` | Yes |
| Surface | `charter surface` (routes + D1 tables) | Yes |
| Hotspots | `charter blast` (top hot files by importer count) | Yes |
| Sensitivity | `.charter/config.json` tags + ADF `SENSITIVITY` sections (manifest + referenced modules) | Yes |
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

Seeds for hotspot analysis are chosen by resolved preset (from `.charter/config.json` when set, otherwise ADF `PRESET` fallback):

| Preset | Seeds |
| ------ | ----- |
| worker | `src/index.*`, route files, wrangler entry |
| frontend | `src/App.*`, `src/main.*`, `src/index.*` |
| backend | `src/index.*`, `src/server.*`, `src/app.*` |
| fullstack | worker + frontend seeds |
| cli | `bin/` entries, `src/commands/*.ts` |
| docs | `README.md`, `docs/*.md` |
| rust-wasm | `src/lib.rs`, `src/**/*.rs`, `Cargo.toml` |
| unknown | `src/index.*`, `src/main.*` |

### charter context-refresh

Generates a live session snapshot and writes it to `.ai/context.adf` plus `.ai/context.snapshot.json`.

Supports `git`, `github`, and `repo-intel` sources with fail-closed behavior for missing GitHub credentials and graceful skip when the `gh` CLI is unavailable.

```bash
npx charter context-refresh
npx charter context-refresh --sources git
npx charter context-refresh --sources git,github
npx charter context-refresh --sources repo-intel
npx charter context-refresh --output CONTEXT.md
npx charter context-refresh --ai-dir .ai
npx charter context-refresh --once --ttl-minutes 30
npx charter context-refresh --format json
```

#### Flags

- `--sources <csv>` — context sources to include. Supported: `git`, `github`, `repo-intel`.
- `--output <path>` — optionally mirror a markdown snapshot to a file (for session briefs/docs).
- `--ai-dir <dir>` — target ADF directory (default: `.ai`), output file is `<dir>/context.adf`.
- `--once` — skip refresh when an existing snapshot is newer than TTL.
- `--ttl-minutes <n>` — TTL window used by `--once` (default from config or `30`).
- `--force` — bypass TTL skip and refresh immediately.

#### Output

- Always writes:
  - `.ai/context.adf` (or `<ai-dir>/context.adf`)
  - `.ai/context.snapshot.json` (or `<ai-dir>/context.snapshot.json`)
- Context payload includes:
  - `STATE` metadata (`GENERATED_AT`, source set)
  - `OPEN_WORK` (branch + working tree status)
  - `RECENT_ACTIVITY` (recent commits / issue updates)
  - `PENDING_DECISIONS` (derived issue prompts)
- In `--format json`, prints a machine-readable summary including `status`, `reason`, `generatedAt`, `expiresAt`, `files`, `warnings`, and `errors`.

#### Config file

Optional config path: `.charter/context-sources.json`

- `defaults.sources` — default sources when `--sources` is omitted
- `defaults.ttlMinutes` — default TTL for `--once`
- `defaults.maxItems` — source-specific result caps
- `sources.github` — repo + strict label filter setup

If `github` is enabled but `GITHUB_TOKEN` is missing, refresh continues without hard failure and records `sources.github.available = false` plus warnings.

If `repo-intel` is enabled but the `gh` CLI is not installed or has no GitHub remote, refresh continues without hard failure and records a warning. When available, `repo-intel` writes a full payload to `.charter/repo-intel/snapshot.json`.

#### Sources reference

| Source | Description |
|--------|-------------|
| `git` | Local git branch, working tree, and recent commit log. |
| `github` | Open issues from the GitHub API (requires `GITHUB_TOKEN`). |
| `repo-intel` | GitHub history via the `gh` CLI — open/closed issues, PRs, releases, and a computed summary (`openIssueCount`, `mergeVelocity`, `stalledIssues`, `recurringLabels`, `releaseCadence`). Writes `.charter/repo-intel/snapshot.json`. Skips gracefully when `gh` is unavailable. |

For active implementation status and next-session handoff details, see [Context Refresh Resume Guide](/context-refresh-resume).

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
| `--yes` | Accept all prompts (for automation). It never means "overwrite": `bootstrap --yes` and `init --yes` keep existing `.charter/` files and `.mcp.json`'s charter entry |
| `--preset <name>` | Stack preset (`worker`, `frontend`, `backend`, `fullstack`, `docs`, `rust-wasm`) |
| `--detect-only` | Setup mode: detect stack/preset and exit |
| `--no-dependency-sync` | Setup mode: do not rewrite `@stackbilt/cli` devDependency |
| `--force` | Overwrite existing files; what that covers depends on the command. `hook install --force` replaces a non-Charter hook. `bootstrap --force` rewrites Charter thin pointers and `.mcp.json`'s charter entry (backing `.mcp.json` up to `.charter/.backup/` first), replaces a hand-edited or permission-widening `charter-governance.yml` under `--ci github` (backed up the same way) and merges `.ai/*.adf` (it never replaces them, never overwrites `.charter/` files, and never overwrites a hand-authored or compiled vendor file; `bootstrap` never installs hooks). `init --force` and `setup --force` replace `.charter/` templates, backing each up to `.charter/.backup/` first. `adf init --force` merges like `bootstrap --force`; `adf init --reset-adf` replaces. `adf create`, `adf populate` and `adf compile --write` document their own `--force` |

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success / pass |
| `1` | Policy violation (CI mode: governance threshold breached) |
| `2` | Runtime / config / usage error |

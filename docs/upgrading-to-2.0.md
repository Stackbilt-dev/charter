# Upgrading to Charter 2.0

Charter 2.0 records whether each vendor file (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `GEMINI.md`, `agents.md`, `copilot-instructions.md`) is a thin **pointer** to `.ai/`, **compiled** output of `charter adf compile`, or **unmanaged** (hand-authored, left alone). Commands act on that record instead of guessing from markers. Most repos upgrade with the seven steps below. The rest of this page explains what changes and what each new doctor line means.

The full list of changes is in the [CHANGELOG](../CHANGELOG.md). Flag details are in the [CLI reference](./cli-reference.md).

## Upgrade in seven steps

Run these from the repository root, starting from a clean working tree (`git status` shows nothing to commit).

```bash
# 1. Upgrade the CLI. The git hooks call `npx charter`, so the local devDependency must be 2.0 too.
npm install --save-dev @stackbilt/cli@latest      # or: pnpm add -D @stackbilt/cli@latest
npx charter --version

# 2. Clean up two files 1.x bootstrap made unsafe to commit (both commands are no-ops if already fine)
#    a. Stop tracking the telemetry log: every charter run rewrites it, so it would land in the commit
grep -qx 'telemetry/' .charter/.gitignore 2>/dev/null || echo 'telemetry/' >> .charter/.gitignore
git rm -r -q --cached --ignore-unmatch .charter/telemetry
#    b. Replace an absolute --ai-dir in .mcp.json with the repo-relative .ai (it breaks other clones and CI)
node -e 'const fs=require("fs"),f=".mcp.json";if(!fs.existsSync(f))process.exit();const j=JSON.parse(fs.readFileSync(f,"utf8")),a=(j.mcpServers&&j.mcpServers.charter&&j.mcpServers.charter.args)||[],i=a.indexOf("--ai-dir");if(i>=0&&/^([A-Za-z]:)?[\\/]/.test(a[i+1])){a[i+1]=".ai";fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");console.log("fixed .mcp.json")}'

# 3. See what Charter infers about each vendor file, then record it
npx charter adf vendor status
npx charter adf vendor init

# 4. Reinstall the hooks you use. Required: installed hooks keep their 1.x behaviour until you do.
npx charter hook install --pre-commit
npx charter hook install --commit-msg            # only if you use the commit-msg hook

# 5. Rename a lowercase agents.md, if you have one ("Nothing to rename" means you don't)
npx charter adf vendor rename-legacy --dry-run
npx charter adf vendor rename-legacy             # stages the rename as a git mv

# 6. Check, and re-compile if you use compiled files
npx charter adf compile --target all --check
npx charter adf compile --target all --write     # only needed if --check reports [stale]

# 7. Read doctor and fix what it names (see the table below), then commit
npx charter doctor
git add -u                                       # manifest, re-compiled files, .gitignore, .mcp.json, package.json, lockfile
git status
git commit -m "chore: upgrade charter to 2.0" -m "Governed-By: ADR-001"   # the trailer is required once the commit-msg hook is on
```

`charter adf vendor init` writes only to `.ai/manifest.adf`. It records each unrecorded file's inferred mode and never changes an existing entry. If `status` shows a mode you did not mean, record the right one with `charter adf vendor set <file> <pointer|compiled|unmanaged>`.

`git add -u` stages every tracked file you changed, which is why the steps start from a clean tree. It also picks up `AGENTS.md` when `rename-legacy` rewrote its `# agents.md` title line. The telemetry log stays on disk after step 2, so `charter telemetry report` keeps working. Use your own policy reference in the trailer (`Governed-By:` or `Resolves-Request:`). If your `.ai/` directory is not `.ai`, use its repo-relative path in step 2b. If `.mcp.json` is meant to stay machine-local, skip 2b and instead add `.mcp.json` to `.gitignore` and run `git rm --cached .mcp.json`.

## Breaking: only `--mode compiled` turns a pointer into compiled output

In 1.9.3, `charter adf compile --write` refused the thin pointers that `bootstrap` writes, and its message said to "run --force once to convert". `--force` then replaced them with compiled output, which changed the file's mode without recording it. In 2.0, `--force` never changes a file's mode, and `--write` writes only targets that are compiled already, or absent:

| Target is | `--target all --write` | `--target <t> --write` |
|---|---|---|
| compiled, or absent with no record | written | written |
| pointer or unmanaged | skipped, exit 0, `[skip]` line names the fix | refused, exit 1 |

`--target all --write` on a bootstrapped repo therefore exits 0 and writes nothing, where 1.9.3 exited 1.

To switch files to compiled output, choose one:

```bash
# Convert pointers in one run (records compiled first, then writes)
npx charter adf compile --target all --write --mode compiled

# Or record the mode for one file, then compile as usual
npx charter adf vendor set CLAUDE.md compiled
npx charter adf compile --target claude --write
```

`--force` never changes a file's mode. It still means "overwrite hand-authored content". Converting a hand-authored file therefore needs `--mode compiled --force`.

A converted pointer is still refused (exit 1, nothing written) if it holds content the compiled file would not keep:

- `refused-bloated`: run `charter adf tidy --source <file>` first.
- `refused-would-drop`: move the lines under `## Environment` or into a `.ai/` module.

`--force` discards that content. It never discards retained sections.

If a script runs `adf compile --target all --write --force` to convert pointers, replace `--force` with `--mode compiled`. Once the files are recorded `compiled`, plain `--write` re-renders them.

## Re-run the hook installs

Installed hooks are not upgraded for you. Re-run the installs from step 3 to get:

- **pre-commit**: tidies only the vendor files the commit stages, and re-stages only the files tidy wrote. A staged vendor file that also has unstaged changes is skipped, with a message. The old hook re-staged all of `.ai/*.adf` and could sweep unrelated edits into a commit. The evidence gate blocks on vendor bloat only in files the commit includes (see the note below).
- **commit-msg**: now rejects a commit with no `Governed-By` or `Resolves-Request` trailer when `git.requireTrailers` is on and strictness is `FAIL`/`STRICT`, or `ci.failOnWarn` is `true`. Under advisory strictness it only warns. The old hook only normalized trailers you had already typed, so a missing trailer first showed up as a red CI run.

The new pre-commit hook calls `charter adf tidy --print-paths` and `charter doctor --staged`. With a 1.x CLI in `node_modules`, `--print-paths` is unknown, so the hook reports files as clean and tidies nothing. Upgrade the CLI as well as the hook.

> **`verify:adf` script.** If `package.json` has a `verify:adf` script (`charter setup` and `bootstrap` add one), the pre-commit gate runs `pnpm run verify:adf` instead of the built-in `charter doctor --adf-only --ci --staged …` gate. The gate is then not scoped to the commit, so vendor bloat anywhere in the working tree can block the commit, as in 1.x.

## What doctor's new lines mean

None of the INFO lines fails `charter doctor --ci`. A repo that has no `VENDORS` record yet gets only INFO lines from the new checks, so the upgrade itself does not turn CI red.

| Line | Status | What it means | Fix |
|---|---|---|---|
| `pre-commit hook` | INFO | The installed pre-commit hook is from 1.x (it tidies every vendor file and re-stages all of `.ai/*.adf`). | `charter hook install --pre-commit` |
| `gate enforcement` naming the commit-msg hook | WARN | The commit-msg hook only normalizes trailers, so nothing blocks a missing trailer locally. | `charter hook install --commit-msg`, or run `charter validate --ci` in CI |
| `adf vendor mode`: "N vendor file(s) have no recorded mode" | INFO | No `VENDORS` entry. Modes are inferred from markers. | `charter adf vendor init` |
| `adf vendor mode`: "git tracks agents.md under its pre-#297 lowercase name" (`legacy-tracked`) | INFO | Bootstrap before #297 wrote `agents.md`. Harnesses on case-sensitive systems read `AGENTS.md`. | `charter adf vendor rename-legacy` |
| `adf vendor mode`: `legacy-both-distinct` | INFO | Git tracks both spellings, and they are two different files. | Move what you need into `AGENTS.md`, then `git rm agents.md` |
| `adf vendor mode`: `legacy-both-one-file` | INFO | Git has both index entries for one file (a case-insensitive checkout). | `git rm --cached agents.md` |
| `adf vendor mode`: `legacy-spelling` | INFO | `AGENTS.md` is recorded under the legacy key `agents.md`. | `charter adf vendor rename-legacy` |
| `adf vendor mode`: `recorded-drift` | **WARN** | A file recorded `pointer` or `compiled` looks like another mode on disk. | The line names the content-preserving fix first: `charter adf vendor set <file> <mode>` to keep the file as it is, or the command that restores it (`charter adf vendor restore <file>` for a pointer) |
| `adf vendor mode`: `recorded-absent` | **WARN** | A file recorded `pointer` or `compiled` is missing. | `charter adf vendor restore <file>`, `charter adf compile --target <t> --write`, or `charter adf vendor set <file> unmanaged` |
| `adf vendor mode`: malformed entry, unknown file, mode the file cannot have, or `VENDORS` is not a list | **WARN** | Hand edit to `.ai/manifest.adf`. | Fix the named line. `agents.md` and `copilot-instructions.md` can never be `compiled` |
| `adf vendor bloat (not blocking)` | INFO | Shown only under `doctor --staged` (the pre-commit gate). Vendor bloat in files the commit does not include. | `charter adf tidy --source <file>` (named per file) |
| `telemetry tracking` | INFO | `.charter/telemetry/events.ndjson` is tracked by git. Repos bootstrapped by 1.x committed it. | Make sure `telemetry/` is ignored in `.charter/.gitignore`, then `git rm -r --cached ".charter/telemetry"` |

The WARN rows in `adf vendor mode` also fail the pre-commit gate, which runs `doctor --adf-only --ci`. They appear only where a record you wrote is contradicted or broken.

Under `doctor --staged` (what the hook passes), the `adf vendor bloat` check counts only staged vendor files. Plain `charter doctor --ci`, as in CI, still fails on vendor bloat in every file.

## Lowercase `agents.md`

Repos bootstrapped before #297 track `agents.md`, which nothing renames automatically. `rename-legacy` renames it to `AGENTS.md` safely on case-insensitive filesystems, and moves its `VENDORS` key first:

```bash
npx charter adf vendor rename-legacy --dry-run   # see the plan
npx charter adf vendor rename-legacy             # stages R agents.md -> AGENTS.md
git add .ai/manifest.adf AGENTS.md               # or run exactly the git add line the output prints
git commit -m "chore: rename agents.md to AGENTS.md"
```

When git tracks the file, the rename is staged and nothing else is. If the `VENDORS` key moved, `.ai/manifest.adf` is left for you to `git add`, and if the title line was rewritten, so is `AGENTS.md`. The output names the files to add. (After `adf vendor init` on a case-insensitive filesystem, the key is often already `AGENTS.md`, so only `AGENTS.md` is named.) Its only content edit is a first line that is exactly `# agents.md`. Other mentions of `agents.md` are listed, not edited. It refuses, exit 1, and changes nothing when:

- both spellings are tracked, or are two different files;
- `agents.md` has uncommitted changes;
- the two keys are recorded with different modes;
- the git index cannot be read;
- it is run below the repository root.

Until you rename, `adf compile --target agents --write --mode compiled` refuses with `refused-legacy-spelling` and names the rename.

## Your `## Environment` notes in compiled files

In 1.x, re-compiling a compiled file deleted a hand-added `## Environment` section, or another section that `adf tidy` keeps (`## Session …` other than `## Session Start`, or headings containing Protocol, Receipt, Provenance or Registration). In 2.0, `compile --write` keeps them in a block at the end of the file:

```markdown
<!-- charter:retained:start -->
<!-- Kept verbatim by charter adf compile. Edit freely between the retained markers. -->

## Environment
- Use WSL for builds
<!-- charter:retained:end -->
```

Edit freely inside the block. Every later `--write` copies it as it stands, and an edit inside it never makes `--check` stale. A compiled file with nothing to carry gets no block and compiles byte-for-byte as before.

### One-time `--check` reports after upgrading

| `--check` says | Why | Fix |
|---|---|---|
| `[stale]` with `staleReason: "retained-unfenced"` | A compiled file has retained sections outside the block (written by 1.x). | `charter adf compile --target <t> --write` once. It moves them into the block. |
| `[stale]` with `staleReason: "retained-ambiguous"` | A section sits inside generated text that `.ai/` no longer renders, and no `.ai/` module holds its heading. It may be stale output or your own text. `--write` refuses it as `refused-ambiguous`. | Keep it: wrap it between `<!-- charter:retained:start -->` and `<!-- charter:retained:end -->`, then `--write`. Or discard it: `charter adf compile --target <t> --write --force`. |

A pointer is no longer reported `[stale]` forever. `--check` now checks each file by its mode:

- compiled files: `fresh`/`stale`;
- pointers: `pointer-ok`, or `pointer-bloated` (exit 1; fix with `charter adf tidy --source <file>`);
- unmanaged files: `skipped-unmanaged`;
- a file that contradicts its record: `mode-drift`;
- a recorded file that is gone: `missing`.

`--check` compares bytes. On Windows with `core.autocrlf=true`, a compiled file checked out with CRLF line endings reads stale. Add `*.md text eol=lf` and `.cursorrules text eol=lf` to `.gitattributes` if this affects you.

## `bootstrap --force` keeps your vendor files

`charter bootstrap --force` still re-scaffolds `.ai/*.adf` (backups go to `.ai/.backup/`) and still rewrites Charter thin pointers from the current template. It no longer overwrites vendor files that are:

- hand-authored (no Charter marker);
- compiled output;
- recorded `compiled` or `unmanaged`.

Each skipped file gets a warning naming the next step. That is `charter adf migrate --source <file>`, or for compiled output `charter adf vendor set <file> pointer && charter adf vendor restore <file>`. In 1.x, `--force` overwrote a hand-authored `CLAUDE.md` before phase 4 could migrate it, and its rules were lost. With `--yes`, phase 4 now migrates such a file into `.ai/` and writes `.pre-adf-migrate.bak`, if it has no `VENDORS` entry.

To replace a hand-authored file without migrating it, delete it and re-run bootstrap.

## `charter score` may go up

A thin pointer used to score as "thin" (−5 and "Expand `CLAUDE.md` beyond a thin pointer") however much `.ai/` held. It now counts as substantive when the file `adf compile` would render for it is substantive. That file is compiled in memory and nothing is written. Hand-authored and compiled files are scored on their text as before. Scores can only rise. A committed `.charter/badge.json` may need `charter score --badge --write`.

## For JSON consumers and scripts

**Changed values:**

- `adf tidy` reports an unmanaged file (recorded `unmanaged`, or hand-authored with no Charter marker) as `unmanaged`. In 1.x it was `not-found`, which now means only that the file does not exist.
- If you built against unreleased `main` before 2.0: `refused-retained` (`adf compile --write`) and `retained-divergent` (`adf vendor restore`) are retired and never shipped in a release. Retained sections are now carried instead.

**New values and fields:**

| Command | Added |
|---|---|
| `adf compile --write` | `skipped`, `targets[]` with `status`: `written`, `skipped-mode`, `refused-mode-change`, `refused-hand-authored`, `refused-bloated`, `refused-would-drop`, `refused-ambiguous`, `refused-record`, `refused-legacy-spelling`; plus `state`, `source`, `recordedMode`, `previousMode`, `remedy`, `writeError`, `retainedSections`, `retainedSource`, `retainedSkipped`, `retainedAmbiguous` |
| `adf compile --check` | `skipped`, `targets[]` with `pointer-ok`, `pointer-bloated`, `mode-drift`, `skipped-unmanaged`, `missing`, and `staleReason` (`content`, `retained-unfenced`, `retained-ambiguous`, or null). `stale` now also lists bloated and drifted files |
| `adf vendor restore` | `status` (`restored`, `planned`, `unchanged`, `refused`), `refusal` (including `would-drop`, `write-failed`), `keptSections` |
| `adf vendor rename-legacy` | one result: `status`, `method`, `from`, `to`, `staged`, `record`, `titleUpdated`, `references`, `refusal`, `remedy`, `error` |
| `adf tidy` | `paths` (`vendor`, `modules`); file rows add `vendorFile`, `mode`, `source`, `skipReason`; status `compiled` |
| `adf migrate` | `sources[].registrations[]` |
| `doctor` | `rows` on the `adf vendor mode` check only; new check names `adf vendor mode`, `pre-commit hook`, `telemetry tracking` and `adf vendor bloat (not blocking)` |
| `score` | `signals.agentConfig` adds `mode`, `source`, `substantiveVia` per file |

Exit codes that changed:

- `adf compile --target all --check` on thin pointers exits 0 (`pointer-ok`). 1.9.3 reported every pointer `[stale]` and exited 1, so a CI step that expected that failure now passes. A pointer with content `adf tidy` would extract still exits 1 (`pointer-bloated`).
- `adf compile --target all --write` with pointer or unmanaged targets exits 0 and skips them (1.9.3 refused them, exit 1).
- `adf compile --write --force` no longer converts a pointer (1.9.3 did). A single `--target` is refused with exit 1, and `--target all` skips it with exit 0.
- `adf tidy --source` with no value exits 2 (it used to tidy every file).

New flags that are usage errors (exit 2) when misused: `adf tidy --print-paths` with `--format json`, and `doctor --tidy-skipped` without `--staged`.

**`@stackbilt/adf` library:** `classifyElement` now always sets `routingTrace`, with `candidateScores: {}` when there is no trigger map. Check `candidateScores` instead of "is `routingTrace` defined" to tell whether content routing ran. `RoutingTrace` gains an optional `headingKeyword`, and `parseManifest` gains a `vendors` field.

**`@stackbilt/git` library:** the trailer parser no longer accepts a whitespace-only value (`Governed-By:   `), and such a line ends the terminal trailer block, so trailers above it are not counted (`#340`).

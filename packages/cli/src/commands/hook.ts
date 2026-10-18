/**
 * charter hook
 *
 * Installs git hooks for commit-time governance ergonomics.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { runGit, isGitRepo, getGitErrorMessage } from '../git-helpers';
import { getFlag } from '../flags';
import { HOOK_SCOPED_DOCTOR_ENV, HOOK_SCOPED_DOCTOR_FILE } from './hook-scope';

export { HOOK_SCOPED_DOCTOR_ENV, HOOK_SCOPED_DOCTOR_FILE };

interface HookInstallResult {
  status: 'INSTALLED' | 'SKIPPED';
  hookPath: string;
  reason?: string;
}

const COMMIT_MSG_HOOK_MARKER = '# Managed by Charter: commit-msg trailer normalizer';
// Second marker so doctor can tell a gating hook from the pre-#299 normalizer-only
// hook; both carry COMMIT_MSG_HOOK_MARKER, which keeps old installs recognised as managed.
const COMMIT_MSG_GATE_MARKER = '# Charter commit-msg trailer gate: rejects missing trailers when git.requireTrailers is on';
const COMMIT_MSG_HOOK_CONTENT = `#!/usr/bin/env sh
${COMMIT_MSG_HOOK_MARKER}
${COMMIT_MSG_GATE_MARKER}
set -eu

msg_file="$1"

governed_by="$(grep -i '^Governed-By:' "$msg_file" | tail -n 1 | sed -E 's/^[Gg]overned-[Bb]y:[[:space:]]*//')"
resolves_request="$(grep -i '^Resolves-Request:' "$msg_file" | tail -n 1 | sed -E 's/^[Rr]esolves-[Rr]equest:[[:space:]]*//')"

if [ -n "$governed_by" ]; then
  git interpret-trailers --in-place --if-exists=replace --trailer "Governed-By: $governed_by" "$msg_file"
fi

if [ -n "$resolves_request" ]; then
  git interpret-trailers --in-place --if-exists=replace --trailer "Resolves-Request: $resolves_request" "$msg_file"
fi

# Trailer gate (#299). Mirrors what "charter validate --ci" fails on, including
# loadConfig's defaults: each config section is merged over the defaults
# (git.requireTrailers true, validation.citationStrictness FAIL, ci.failOnWarn
# false), an unparseable config falls back to those defaults, and requireTrailers
# is tested for truthiness. With the policy on, a commit needs a Governed-By or
# Resolves-Request trailer (either one, key case-insensitive) in the terminal
# trailer block. It blocks when citationStrictness is FAIL or STRICT, or
# ci.failOnWarn is set; any other strictness only warns, as CI does.
# Deliberate exceptions, each announced on stderr: no .charter/config.json at
# all (the hook cannot tell the repo opted in) and no node on PATH (the config
# cannot be evaluated) skip the gate.
# Comment lines are stripped before the check, as "git commit" does with its
# default editor cleanup. Under -m or --cleanup=verbatim git keeps "#" lines,
# so a trailer followed by a "#..." line can pass here and still fail CI.
if [ ! -f ".charter/config.json" ]; then
  echo "[commit-msg] Warning: no .charter/config.json; trailer gate skipped." >&2
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[commit-msg] Warning: node not found on PATH; trailer gate skipped (cannot read .charter/config.json)." >&2
  exit 0
fi
gate_mode="$(node -e '
var c;
try {
  c = JSON.parse(require("fs").readFileSync(".charter/config.json", "utf8"));
  if (c === null || c === undefined) throw new Error("null config");
} catch (e) {
  process.stderr.write("[commit-msg] .charter/config.json is unparseable; applying the defaults charter validate uses (requireTrailers on, citationStrictness FAIL).\\n");
  c = {};
}
var git = Object.assign({ requireTrailers: true }, c.git);
var validation = Object.assign({ citationStrictness: "FAIL" }, c.validation);
var ci = Object.assign({ failOnWarn: false }, c.ci);
var mode = "off";
if (git.requireTrailers) {
  var v = validation.citationStrictness;
  mode = (v === "FAIL" || v === "STRICT" || ci.failOnWarn) ? "block" : "warn";
}
process.stdout.write(mode);
')" || gate_mode=""
case "$gate_mode" in
  block|warn|off) ;;
  *)
    echo "[commit-msg] Warning: could not evaluate .charter/config.json with node; trailer gate skipped." >&2
    gate_mode="off"
    ;;
esac

if [ "$gate_mode" = "block" ] || [ "$gate_mode" = "warn" ]; then
  # Check the message git will record: drop a "commit -v" diff below the
  # scissors line and comment lines, then scan the terminal trailer block.
  trailer_state="$(sed -E '/^[^[:space:]]+ -+ >8 -+$/,$d' "$msg_file" | git stripspace --strip-comments | awk '
    { lines[NR] = $0 }
    END {
      i = NR
      while (i > 0 && lines[i] ~ /^[ \\t]*$/) i--
      if (i == 0) { print "empty"; exit }
      found = "missing"
      for (; i > 0; i--) {
        line = lines[i]
        if (line ~ /^[ \\t]*$/) break
        if (line !~ /^[A-Za-z][A-Za-z0-9-]*:[ \\t]*.+$/) break
        lower = tolower(line)
        if (lower ~ /^governed-by:[ \\t]*.+$/ || lower ~ /^resolves-request:[ \\t]*.+$/) found = "present"
      }
      print found
    }')" || trailer_state="present"

  if [ "$trailer_state" = "missing" ]; then
    if [ "$gate_mode" = "block" ]; then
      echo "[commit-msg] Rejected: git.requireTrailers is on and the message has no Governed-By or Resolves-Request trailer." >&2
      echo "  Add one as the last line of the message, for example: Governed-By: ADR-001" >&2
      exit 1
    fi
    echo "[commit-msg] Warning: no Governed-By or Resolves-Request trailer (not blocking: validation.citationStrictness is advisory)." >&2
  fi
fi
`;

export const PRE_COMMIT_HOOK_MARKER = '# Managed by Charter: pre-commit evidence gate';
// Second marker so doctor can tell a staged-only tidy hook from the pre-#320 one,
// which tidied every vendor file and re-staged all of .ai/*.adf. Both carry
// PRE_COMMIT_HOOK_MARKER, which keeps old installs recognised as managed.
export const PRE_COMMIT_SCOPE_MARKER = '# Charter pre-commit vendor tidy: scoped to staged files';
// Third marker (#357): the evidence gate blocks on vendor bloat only in files the
// commit stages (doctor --staged --tidy-skipped). A #356-era hook carries the two
// markers above but not this one, so doctor can tell it to re-run install.
export const PRE_COMMIT_GATE_SCOPE_MARKER = '# Charter pre-commit evidence gate: blocks on vendor bloat only in staged files';
// Fourth marker: a #360-era hook carries the three markers above but, in a repo
// with a verify:adf script, ran `pnpm run verify:adf` instead of the scoped
// doctor, so its whole-tree doctor still blocked on unrelated bloat, and the gate
// failed wherever pnpm is not installed.
export const PRE_COMMIT_VERIFY_SCOPE_MARKER = '# Charter pre-commit evidence gate: scoped in verify:adf repos too, run with the repo package manager';
// Fifth marker (#366): every Charter call goes through charter_cli, which runs the
// CLI with the repo's package manager (yarn, pnpm exec, npm exec @stackbilt/cli). An
// older hook called `npx charter`, which cannot resolve Charter under Yarn
// Plug'n'Play and, where Charter is not installed, fetches the unrelated registry
// package `charter`.
export const PRE_COMMIT_PM_CLI_MARKER = '# Charter pre-commit CLI: run through the repo package manager, never installed by the hook';

/**
 * The vendor tidy block of the pre-commit hook (#320). {CLI} is `charter_cli`
 * (the shell function HOOK_CLI_RESOLVE_BLOCK defines) here and
 * `node packages/cli/dist/bin.js` in the repo's own .githooks/pre-commit;
 * that is the only difference allowed between the two, and hook.test.ts checks it.
 * POSIX sh: no arrays, no [[, no jq. Works under set -eu and set -euo pipefail:
 * greps fed by a pipe read all their input (no -q), so under pipefail an early
 * exit can never SIGPIPE the writer and turn a match into a miss.
 */
export const HOOK_TIDY_BLOCK_TEMPLATE = `# Vendor file auto-tidy (#320): tidy only the staged vendor files, then re-stage only the files tidy wrote.
${PRE_COMMIT_SCOPE_MARKER}
# Skip with CHARTER_SKIP_TIDY=1
# This block never fails the commit; the ADF evidence gate after it may.
# TIDY_SKIPPED lists the vendor files it skipped; the generated hook passes it to
# doctor --staged --tidy-skipped, so their bloat does not block the commit (#357).
TIDY_SKIPPED=""
if [ "\${CHARTER_SKIP_TIDY:-0}" != "1" ] && [ -f ".ai/manifest.adf" ]; then
  VENDOR_FILES="CLAUDE.md .cursorrules AGENTS.md agents.md GEMINI.md copilot-instructions.md"
  STAGED=$(git diff --cached --name-only --diff-filter=d)
  SOURCES=""
  NAMES=""
  for vf in $VENDOR_FILES; do
    if printf '%s\\n' "$STAGED" | grep -xF "$vf" >/dev/null; then
      # Fast path: compiled output is never tidied (#319), so a commit staging only
      # compiled files never invokes the CLI.
      if [ -f "$vf" ] && grep -q 'GENERATED by charter adf compile' "$vf"; then
        continue
      fi
      if ! git diff --quiet -- "$vf"; then
        echo "[pre-commit] $vf has unstaged changes, so auto-tidy is skipped for it in this commit."
        echo "[pre-commit] Its bloat, if any, is left as-is; a plain charter doctor --ci (as CI runs it) still reports it. To tidy it: stage or stash the unstaged changes and commit again; or run: charter adf tidy --source $vf, then git add the result."
        TIDY_SKIPPED="$TIDY_SKIPPED $vf"
        continue
      fi
      SOURCES="$SOURCES --source $vf"
      NAMES="$NAMES $vf"
    fi
  done

  if [ -n "$SOURCES" ]; then
    echo "[pre-commit] Checking staged vendor files:$NAMES"
    PLAN_OK=1
    PLAN=$({CLI} adf tidy --dry-run --print-paths $SOURCES 2>/dev/null) || { echo "[pre-commit] adf tidy --dry-run failed; skipping auto-tidy."; PLAN=""; PLAN_OK=0; }
    if printf '%s\\n' "$PLAN" | grep -E '^(vendor|module) ' >/dev/null; then
      BLOCKED=""
      IGNORED=""
      set -f
      for p in $(printf '%s\\n' "$PLAN" | sed -n 's/^module //p'); do
        # A gitignored module (say, an .ai/ kept out of git) is never staged, so it is not WIP.
        if git check-ignore -q -- "$p"; then
          IGNORED="$IGNORED $p"
        elif ! git diff --quiet -- "$p" || { [ -e "$p" ] && ! git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; }; then
          BLOCKED="$BLOCKED $p"
        fi
      done
      set +f
      if [ -n "$BLOCKED" ]; then
        echo "[pre-commit] Auto-tidy skipped for this commit: tidy would write into files with unstaged or untracked work:$BLOCKED"
        echo "[pre-commit] Bloat in$NAMES, if any, is left as-is; a plain charter doctor --ci (as CI runs it) still reports it. To tidy: stage or stash that work and commit again; or run: charter adf tidy$SOURCES, then git add the result."
        TIDY_SKIPPED="$TIDY_SKIPPED$NAMES"
      else
        echo "[pre-commit] Moving content beyond the thin pointer into .ai/ ..."
        WROTE=$({CLI} adf tidy --print-paths $SOURCES 2>/dev/null) || { echo "[pre-commit] adf tidy failed; nothing re-staged."; WROTE=""; }
        EXTRA=""
        UNSTAGED=""
        set -f
        for line in $(printf '%s\\n' "$WROTE" | sed 's/ /:/'); do
          f="\${line#*:}"
          if ! printf '%s\\n' "$PLAN" | sed 's/ /:/' | grep -xF "$line" >/dev/null; then
            EXTRA="$EXTRA $f"
          elif git check-ignore -q -- "$f"; then
            :
          elif ! git add -- "$f" 2>/dev/null; then
            UNSTAGED="$UNSTAGED $f"
          fi
        done
        set +f
        if [ -n "$IGNORED" ]; then
          echo "[pre-commit] Gitignored, so left as-is and not staged:$IGNORED"
        fi
        if [ -n "$EXTRA" ]; then
          echo "[pre-commit] Tidy also wrote files its dry run did not plan; left unstaged, review and stage them yourself:$EXTRA"
        fi
        if [ -n "$UNSTAGED" ]; then
          echo "[pre-commit] Could not stage, left in the working tree; stage them yourself:$UNSTAGED"
        fi
        echo "[pre-commit] Vendor files tidied; re-staged only the planned files tidy wrote."
      fi
    elif [ "$PLAN_OK" = "1" ]; then
      # A failed dry run has said so above; it proves nothing about the files.
      echo "[pre-commit] Vendor config files are clean."
    fi
  fi
fi
`;

/** The tidy block with {CLI} replaced by the command that runs Charter. */
export function renderHookTidyBlock(cli: string): string {
  return HOOK_TIDY_BLOCK_TEMPLATE.split('{CLI}').join(cli);
}

/** The shell function the generated hook runs Charter with (#366). */
export const HOOK_CLI = 'charter_cli';

/** Files whose presence at the repo root means Yarn Plug'n'Play (#366). Shared with doctor. */
export const PNP_MARKER_FILES = ['.pnp.cjs', '.pnp.js'] as const;

/**
 * POSIX ERE for a .yarnrc.yml line that selects the PnP linker (`nodeLinker: pnp`,
 * optionally quoted, then a quote, blank, comment or end of line, so `pnpm` and
 * `pnp-loose` do not match). The hook greps with it, one line at a time; doctor
 * uses yarnrcPnpLinkerRegExp(), the same pattern with [:space:] spelled
 * [ \t\r\f\v] so that, like grep, it never matches across a newline.
 */
export const YARNRC_PNP_LINKER_ERE = `^[[:space:]]*nodeLinker:[[:space:]]*["']?pnp(["'[:space:]#]|$)`;

/** YARNRC_PNP_LINKER_ERE as a JS RegExp over a whole file (multiline). */
export function yarnrcPnpLinkerRegExp(): RegExp {
  return new RegExp(YARNRC_PNP_LINKER_ERE.split('[:space:]').join(' \\t\\r\\f\\v'), 'm');
}

/**
 * The exact commands charter_cli runs, which the hook also prints in its "Run:"
 * hints (#366). The npm form names Charter's own package, never the bare name
 * `charter` (an unrelated registry package); --no refuses to install, and
 * --fetch-retries=0 makes any registry request fail at once rather than retry.
 */
export const HOOK_CLI_COMMANDS = {
  yarn: 'yarn charter',
  yarn1: 'yarn --silent charter',
  pnpm: 'pnpm exec charter',
  npm: 'npm exec --no --no-update-notifier --fetch-retries=0 -- @stackbilt/cli',
  global: 'charter',
} as const;

/** Escape a string for the inside of a POSIX sh double-quoted word. */
function shDoubleQuoted(value: string): string {
  return value.replace(/[\\"$`]/g, ch => `\\${ch}`);
}

/**
 * Picks the package manager and how to run Charter, once per hook run (#366).
 * POSIX sh, no output. The first candidate whose marker exists and whose binary
 * is on PATH wins: the #365 verify:adf cascade with PnP in front.
 *   1. Yarn Plug'n'Play (a PNP_MARKER_FILES file, or YARNRC_PNP_LINKER_ERE in
 *      .yarnrc.yml) and yarn on PATH -> yarn
 *   2. pnpm-lock.yaml and pnpm on PATH -> pnpm
 *   3. yarn.lock and yarn on PATH -> yarn
 *   4. otherwise npm
 * CHARTER_RUN is the HOOK_CLI_COMMANDS entry for the result, and charter_cli runs
 * exactly that. Under npm: a local install (node_modules/.bin/charter or
 * charter.cmd) runs through npm exec, which then makes no registry request;
 * without one, a `charter` on PATH (a global install) runs directly; with
 * neither, CHARTER_STATE is "missing" and charter_cli runs nothing, so the hook
 * makes no network request at all.
 */
export const HOOK_CLI_RESOLVE_BLOCK = `# Charter CLI resolution (#366): run Charter with the package manager this repo uses.
${PRE_COMMIT_PM_CLI_MARKER}
CHARTER_PNP=0
if ${PNP_MARKER_FILES.map(f => `[ -f "${f}" ]`).join(' || ')}; then
  CHARTER_PNP=1
elif [ -f ".yarnrc.yml" ] && grep -E "${shDoubleQuoted(YARNRC_PNP_LINKER_ERE)}" .yarnrc.yml >/dev/null 2>&1; then
  CHARTER_PNP=1
fi
# LOCK_PM: the first candidate whose marker exists. PM: the first whose binary is also on PATH.
LOCK_PM=npm
if [ "$CHARTER_PNP" = "1" ]; then
  LOCK_PM=yarn
elif [ -f "pnpm-lock.yaml" ]; then
  LOCK_PM=pnpm
elif [ -f "yarn.lock" ]; then
  LOCK_PM=yarn
fi
PM=npm
if [ "$CHARTER_PNP" = "1" ] && command -v yarn >/dev/null 2>&1; then
  PM=yarn
elif [ -f "pnpm-lock.yaml" ] && command -v pnpm >/dev/null 2>&1; then
  PM=pnpm
elif [ -f "yarn.lock" ] && command -v yarn >/dev/null 2>&1; then
  PM=yarn
fi
# CHARTER_STATE: ok, missing (charter_cli runs nothing) or old (a 1.x CLI); set by the probe below.
CHARTER_STATE=ok
case "$PM" in
  yarn)
    CHARTER_RUN="${HOOK_CLI_COMMANDS.yarn}"
    if [ -f ".ai/manifest.adf" ]; then
      case "$(yarn --version 2>/dev/null || true)" in
        1.*) CHARTER_RUN="${HOOK_CLI_COMMANDS.yarn1}" ;;
      esac
    fi
    ;;
  pnpm) CHARTER_RUN="${HOOK_CLI_COMMANDS.pnpm}" ;;
  *)
    CHARTER_RUN="${HOOK_CLI_COMMANDS.npm}"
    if [ ! -f "node_modules/.bin/charter" ] && [ ! -f "node_modules/.bin/charter.cmd" ]; then
      if command -v charter >/dev/null 2>&1; then
        CHARTER_RUN="${HOOK_CLI_COMMANDS.global}"
      else
        CHARTER_STATE=missing
      fi
    fi
    ;;
esac
if [ "$PM" != "$LOCK_PM" ] && [ -f ".ai/manifest.adf" ]; then
  echo "[pre-commit] Warning: this repo uses $LOCK_PM, but $LOCK_PM is not on PATH; running Charter with $CHARTER_RUN (and verify:adf with $PM run) instead." >&2
  if [ "$CHARTER_PNP" = "1" ]; then
    echo "[pre-commit] Yarn Plug'n'Play needs yarn to load packages. To fix: corepack enable (or install yarn), then commit again." >&2
  fi
fi
# Runs exactly the command the hints print ($CHARTER_RUN), or nothing when Charter is missing.
charter_cli() {
  if [ "$CHARTER_STATE" = "missing" ]; then
    return 127
  fi
  $CHARTER_RUN "$@"
}
`;

/**
 * Runs `charter_cli --version` once per hook run, before any other Charter call
 * (#366), and only when .ai/manifest.adf exists. A CLI that cannot run sets
 * CHARTER_STATE=missing: the hook says so once, skips tidy, and the gate fails
 * without calling Charter again. A 1.x CLI (it ignores --staged and
 * --print-paths, so tidy would do nothing and the gate would check every file)
 * sets CHARTER_STATE=old and gets a one-time upgrade warning. A separate block
 * so that tests can replace charter_cli between the two.
 */
export const HOOK_CLI_PROBE_BLOCK = `# Charter CLI probe (#366): one --version call per hook run.
if [ -f ".ai/manifest.adf" ]; then
  CHARTER_VERSION=""
  if [ "$CHARTER_STATE" != "missing" ]; then
    CHARTER_VERSION=$(${HOOK_CLI} --version 2>/dev/null) || CHARTER_STATE=missing
  fi
  case "$CHARTER_STATE:$CHARTER_VERSION" in
    missing:*)
      echo "[pre-commit] Charter could not be run with: $CHARTER_RUN" >&2
      echo '[pre-commit] Add @stackbilt/cli as a devDependency and install it. This hook never installs Charter.' >&2
      CHARTER_SKIP_TIDY=1
      ;;
    *"charter v0."*|*"charter v1."*)
      CHARTER_STATE=old
      echo "[pre-commit] Warning: $CHARTER_RUN --version reports $CHARTER_VERSION; this hook needs @stackbilt/cli 2.x (1.x ignores --staged and --print-paths, so tidy does nothing and the gate checks every file). Install or upgrade the devDependency: @stackbilt/cli@^2." >&2
      ;;
  esac
fi
`;

export const PRE_COMMIT_HOOK_CONTENT = `#!/usr/bin/env sh
${PRE_COMMIT_HOOK_MARKER}
set -eu

${HOOK_CLI_RESOLVE_BLOCK}${HOOK_CLI_PROBE_BLOCK}
${renderHookTidyBlock(HOOK_CLI)}
# ADF evidence gate: check LOC ceilings if manifest exists
${PRE_COMMIT_GATE_SCOPE_MARKER}
${PRE_COMMIT_VERIFY_SCOPE_MARKER}
if [ -f ".ai/manifest.adf" ]; then
  echo '[pre-commit] Running ADF evidence check...'
  # --staged: vendor bloat blocks only in files this commit stages, and not in
  # the ones the tidy block skipped (TIDY_SKIPPED); doctor reports the rest as
  # INFO. Every other doctor check blocks as before. Runs with or without verify:adf.
  ${HOOK_CLI} doctor --adf-only --ci --staged --tidy-skipped "$TIDY_SKIPPED" --format text || {
    echo ''
    echo '[pre-commit] ADF verification FAILED.'
    if [ -n "$TIDY_SKIPPED" ]; then
      echo "  Run: $CHARTER_RUN doctor --adf-only --ci --staged --tidy-skipped \\"\${TIDY_SKIPPED# }\\" --format text"
    else
      echo "  Run: $CHARTER_RUN doctor --adf-only --ci --staged --format text"
    fi
    if [ "$CHARTER_STATE" = "missing" ]; then
      echo '  Charter was not run: it could not be found (see the note above).'
    fi
    exit 1
  }
  if [ -f "package.json" ] && grep -q '"verify:adf"' package.json; then
    # PM is the first package manager in the cascade above whose lockfile or
    # marker exists and whose binary is on PATH; npm otherwise (it ships with node).
    # The doctor inside verify:adf would re-check vendor bloat in every file. The
    # scoped doctor above has checked it for this commit, so verify:adf gets a
    # one-time token, matched against a file in the git dir named after it (one
    # per hook run) and removed on exit: with both, doctor reports the bloat check
    # as INFO. Every other check, and the rest of verify:adf, still blocks.
    SCOPE_TOKEN="$$-$(date +%s)"
    SCOPE_FILE=$(git rev-parse --git-path "${HOOK_SCOPED_DOCTOR_FILE}-$SCOPE_TOKEN" 2>/dev/null) || SCOPE_FILE=""
    trap 'rm -f "$SCOPE_FILE"' EXIT
    trap 'rm -f "$SCOPE_FILE"; exit 1' HUP INT TERM
    if [ -n "$SCOPE_FILE" ] && { printf '%s\\n' "$SCOPE_TOKEN" > "$SCOPE_FILE"; } 2>/dev/null; then
      ${HOOK_SCOPED_DOCTOR_ENV}="$SCOPE_TOKEN"
      export ${HOOK_SCOPED_DOCTOR_ENV}
    else
      echo "[pre-commit] Could not write the scope token in the git dir, so this time the doctor inside verify:adf checks vendor bloat in every file, as CI does."
    fi
    "$PM" run verify:adf || {
      echo ''
      echo '[pre-commit] ADF verification FAILED.'
      echo "  Run: $PM run verify:adf (outside this hook, its doctor also checks vendor bloat in files the commit leaves out)"
      exit 1
    }
  else
    ${HOOK_CLI} adf evidence --auto-measure --ci || {
      echo ''
      echo '[pre-commit] ADF verification FAILED.'
      echo "  Run: $CHARTER_RUN adf evidence --auto-measure --ci"
      if [ "$CHARTER_STATE" = "missing" ]; then
        echo '  Charter was not run: it could not be found (see the note above).'
      fi
      exit 1
    }
  fi
fi
`;

// Charter cannot write to .claude/settings.json safely — it's user-controlled.
// `print --claude` emits the config snippet for the user to paste instead.
const CLAUDE_SESSION_HOOK_CONFIG = {
  hooks: {
    UserPromptSubmit: [
      {
        matcher: '.*',
        hooks: [{ type: 'command', command: 'charter context-refresh --once' }],
      },
    ],
  },
};

export function printClaudeHookConfig(): void {
  console.log(JSON.stringify(CLAUDE_SESSION_HOOK_CONFIG, null, 2));
}

// MCP server entry shapes for each supported client (#191)
const MCP_CLIENTS = ['claude', 'codex', 'cursor'] as const;
type McpClient = typeof MCP_CLIENTS[number];

function printMcpConfig(client: McpClient, aiDir: string): void {
  const serverEntry = {
    command: 'charter',
    args: aiDir !== '.ai' ? ['serve', '--ai-dir', aiDir] : ['serve'],
  };
  const snippet = { mcpServers: { charter: serverEntry } };
  console.log(JSON.stringify(snippet, null, 2));
  if (client === 'claude') {
    console.error('  Paste the mcpServers entry into .claude/settings.json (or settings.local.json).');
  } else {
    console.error('  Paste the mcpServers entry into .mcp.json at the repo root.');
  }
}

export async function hookCommand(options: CLIOptions, args: string[]): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return EXIT_CODE.SUCCESS;
  }

  if (args[0] === 'print') {
    const wantClaude = args.includes('--claude');
    const wantMcpConfig = args.includes('--mcp-config');

    if (wantMcpConfig) {
      const clientIdx = args.indexOf('--client');
      const clientFlag = clientIdx !== -1 ? args[clientIdx + 1] : undefined;
      const client: McpClient = MCP_CLIENTS.includes(clientFlag as McpClient) ? clientFlag as McpClient : 'claude';
      const aiDir = getFlag(args, '--ai-dir') || '.ai';
      printMcpConfig(client, aiDir);
      return EXIT_CODE.SUCCESS;
    }

    if (!wantClaude) {
      throw new CLIError('hook print requires --claude or --mcp-config.');
    }
    printClaudeHookConfig();
    return EXIT_CODE.SUCCESS;
  }

  if (args[0] !== 'install') {
    throw new CLIError(`Unknown hook subcommand: ${args[0]}. Supported: install, print`);
  }

  const wantCommitMsg = args.includes('--commit-msg');
  const wantPreCommit = args.includes('--pre-commit');

  if (!wantCommitMsg && !wantPreCommit) {
    throw new CLIError('hook install requires --commit-msg and/or --pre-commit.');
  }

  const force = options.yes || args.includes('--force');
  const results: HookInstallResult[] = [];

  if (wantCommitMsg) {
    results.push(installCommitMsgHook(force));
  }
  if (wantPreCommit) {
    results.push(installPreCommitHook(force));
  }

  if (options.format === 'json') {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  } else {
    for (const result of results) {
      if (result.status === 'INSTALLED') {
        console.log(`  [ok] Installed hook at ${result.hookPath}`);
      } else {
        console.log(`  [warn] Skipped hook install at ${result.hookPath}: ${result.reason}`);
        console.log('  Re-run with --force (or --yes) to overwrite existing non-Charter hook.');
      }
    }
  }

  return EXIT_CODE.SUCCESS;
}

function installCommitMsgHook(force: boolean): HookInstallResult {
  ensureGitRepo();

  const hooksDir = resolveHooksDir();
  const hookPath = path.join(hooksDir, 'commit-msg');
  const normalizedHookPath = hookPath.replace(/\\/g, '/');
  const exists = fs.existsSync(hookPath);

  if (exists) {
    const current = fs.readFileSync(hookPath, 'utf-8');
    const managedByCharter = current.includes(COMMIT_MSG_HOOK_MARKER);
    if (!managedByCharter && !force) {
      return {
        status: 'SKIPPED',
        hookPath: normalizedHookPath,
        reason: 'existing commit-msg hook is not managed by Charter',
      };
    }
  }

  writeHookFile(hookPath, hooksDir, COMMIT_MSG_HOOK_CONTENT, exists);

  return {
    status: 'INSTALLED',
    hookPath: normalizedHookPath,
  };
}

function installPreCommitHook(force: boolean): HookInstallResult {
  ensureGitRepo();

  const hooksDir = resolveHooksDir();
  const hookPath = path.join(hooksDir, 'pre-commit');
  const normalizedHookPath = hookPath.replace(/\\/g, '/');
  const exists = fs.existsSync(hookPath);

  if (exists) {
    const current = fs.readFileSync(hookPath, 'utf-8');
    const managedByCharter = current.includes(PRE_COMMIT_HOOK_MARKER);
    if (!managedByCharter && !force) {
      return {
        status: 'SKIPPED',
        hookPath: normalizedHookPath,
        reason: 'existing pre-commit hook is not managed by Charter',
      };
    }
  }

  writeHookFile(hookPath, hooksDir, PRE_COMMIT_HOOK_CONTENT, exists);

  return {
    status: 'INSTALLED',
    hookPath: normalizedHookPath,
  };
}

/**
 * Create the hooks dir (when new) and write the hook file. Any filesystem
 * failure (missing/unwritable hooks dir, permissions) surfaces as a clean
 * CLIError rather than a raw Error escaping to the top-level handler.
 */
function writeHookFile(hookPath: string, hooksDir: string, content: string, exists: boolean): void {
  try {
    if (!exists) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }
    fs.writeFileSync(hookPath, content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CLIError(`Could not write git hook to ${hookPath.replace(/\\/g, '/')}: ${msg}`);
  }
  setExecutableBit(hookPath);
}

function resolveHooksDir(): string {
  const configuredPath = getGitConfig('core.hooksPath');
  if (configuredPath && configuredPath.trim().length > 0) {
    return path.resolve(configuredPath.trim());
  }

  let gitDir: string;
  try {
    gitDir = runGit(['rev-parse', '--git-dir']).trim();
  } catch (err) {
    throw new CLIError(`Could not resolve git hooks directory: ${getGitErrorMessage(err)}`);
  }
  return path.resolve(gitDir, 'hooks');
}

function getGitConfig(key: string): string {
  try {
    return runGit(['config', '--get', key]).trim();
  } catch {
    return '';
  }
}

function ensureGitRepo(): void {
  if (!isGitRepo()) {
    throw new CLIError('Not inside a git repository.');
  }
}

function setExecutableBit(targetPath: string): void {
  try {
    fs.chmodSync(targetPath, 0o755);
  } catch {
    // best-effort on non-posix filesystems
  }
}

function printHelp(): void {
  console.log('');
  console.log('  charter hook');
  console.log('');
  console.log('  Usage:');
  console.log('    charter hook install --commit-msg [--force]');
  console.log('    charter hook install --pre-commit [--force]');
  console.log('    charter hook print --claude');
  console.log('    charter hook print --mcp-config [--client claude|codex|cursor] [--ai-dir <dir>]');
  console.log('');
  console.log('  --commit-msg: Install a git commit-msg hook that normalizes Governed-By and');
  console.log('  Resolves-Request trailers using git interpret-trailers, and rejects a message with');
  console.log('  neither whenever charter validate --ci would fail it (same .charter/config.json defaults).');
  console.log('');
  console.log('  --pre-commit: Install a git pre-commit hook that auto-tidies the staged vendor config');
  console.log('  files (CLAUDE.md, .cursorrules, AGENTS.md, etc.) and runs ADF evidence checks.');
  console.log('  Bloat is routed to .adf modules; only the files tidy wrote are re-staged. A vendor file');
  console.log('  with unstaged changes is skipped. The gate (doctor --staged) blocks on vendor bloat only in');
  console.log('  staged files tidy did not skip. If package.json has a verify:adf script, it runs next,');
  console.log('  with the package manager below, and its doctor leaves vendor bloat to that scoped check.');
  console.log('  Package manager: the first match of (1) Yarn Plug\'n\'Play (.pnp.cjs, .pnp.js, or .yarnrc.yml nodeLinker: pnp)');
  console.log('  with yarn on PATH, (2) pnpm-lock.yaml with pnpm, (3) yarn.lock with yarn, (4) npm.');
  console.log(`  Charter then runs as: ${HOOK_CLI_COMMANDS.yarn} (${HOOK_CLI_COMMANDS.yarn1} on Yarn 1),`);
  console.log(`  ${HOOK_CLI_COMMANDS.pnpm}, or ${HOOK_CLI_COMMANDS.npm}`);
  console.log(`  (npm, with node_modules/.bin/charter; else a global ${HOOK_CLI_COMMANDS.global} on PATH).`);
  console.log('  The hook never installs Charter. Re-run this command to upgrade an older hook.');
  console.log('  Skip tidy with CHARTER_SKIP_TIDY=1. Only gates when .ai/manifest.adf exists.');
  console.log('');
  console.log('  print --claude: Print the Claude Code session hook config snippet to stdout.');
  console.log('  Paste into .claude/settings.json → hooks.UserPromptSubmit to auto-refresh');
  console.log('  context at session start so charter_context returns live state.');
  console.log('');
  console.log('  print --mcp-config: Print the MCP server JSON config snippet for wiring');
  console.log('  charter serve into an AI client. Defaults to --client claude.');
  console.log('  --client claude  → mcpServers entry for .claude/settings.json');
  console.log('  --client codex   → mcpServers entry for .mcp.json');
  console.log('  --client cursor  → mcpServers entry for .mcp.json');
  console.log('  --ai-dir <dir>   → pass-through for non-default .ai dir locations.');
  console.log('');
}

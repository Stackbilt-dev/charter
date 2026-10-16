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

/**
 * The vendor tidy block of the pre-commit hook (#320). {CLI} is `npx charter`
 * here and `node packages/cli/dist/bin.js` in the repo's own .githooks/pre-commit;
 * that is the only difference allowed between the two, and hook.test.ts checks it.
 * POSIX sh: no arrays, no [[, no jq. Works under set -eu and set -euo pipefail:
 * greps fed by a pipe read all their input (no -q), so under pipefail an early
 * exit can never SIGPIPE the writer and turn a match into a miss.
 */
export const HOOK_TIDY_BLOCK_TEMPLATE = `# Vendor file auto-tidy (#320): tidy only the staged vendor files, then re-stage only the files tidy wrote.
${PRE_COMMIT_SCOPE_MARKER}
# Skip with CHARTER_SKIP_TIDY=1
# This block never fails the commit; the ADF evidence gate after it may.
# TIDY_SKIPPED lists the vendor files it skipped, so the gate can say why it blocks.
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
        echo "[pre-commit] If it carries bloat, the ADF evidence gate may still block this commit. Ways out: stage or stash the unstaged changes; or run: charter adf tidy --source $vf, then git add the result; or bypass the hooks with git commit --no-verify."
        TIDY_SKIPPED="$TIDY_SKIPPED $vf"
        continue
      fi
      SOURCES="$SOURCES --source $vf"
      NAMES="$NAMES $vf"
    fi
  done

  if [ -n "$SOURCES" ]; then
    echo "[pre-commit] Checking staged vendor files:$NAMES"
    PLAN=$({CLI} adf tidy --dry-run --print-paths $SOURCES 2>/dev/null) || { echo "[pre-commit] adf tidy --dry-run failed; skipping auto-tidy."; PLAN=""; }
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
        echo "[pre-commit] The ADF evidence gate may still block this commit while$NAMES carries bloat. Ways out: stage or stash that work; or run: charter adf tidy$SOURCES, then git add the result; or bypass the hooks with git commit --no-verify."
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
    else
      echo "[pre-commit] Vendor config files are clean."
    fi
  fi
fi
`;

/** The tidy block with {CLI} replaced by the command that runs Charter. */
export function renderHookTidyBlock(cli: string): string {
  return HOOK_TIDY_BLOCK_TEMPLATE.split('{CLI}').join(cli);
}

export const PRE_COMMIT_HOOK_CONTENT = `#!/usr/bin/env sh
${PRE_COMMIT_HOOK_MARKER}
set -eu

${renderHookTidyBlock('npx charter')}
# ADF evidence gate: check LOC ceilings if manifest exists
if [ -f ".ai/manifest.adf" ]; then
  echo '[pre-commit] Running ADF evidence check...'
  if [ -f "package.json" ] && grep -q '"verify:adf"' package.json; then
    pnpm run verify:adf || {
      echo ''
      echo '[pre-commit] ADF verification FAILED.'
      echo '  Run: pnpm run verify:adf'
      exit 1
    }
  else
    npx charter doctor --adf-only --ci --format text && npx charter adf evidence --auto-measure --ci || {
      echo ''
      # Link a bloat failure to the tidy skip that caused it (#320).
      set -f
      for f in $TIDY_SKIPPED; do
        n=$(npx charter adf tidy --dry-run --format json --source "$f" 2>/dev/null | sed -n 's/^  "totalExtracted": \\([0-9][0-9]*\\),*$/\\1/p') || n=""
        if [ -n "$n" ] && [ "$n" -gt 0 ]; then
          echo "[pre-commit] Blocked because $f still carries $n item(s) beyond its pointer: auto-tidy was skipped for it in this commit. See the [pre-commit] lines above for the ways out."
        fi
      done
      set +f
      echo '[pre-commit] ADF verification FAILED.'
      echo '  Run: npx charter doctor --adf-only --ci --format text'
      echo '   && npx charter adf evidence --auto-measure --ci'
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
  console.log('  with unstaged changes is skipped. Re-run this command to upgrade an older hook.');
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

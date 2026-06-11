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

interface HookInstallResult {
  status: 'INSTALLED' | 'SKIPPED';
  hookPath: string;
  reason?: string;
}

const COMMIT_MSG_HOOK_MARKER = '# Managed by Charter: commit-msg trailer normalizer';
const COMMIT_MSG_HOOK_CONTENT = `#!/usr/bin/env sh
${COMMIT_MSG_HOOK_MARKER}
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
`;

const PRE_COMMIT_HOOK_MARKER = '# Managed by Charter: pre-commit evidence gate';
const PRE_COMMIT_HOOK_CONTENT = `#!/usr/bin/env sh
${PRE_COMMIT_HOOK_MARKER}
set -eu

# Vendor file auto-tidy: extract bloat from staged vendor config files
# Skip with CHARTER_SKIP_TIDY=1
if [ "\${CHARTER_SKIP_TIDY:-0}" != "1" ] && [ -f ".ai/manifest.adf" ]; then
  VENDOR_FILES="CLAUDE.md .cursorrules agents.md AGENTS.md GEMINI.md copilot-instructions.md"
  STAGED_VENDORS=""
  for vf in $VENDOR_FILES; do
    if git diff --cached --name-only | grep -qx "$vf"; then
      STAGED_VENDORS="$STAGED_VENDORS $vf"
    fi
  done

  if [ -n "$STAGED_VENDORS" ]; then
    echo "[pre-commit] Checking vendor config files:\$STAGED_VENDORS"
    TIDY_OUTPUT=\$(npx charter adf tidy --dry-run --format json 2>/dev/null || echo '{}')
    EXTRACTED=\$(echo "\$TIDY_OUTPUT" | grep -o '"totalExtracted": *[0-9][0-9]*' | grep -o '[0-9][0-9]*' || echo "0")

    if [ "\$EXTRACTED" -gt 0 ] 2>/dev/null; then
      echo "[pre-commit] Found \$EXTRACTED items beyond thin pointer — auto-tidying..."
      npx charter adf tidy 2>/dev/null

      for vf in \$STAGED_VENDORS; do
        if [ -f "\$vf" ]; then
          git add "\$vf"
        fi
      done
      git add .ai/*.adf 2>/dev/null || true

      echo "[pre-commit] Vendor files tidied and re-staged."
    else
      echo "[pre-commit] Vendor config files are clean."
    fi
  fi
fi

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

export async function hookCommand(options: CLIOptions, args: string[]): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return EXIT_CODE.SUCCESS;
  }

  if (args[0] === 'print') {
    const wantClaude = args.includes('--claude');
    if (!wantClaude) {
      throw new CLIError('hook print requires --claude.');
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
  console.log('');
  console.log('  --commit-msg: Install a git commit-msg hook that normalizes Governed-By and');
  console.log('  Resolves-Request trailers using git interpret-trailers.');
  console.log('');
  console.log('  --pre-commit: Install a git pre-commit hook that auto-tidies vendor config files');
  console.log('  (CLAUDE.md, .cursorrules, agents.md, etc.) and runs ADF evidence checks.');
  console.log('  Vendor file bloat is extracted, routed to .adf modules, and re-staged.');
  console.log('  Skip tidy with CHARTER_SKIP_TIDY=1. Only gates when .ai/manifest.adf exists.');
  console.log('');
  console.log('  print --claude: Print the Claude Code session hook config snippet to stdout.');
  console.log('  Paste into .claude/settings.json → hooks.UserPromptSubmit to auto-refresh');
  console.log('  context at session start so charter_context returns live state.');
  console.log('');
}

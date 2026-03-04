/**
 * Integration tests: real pre-commit hook simulation
 *
 * v3 scenario — sets up actual git repos with hooks, stages bloated
 * vendor files, runs git commit, and verifies the hook auto-tidies
 * and re-stages corrected files.
 *
 * These tests are slower (real git operations) but validate the full
 * end-to-end contract that the pre-commit hook provides.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// ============================================================================
// Fixture Helpers
// ============================================================================

const tempDirs: string[] = [];
const CLI_BIN = path.resolve(__dirname, '../../../dist/bin.js');

function makeTempDir(label: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `charter-integ-hook-${label}-`));
  tempDirs.push(tmp);
  return tmp;
}

function git(tmp: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: tmp,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' },
  }).trim();
}

/**
 * Scaffold a full git repo with ADF, a pre-commit hook that uses
 * the built CLI, and an initial clean commit.
 */
function writeHookFixtureRepo(tmp: string): void {
  // Init git
  git(tmp, 'init');
  git(tmp, 'config', 'user.email', 'test@test.com');
  git(tmp, 'config', 'user.name', 'Test');

  // ADF structure
  fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.charter'), { recursive: true });

  fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), `ADF: 0.1

📦 DEFAULT_LOAD:
  - core.adf
  - state.adf

📂 ON_DEMAND:
  - backend.adf (Triggers on: database, API, migration)

💰 BUDGET:
  MAX_TOKENS: 4000
`);

  fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), `ADF: 0.1

📐 RULES:
  - All changes require tests
`);

  fs.writeFileSync(path.join(tmp, '.ai', 'state.adf'), 'ADF: 0.1\n\n📋 STATE:\n  - CURRENT: testing\n');

  fs.writeFileSync(path.join(tmp, '.ai', 'backend.adf'), `ADF: 0.1

📐 RULES:
  - Database access through repository pattern
`);

  // Clean thin pointer
  fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), `# CLAUDE.md

> **DO NOT add rules, constraints, or context to this file.**
> This file is auto-managed by Charter. All project rules live in \`.ai/\`.
> New rules should be added to the appropriate \`.ai/*.adf\` module.
> See \`.ai/manifest.adf\` for the module routing manifest.

## Environment
- Node 20
`);

  // Pre-commit hook — simplified version that just runs tidy
  const hookDir = path.join(tmp, '.githooks');
  fs.mkdirSync(hookDir, { recursive: true });

  // Build hook script avoiding JS template ${} expansion issues
  // by using string concatenation for the CLI_BIN path
  const hookScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Vendor file auto-tidy',
    'if [ "${CHARTER_SKIP_TIDY:-0}" != "1" ] && [ -f ".ai/manifest.adf" ]; then',
    '  VENDOR_FILES="CLAUDE.md .cursorrules agents.md AGENTS.md GEMINI.md copilot-instructions.md"',
    '  STAGED_VENDORS=""',
    '  for vf in $VENDOR_FILES; do',
    '    if git diff --cached --name-only | grep -qx "$vf"; then',
    '      STAGED_VENDORS="$STAGED_VENDORS $vf"',
    '    fi',
    '  done',
    '',
    '  if [ -n "$STAGED_VENDORS" ]; then',
    `    TIDY_OUTPUT=$(node ${CLI_BIN} adf tidy --dry-run --format json 2>/dev/null || echo '{}')`,
    '    EXTRACTED=$(echo "$TIDY_OUTPUT" | grep -o \'"totalExtracted": *[0-9][0-9]*\' | grep -o \'[0-9][0-9]*\' || echo "0")',
    '',
    '    if [ "$EXTRACTED" -gt 0 ] 2>/dev/null; then',
    `      node ${CLI_BIN} adf tidy 2>/dev/null`,
    '',
    '      for vf in $STAGED_VENDORS; do',
    '        if [ -f "$vf" ]; then',
    '          git add "$vf"',
    '        fi',
    '      done',
    '      git add .ai/*.adf 2>/dev/null || true',
    '    fi',
    '  fi',
    'fi',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(hookDir, 'pre-commit'), hookScript);
  fs.chmodSync(path.join(hookDir, 'pre-commit'), 0o755);

  // Point git to custom hooks dir
  git(tmp, 'config', 'core.hooksPath', '.githooks');

  // Initial commit with clean state
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-m', 'initial');
}

// ============================================================================
// Lifecycle
// ============================================================================

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// v3 Pre-commit Hook Simulation
// ============================================================================

describe('pre-commit hook auto-tidy (integration)', () => {

  it('auto-tidies bloated CLAUDE.md during git commit', { timeout: 30000 }, () => {
    const tmp = makeTempDir('hook-tidy');
    writeHookFixtureRepo(tmp);

    // Inject bloat into CLAUDE.md
    const bloatedContent = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8') + `
## Architecture
- Layered architecture with repository pattern
- All database queries go through the repository layer
- API endpoints validate input before processing

## Database Rules
- All database migrations must be reversible
- Schema changes require migration scripts
`;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), bloatedContent);

    // Stage and commit — hook should auto-tidy
    git(tmp, 'add', 'CLAUDE.md');
    const commitOutput = git(tmp, 'commit', '-m', 'add bloated content');

    // Verify commit succeeded
    expect(commitOutput).toContain('add bloated content');

    // Verify CLAUDE.md was tidied (restored to thin pointer)
    const finalContent = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8');
    expect(finalContent).toContain('DO NOT add rules');
    expect(finalContent).not.toContain('## Architecture');
    expect(finalContent).not.toContain('## Database Rules');
    expect(finalContent).toContain('## Environment');
  });

  it('passes through cleanly when CLAUDE.md has no bloat', { timeout: 30000 }, () => {
    const tmp = makeTempDir('hook-clean');
    writeHookFixtureRepo(tmp);

    // Make a trivial change to CLAUDE.md (add env item, not bloat)
    const content = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), content.trimEnd() + '\n- pnpm 9\n');

    git(tmp, 'add', 'CLAUDE.md');
    const commitOutput = git(tmp, 'commit', '-m', 'add env item');

    expect(commitOutput).toContain('add env item');

    // CLAUDE.md should be unchanged (env addition preserved)
    const finalContent = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8');
    expect(finalContent).toContain('DO NOT add rules');
  });

  it('skips tidy when CHARTER_SKIP_TIDY=1 is set', { timeout: 30000 }, () => {
    const tmp = makeTempDir('hook-skip');
    writeHookFixtureRepo(tmp);

    // Inject bloat
    const bloatedContent = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8') + `
## Architecture
- Layered architecture pattern
`;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), bloatedContent);

    // Stage and commit with skip flag
    git(tmp, 'add', 'CLAUDE.md');
    execFileSync('git', ['commit', '-m', 'bloat preserved'], {
      cwd: tmp,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CHARTER_SKIP_TIDY: '1',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });

    // Bloat should still be there (tidy was skipped)
    const finalContent = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8');
    expect(finalContent).toContain('## Architecture');
  });

  it('re-stages modified .adf modules after tidy', { timeout: 30000 }, () => {
    const tmp = makeTempDir('hook-restage');
    writeHookFixtureRepo(tmp);

    // Inject bloat with trigger keywords that route to backend.adf
    const bloatedContent = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8') + `
## Database Rules
- All database migrations must be reversible
- Schema changes require migration scripts
- API rate limiting applies to all database endpoints
`;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), bloatedContent);

    // Record pre-commit state of backend.adf
    const beforeBackend = fs.readFileSync(path.join(tmp, '.ai', 'backend.adf'), 'utf-8');

    git(tmp, 'add', 'CLAUDE.md');
    git(tmp, 'commit', '-m', 'auto-routed content');

    // Verify the committed CLAUDE.md is clean
    const committedClaude = execSync(
      'git show HEAD:CLAUDE.md',
      { cwd: tmp, encoding: 'utf-8' },
    );
    expect(committedClaude).toContain('DO NOT add rules');
    expect(committedClaude).not.toContain('## Database Rules');

    // Verify .adf modules were modified and committed
    // (the tidy should have routed content somewhere)
    const afterBackend = fs.readFileSync(path.join(tmp, '.ai', 'backend.adf'), 'utf-8');
    const coreAfter = fs.readFileSync(path.join(tmp, '.ai', 'core.adf'), 'utf-8');

    // At least one module should have grown
    const anyModuleGrew = afterBackend.length > beforeBackend.length ||
      coreAfter.includes('migration') || coreAfter.includes('database') ||
      afterBackend.includes('migration') || afterBackend.includes('database');
    expect(anyModuleGrew).toBe(true);
  });
});

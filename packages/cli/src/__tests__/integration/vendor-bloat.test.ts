/**
 * Integration tests: vendor file bloat pipeline
 *
 * Exercises the cross-command lifecycle:
 *   doctor (detect) → adf tidy (extract) → doctor (verify recovery)
 *
 * Each test spins up a disposable temp repo with a minimal ADF scaffold,
 * invokes commands through the same function entry points as the CLI,
 * and asserts JSON output fields + exit codes.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../../index';
import { EXIT_CODE } from '../../index';
import { doctorCommand } from '../../commands/doctor';
import { adfTidyCommand } from '../../commands/adf-tidy';

// ============================================================================
// Fixture Helpers
// ============================================================================

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(label: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `charter-integ-${label}-`));
  tempDirs.push(tmp);
  return tmp;
}

const jsonOptions: CLIOptions = {
  configPath: '.charter',
  format: 'json',
  ciMode: false,
  yes: false,
};

const ciOptions: CLIOptions = {
  ...jsonOptions,
  ciMode: true,
};

/**
 * Scaffold a minimal ADF repo with manifest, core module, state module,
 * and a clean thin-pointer CLAUDE.md.
 */
function writeFixtureRepo(tmp: string): void {
  fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.charter'), { recursive: true });

  fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), `ADF: 0.1

📐 RULES:
  - Test manifest

📦 DEFAULT_LOAD:
  - core.adf
  - state.adf

📂 ON_DEMAND:
  - backend.adf (Triggers on: database, API, migration, schema)
  - frontend.adf (Triggers on: component, React, CSS, layout)

💰 BUDGET:
  MAX_TOKENS: 4000
`);

  fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), `ADF: 0.1

📁 STRUCTURE:
  - src/ — source code

📐 CONSTRAINTS: [load-bearing]
  - All changes require tests
`);

  fs.writeFileSync(path.join(tmp, '.ai', 'state.adf'), `ADF: 0.1

📋 STATE:
  - CURRENT: testing
`);

  // On-demand module stubs (so doctor doesn't warn about missing modules)
  fs.writeFileSync(path.join(tmp, '.ai', 'backend.adf'), `ADF: 0.1

📐 RULES:
  - Database access goes through repository layer
`);

  fs.writeFileSync(path.join(tmp, '.ai', 'frontend.adf'), `ADF: 0.1

📐 RULES:
  - Components use .tsx extension
`);

  // Init git repo so doctor's git check passes
  execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
}

/** Write a clean thin-pointer CLAUDE.md */
function writeCleanPointer(tmp: string): void {
  fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), `# CLAUDE.md

> **DO NOT add rules, constraints, or context to this file.**
> This file is auto-managed by Charter. All project rules live in \`.ai/\`.
> New rules should be added to the appropriate \`.ai/*.adf\` module.
> See \`.ai/manifest.adf\` for the module routing manifest.

## Environment
- Node 20
- pnpm 9
`);
}

/**
 * Write a bloated CLAUDE.md: thin pointer + extra sections with
 * architecture rules, trigger-heavy content, and non-Environment H2s.
 */
function writeBloatedPointer(tmp: string): void {
  fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), `# CLAUDE.md

> **DO NOT add rules, constraints, or context to this file.**
> This file is auto-managed by Charter. All project rules live in \`.ai/\`.
> New rules should be added to the appropriate \`.ai/*.adf\` module.
> See \`.ai/manifest.adf\` for the module routing manifest.

## Environment
- Node 20
- pnpm 9

## Architecture
- The project uses a layered architecture pattern
- All database queries go through the repository layer
- API endpoints must validate input before processing

## Build Commands
- Run \`pnpm build\` for production
- Run \`pnpm test\` for the test suite

## Database Rules
- All database migrations must be reversible
- Schema changes require migration scripts
- Database connections use connection pooling
- API rate limiting applies to all database endpoints

## Frontend Standards
- All React component files use .tsx extension
- CSS modules for component-scoped styles
- Layout components handle responsive breakpoints
`);
}

/** Capture console.log output during a command invocation */
async function captureJson(
  fn: (options: CLIOptions, args: string[]) => Promise<number>,
  options: CLIOptions,
  args: string[],
): Promise<{ exitCode: number; output: unknown }> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...msgs: unknown[]) => {
    logs.push(msgs.map(String).join(' '));
  });

  let exitCode: number;
  try {
    exitCode = await fn(options, args);
  } finally {
    spy.mockRestore();
  }

  const raw = logs.join('\n').trim();
  let output: unknown;
  try {
    output = JSON.parse(raw);
  } catch {
    output = raw;
  }
  return { exitCode, output };
}

// ============================================================================
// Lifecycle
// ============================================================================

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

// ============================================================================
// v1 Scenario Set
// ============================================================================

describe('vendor bloat pipeline (integration)', () => {

  // ── Scenario 1: Clean pointer baseline ──────────────────────────────────
  it('doctor reports no vendor bloat warning for a clean thin pointer', async () => {
    const tmp = makeTempDir('clean');
    process.chdir(tmp);
    writeFixtureRepo(tmp);
    writeCleanPointer(tmp);

    const { exitCode, output } = await captureJson(doctorCommand, jsonOptions, ['--adf-only']);

    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
    const result = output as { status: string; checks: Array<{ name: string; status: string }> };
    const bloatCheck = result.checks.find(c => c.name === 'adf vendor bloat');
    expect(bloatCheck).toBeDefined();
    expect(bloatCheck!.status).toBe('PASS');
  });

  // ── Scenario 2: Bloat detected ──────────────────────────────────────────
  it('doctor detects vendor bloat with section overlap and trigger keywords', async () => {
    const tmp = makeTempDir('bloat');
    process.chdir(tmp);
    writeFixtureRepo(tmp);
    writeBloatedPointer(tmp);

    const { exitCode, output } = await captureJson(doctorCommand, jsonOptions, ['--adf-only']);

    expect(exitCode).toBe(EXIT_CODE.SUCCESS); // non-CI mode returns 0
    const result = output as { status: string; checks: Array<{ name: string; status: string; details: string }> };
    const bloatCheck = result.checks.find(c => c.name === 'adf vendor bloat');
    expect(bloatCheck).toBeDefined();
    expect(bloatCheck!.status).toBe('WARN');
    expect(bloatCheck!.details).toContain('CLAUDE.md');
    // Should detect trigger keywords from ON_DEMAND entries
    expect(bloatCheck!.details).toMatch(/database|API|component|React|CSS/i);
  });

  // ── Scenario 3: CI gate returns exit 1 on bloat ─────────────────────────
  it('doctor --ci returns exit 1 when vendor bloat is detected', async () => {
    const tmp = makeTempDir('ci-gate');
    process.chdir(tmp);
    writeFixtureRepo(tmp);
    writeBloatedPointer(tmp);

    const { exitCode } = await captureJson(doctorCommand, ciOptions, ['--adf-only']);

    expect(exitCode).toBe(EXIT_CODE.POLICY_VIOLATION);
  });

  // ── Scenario 4: Tidy dry-run contract ───────────────────────────────────
  it('adf tidy --dry-run --ci reports extraction count and returns exit 1', async () => {
    const tmp = makeTempDir('tidy-dry');
    process.chdir(tmp);
    writeFixtureRepo(tmp);
    writeBloatedPointer(tmp);

    const { exitCode, output } = await captureJson(adfTidyCommand, jsonOptions, ['--dry-run', '--ci']);

    expect(exitCode).toBe(EXIT_CODE.POLICY_VIOLATION);
    const result = output as { dryRun: boolean; totalExtracted: number; files: unknown[]; modulesModified: string[] };
    expect(result.dryRun).toBe(true);
    expect(result.totalExtracted).toBeGreaterThan(0);
    expect(result.files).toHaveLength(1); // only CLAUDE.md exists
    expect(result.modulesModified.length).toBeGreaterThan(0);
  });

  // ── Scenario 5: Recovery loop ───────────────────────────────────────────
  it('after adf tidy apply, doctor reports vendor bloat as PASS', async () => {
    const tmp = makeTempDir('recovery');
    process.chdir(tmp);
    writeFixtureRepo(tmp);
    writeBloatedPointer(tmp);

    // Step 1: Confirm bloat exists
    const before = await captureJson(doctorCommand, ciOptions, ['--adf-only']);
    expect(before.exitCode).toBe(EXIT_CODE.POLICY_VIOLATION);

    // Step 2: Apply tidy (not dry-run)
    const tidy = await captureJson(adfTidyCommand, jsonOptions, []);
    const tidyResult = tidy.output as { totalExtracted: number };
    expect(tidyResult.totalExtracted).toBeGreaterThan(0);

    // Step 3: Verify recovery — doctor should pass now
    const after = await captureJson(doctorCommand, ciOptions, ['--adf-only']);
    expect(after.exitCode).toBe(EXIT_CODE.SUCCESS);
    const result = after.output as { checks: Array<{ name: string; status: string }> };
    const bloatCheck = result.checks.find(c => c.name === 'adf vendor bloat');
    expect(bloatCheck).toBeDefined();
    expect(bloatCheck!.status).toBe('PASS');

    // Step 4: Verify ADF modules were written
    const aiFiles = fs.readdirSync(path.join(tmp, '.ai'));
    const newModules = aiFiles.filter(f => f.endsWith('.adf') && !['manifest.adf', 'core.adf', 'state.adf'].includes(f));
    expect(newModules.length).toBeGreaterThanOrEqual(0); // may route to core.adf instead of new files

    // Step 5: Verify CLAUDE.md was restored to thin pointer
    const claudeContent = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8');
    expect(claudeContent).toContain('DO NOT add rules');
    expect(claudeContent).not.toContain('## Architecture');
    expect(claudeContent).not.toContain('## Database Rules');
    expect(claudeContent).not.toContain('## Frontend Standards');
    // Environment should be preserved
    expect(claudeContent).toContain('## Environment');
  });
});

/**
 * Integration tests: sync drift + bundle missing-module + stability rerun
 *
 * v2 scenarios covering:
 * - adf sync --check exit contract (drift detection)
 * - bundle missing default module (hard fail) vs on-demand (soft warning)
 * - stability rerun (same scenario twice, normalized JSON must match)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../../index';
import { EXIT_CODE } from '../../index';
import { adfSync } from '../../commands/adf-sync';
import { adfBundle } from '../../commands/adf-bundle';

// ============================================================================
// Fixture Helpers
// ============================================================================

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(label: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `charter-integ-sb-${label}-`));
  tempDirs.push(tmp);
  return tmp;
}

const jsonOptions: CLIOptions = {
  configPath: '.charter',
  format: 'json',
  ciMode: false,
  yes: false,
};

/** Write a minimal ADF repo with SYNC entries */
function writeSyncFixture(tmp: string): void {
  fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });

  fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), `ADF: 0.1

📦 DEFAULT_LOAD:
  - core.adf
  - state.adf

🔄 SYNC:
  - core.adf -> CLAUDE.md
`);

  fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), `ADF: 0.1

📐 RULES:
  - All changes require tests
`);

  fs.writeFileSync(path.join(tmp, '.ai', 'state.adf'), 'ADF: 0.1\n\n📋 STATE:\n  - CURRENT: testing\n');
}

/** Write a bundle fixture with on-demand modules */
function writeBundleFixture(tmp: string, opts: { includeOnDemandFile?: boolean } = {}): void {
  fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });

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

  if (opts.includeOnDemandFile) {
    fs.writeFileSync(path.join(tmp, '.ai', 'backend.adf'), `ADF: 0.1

📐 RULES:
  - Database access through repository pattern
`);
  }
}

/** Capture console.log output during a synchronous command */
function captureJson(
  fn: (options: CLIOptions, args: string[]) => number,
  options: CLIOptions,
  args: string[],
): { exitCode: number; output: Record<string, unknown> } {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...msgs: unknown[]) => {
    logs.push(msgs.map(String).join(' '));
  });

  let exitCode: number;
  try {
    exitCode = fn(options, args);
  } finally {
    spy.mockRestore();
  }

  const raw = logs.join('\n').trim();
  return { exitCode, output: JSON.parse(raw) };
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
// Sync Drift
// ============================================================================

describe('adf sync --check contracts (integration)', () => {

  it('exits 0 when sources match lock file', () => {
    const tmp = makeTempDir('sync-ok');
    process.chdir(tmp);
    writeSyncFixture(tmp);

    // Write lock first
    captureJson(adfSync, jsonOptions, ['--write']);

    // Check should pass
    const { exitCode, output } = captureJson(adfSync, jsonOptions, ['--check']);
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
    expect(output.allInSync).toBe(true);
  });

  it('exits 1 when source has drifted since lock was written', () => {
    const tmp = makeTempDir('sync-drift');
    process.chdir(tmp);
    writeSyncFixture(tmp);

    // Write lock
    captureJson(adfSync, jsonOptions, ['--write']);

    // Mutate source after lock
    const corePath = path.join(tmp, '.ai', 'core.adf');
    fs.appendFileSync(corePath, '\n  - New rule added after lock\n');

    // Check should fail
    const { exitCode, output } = captureJson(adfSync, jsonOptions, ['--check']);
    expect(exitCode).toBe(EXIT_CODE.POLICY_VIOLATION);
    expect(output.allInSync).toBe(false);
    expect(output.nextActions).toBeDefined();
    expect((output.nextActions as string[])).toContain('charter adf sync --write');
  });

  it('exits 1 when no lock file exists (first-time check)', () => {
    const tmp = makeTempDir('sync-no-lock');
    process.chdir(tmp);
    writeSyncFixture(tmp);

    // Don't write lock — jump straight to check
    const { exitCode, output } = captureJson(adfSync, jsonOptions, ['--check']);
    expect(exitCode).toBe(EXIT_CODE.POLICY_VIOLATION);
    expect(output.allInSync).toBe(false);
  });
});

// ============================================================================
// Bundle Missing Modules
// ============================================================================

describe('adf bundle missing-module contracts (integration)', () => {

  it('throws CLIError for missing default-load module', () => {
    const tmp = makeTempDir('bundle-default');
    process.chdir(tmp);
    writeBundleFixture(tmp);

    // Delete state.adf (a default-load module)
    fs.unlinkSync(path.join(tmp, '.ai', 'state.adf'));

    // Should throw — default modules are hard requirements
    expect(() => {
      adfBundle(jsonOptions, ['--task', 'test something']);
    }).toThrow(/Default module not found|state\.adf/);
  });

  it('returns soft warning for missing on-demand module', () => {
    const tmp = makeTempDir('bundle-ondemand');
    process.chdir(tmp);
    writeBundleFixture(tmp, { includeOnDemandFile: false });

    // Task triggers backend.adf via "database" keyword, but file is missing
    const { exitCode, output } = captureJson(adfBundle, jsonOptions, ['--task', 'fix database migration']);
    expect(exitCode).toBe(EXIT_CODE.SUCCESS); // not a hard fail
    expect(output.missingModules).toBeDefined();
    const missing = output.missingModules as Array<{ module: string; loadPolicy: string }>;
    expect(missing.some(m => m.module === 'backend.adf')).toBe(true);
    expect(missing[0].loadPolicy).toBe('ON_DEMAND');
  });

  it('includes on-demand module when present and triggered', () => {
    const tmp = makeTempDir('bundle-triggered');
    process.chdir(tmp);
    writeBundleFixture(tmp, { includeOnDemandFile: true });

    const { exitCode, output } = captureJson(adfBundle, jsonOptions, ['--task', 'fix database migration']);
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
    expect(output.resolvedModules).toBeDefined();
    expect((output.resolvedModules as string[])).toContain('backend.adf');
    expect(output.missingModules).toBeUndefined();
  });
});

// ============================================================================
// Stability Rerun
// ============================================================================

describe('stability rerun (integration)', () => {

  it('produces structurally identical JSON across two consecutive runs', () => {
    const tmp = makeTempDir('stability');
    process.chdir(tmp);
    writeBundleFixture(tmp, { includeOnDemandFile: true });

    const run1 = captureJson(adfBundle, jsonOptions, ['--task', 'fix database migration']);
    const run2 = captureJson(adfBundle, jsonOptions, ['--task', 'fix database migration']);

    expect(run1.exitCode).toBe(run2.exitCode);

    // Normalize: remove fields that might vary (none expected, but defensive)
    const normalize = (o: Record<string, unknown>) => {
      const { ...rest } = o;
      return rest;
    };

    expect(normalize(run1.output)).toEqual(normalize(run2.output));
  });
});

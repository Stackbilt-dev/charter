/**
 * Integration tests: adf evidence --ci exit code contracts
 *
 * Validates the constraint evaluation pipeline that gates pre-commit
 * and CI pipelines: ceiling breach (exit 1), boundary warn (exit 0),
 * stale baseline field assertions.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../../index';
import { EXIT_CODE } from '../../index';
import { adfEvidence } from '../../commands/adf-evidence';

// ============================================================================
// Fixture Helpers
// ============================================================================

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(label: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `charter-integ-ev-${label}-`));
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
 * Build a fixture with a metric at a specific value/ceiling relationship.
 *
 * @param tmp - temp directory
 * @param actualLines - number of lines in the measured file
 * @param baseline - baseline value stored in core.adf metric
 * @param ceiling - ceiling value stored in core.adf metric
 */
function writeEvidenceFixture(
  tmp: string,
  actualLines: number,
  baseline: number,
  ceiling: number,
): void {
  fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });

  fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), `ADF: 0.1

📦 DEFAULT_LOAD:
  - core.adf
  - state.adf

💰 BUDGET:
  MAX_TOKENS: 4000

📊 METRICS:
  APP_LOC: src/app.ts
`);

  fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), `ADF: 0.1

📊 METRICS:
  app_loc: ${baseline} / ${ceiling} [lines]
`);

  fs.writeFileSync(path.join(tmp, '.ai', 'state.adf'), 'ADF: 0.1\n\n📋 STATE:\n  - CURRENT: testing\n');

  // Write a source file with exactly `actualLines` lines
  const content = Array.from({ length: actualLines }, (_, i) => `// line ${i + 1}`).join('\n') + '\n';
  fs.writeFileSync(path.join(tmp, 'src', 'app.ts'), content);
}

/** Capture console.log output during a command invocation */
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
// v1.1 Evidence Contract Tests
// ============================================================================

describe('adf evidence CI contracts (integration)', () => {

  // ── Ceiling breach: measured > ceiling → fail, CI exit 1 ────────────────
  // Note: split('\n').length on a file ending with \n counts lines+1,
  // so writing N lines produces a measured value of N+1.
  it('exits 1 in CI mode when measured value exceeds ceiling', () => {
    const tmp = makeTempDir('breach');
    process.chdir(tmp);
    // 160 lines → measured 161 > ceiling 150
    writeEvidenceFixture(tmp, /* actual */ 160, /* baseline */ 100, /* ceiling */ 150);

    const { exitCode, output } = captureJson(adfEvidence, ciOptions, ['--auto-measure']);

    expect(exitCode).toBe(EXIT_CODE.POLICY_VIOLATION);
    expect(output.allPassing).toBe(false);
    expect(output.failCount).toBe(1);
    expect(output.nextActions).toBeDefined();
    expect(output.nextActions).toContain('Fix failing constraints before merging');
  });

  // ── Boundary warn: measured === ceiling → warn, CI exit 0 ──────────────
  it('exits 0 in CI mode when measured value equals ceiling (warn boundary)', () => {
    const tmp = makeTempDir('boundary');
    process.chdir(tmp);
    // 149 lines → measured 150 === ceiling 150 → warn
    writeEvidenceFixture(tmp, /* actual */ 149, /* baseline */ 100, /* ceiling */ 150);

    const { exitCode, output } = captureJson(adfEvidence, ciOptions, ['--auto-measure']);

    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
    expect(output.allPassing).toBe(true);
    expect(output.warnCount).toBe(1);
    expect(output.nextActions).toBeDefined();
    expect(output.nextActions).toContain('Review metrics at ceiling boundary');
  });

  // ── Comfortable pass: measured < ceiling → pass, no warnings ───────────
  it('exits 0 with no warnings when measured value is well under ceiling', () => {
    const tmp = makeTempDir('pass');
    process.chdir(tmp);
    // 79 lines → measured 80 < ceiling 150
    writeEvidenceFixture(tmp, /* actual */ 79, /* baseline */ 80, /* ceiling */ 150);

    const { exitCode, output } = captureJson(adfEvidence, ciOptions, ['--auto-measure']);

    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
    expect(output.allPassing).toBe(true);
    expect(output.failCount).toBe(0);
    expect(output.warnCount).toBe(0);
  });

  // ── Stale baseline: current/baseline ratio ≥ 1.2 → staleBaselines ─────
  it('reports stale baselines when measured value drifts far from baseline', () => {
    const tmp = makeTempDir('stale');
    process.chdir(tmp);
    // baseline=50, ceiling=200, actual=79 → measured=80, ratio 80/50=1.6 ≥ 1.2
    writeEvidenceFixture(tmp, /* actual */ 79, /* baseline */ 50, /* ceiling */ 200);

    const { exitCode, output } = captureJson(adfEvidence, jsonOptions, ['--auto-measure']);

    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
    expect(output.staleBaselineCount).toBeGreaterThan(0);
    expect(output.staleBaselines).toBeDefined();
    const stale = output.staleBaselines as Array<{
      metric: string;
      baseline: number;
      current: number;
      recommendedCeiling: number;
    }>;
    expect(stale[0].metric).toBe('app_loc');
    expect(stale[0].baseline).toBe(50);
    expect(stale[0].current).toBe(80);
    expect(stale[0].recommendedCeiling).toBeGreaterThan(80);
    expect(output.nextActions).toContain('charter adf metrics recalibrate --headroom 15 --reason "<rationale>" --dry-run');
  });

  // ── No stale baseline when ratio is under threshold ────────────────────
  it('does not report stale baselines when ratio is under threshold', () => {
    const tmp = makeTempDir('fresh');
    process.chdir(tmp);
    // baseline=100, ceiling=150, actual=109 → measured=110, ratio 110/100=1.1 < 1.2
    writeEvidenceFixture(tmp, /* actual */ 109, /* baseline */ 100, /* ceiling */ 150);

    const { exitCode, output } = captureJson(adfEvidence, jsonOptions, ['--auto-measure']);

    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
    expect(output.staleBaselineCount).toBe(0);
    expect(output.staleBaselines).toBeUndefined(); // field omitted when empty
  });
});

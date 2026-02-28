import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { adfMetricsCommand } from '../commands/adf-metrics';
import { adfEvidence } from '../commands/adf-evidence';

const baseOptions: CLIOptions = {
  configPath: '.charter',
  format: 'json',
  ciMode: false,
  yes: false,
};

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  vi.restoreAllMocks();
});

function writeFixtureRepo(tmp: string, baseline = 100): void {
  fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });

  fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), `ADF: 0.1
DEFAULT_LOAD:
  - core.adf
  - state.adf

METRICS:
  COMPONENTS_TOTAL_LOC: src/components.ts
`);
  fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), `ADF: 0.1
METRICS:
  components_total_loc: ${baseline} / 120 [lines]
`);
  fs.writeFileSync(path.join(tmp, '.ai', 'state.adf'), 'ADF: 0.1\nSTATE:\n  CURRENT: testing\n');
  fs.writeFileSync(path.join(tmp, 'src', 'components.ts'), Array.from({ length: 200 }, (_, i) => `line_${i}`).join('\n') + '\n');
}

describe('adf metrics recalibrate', () => {
  it('requires rationale by default', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-metrics-test-'));
    tempDirs.push(tmp);
    process.chdir(tmp);
    writeFixtureRepo(tmp);

    expect(() => adfMetricsCommand(baseOptions, ['recalibrate'])).toThrow('requires --reason');
  });

  it('recalibrates metric ceilings and writes rationale entries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-metrics-test-'));
    tempDirs.push(tmp);
    process.chdir(tmp);
    writeFixtureRepo(tmp);

    const exitCode = adfMetricsCommand(baseOptions, ['recalibrate', '--headroom', '20', '--reason', 'Scope expanded with new built views']);
    expect(exitCode).toBe(0);

    const measured = fs.readFileSync(path.join(tmp, 'src', 'components.ts'), 'utf-8').split('\n').length;
    const ceiling = Math.ceil(measured * 1.2);
    const core = fs.readFileSync(path.join(tmp, '.ai', 'core.adf'), 'utf-8');
    expect(core).toContain(`components_total_loc: ${measured} / ${ceiling} [lines]`);
    expect(core).toContain('BUDGET_RATIONALES');
    expect(core).toContain('Scope expanded with new built views');
  });
});

describe('adf evidence stale baseline warnings', () => {
  it('emits staleBaselines when measured value greatly exceeds baseline value', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-evidence-test-'));
    tempDirs.push(tmp);
    process.chdir(tmp);
    writeFixtureRepo(tmp, 80);

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));
    const exitCode = adfEvidence(baseOptions, ['--ai-dir', '.ai', '--auto-measure']);
    expect(exitCode).toBe(0);

    const out = JSON.parse(logs[0]) as { staleBaselines?: Array<{ metric: string; rationaleRequired: boolean }> };
    expect(out.staleBaselines?.length).toBeGreaterThan(0);
    expect(out.staleBaselines?.[0].metric).toBe('components_total_loc');
    expect(out.staleBaselines?.[0].rationaleRequired).toBe(true);
  });
});

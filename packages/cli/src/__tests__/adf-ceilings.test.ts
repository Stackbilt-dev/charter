import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAdf, parseManifest } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { adfContextCommand } from '../commands/adf-context';
import { adfEvidence } from '../commands/adf-evidence';
import { computeFileCeilings, measureLines } from '../commands/adf-ceilings';

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
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line_${i}`).join('\n') + '\n';
}

function setupRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-ceilings-test-'));
  tempDirs.push(tmp);
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), `ADF: 0.1
DEFAULT_LOAD:
  - core.adf
  - state.adf

ON_DEMAND:
  - api.adf (Triggers on: api)

METRICS:
  AT_CEILING_LOC: src/full.ts
  ROOMY_LOC: src/roomy.ts
  ON_DEMAND_LOC: src/api.ts
  MISSING_LOC: src/missing.ts
`);
  fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), `ADF: 0.1
METRICS:
  at_ceiling_loc: 1 / 10 [lines]
  roomy_loc: 1 / 50 [lines]
  missing_loc: 1 / 50 [lines]
`);
  fs.writeFileSync(path.join(tmp, '.ai', 'state.adf'), 'ADF: 0.1\nSTATE:\n  CURRENT: testing\n');
  fs.writeFileSync(path.join(tmp, '.ai', 'api.adf'), `ADF: 0.1
METRICS:
  on_demand_loc: 1 / 5 [lines]
`);
  // 9 content lines + trailing newline = 10 counted lines (the gate's convention).
  fs.writeFileSync(path.join(tmp, 'src', 'full.ts'), lines(9));
  fs.writeFileSync(path.join(tmp, 'src', 'roomy.ts'), lines(20));
  fs.writeFileSync(path.join(tmp, 'src', 'api.ts'), lines(7));
  fs.writeFileSync(path.join(tmp, 'src', 'plain.ts'), lines(3));
  return tmp;
}

function runJson(fn: () => number): Record<string, unknown> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => { logs.push(String(msg)); });
  const code = fn();
  vi.restoreAllMocks();
  expect(code).toBe(0);
  return JSON.parse(logs.join('\n')) as Record<string, unknown>;
}

describe('measureLines', () => {
  it('counts the trailing newline as a line, matching adf evidence', () => {
    setupRepo();
    expect(measureLines('src/full.ts')).toBe(10);
    expect(measureLines('src/nope.ts')).toBeNull();
  });
});

describe('adf context --files ceilings', () => {
  it('reports headroom equal to ceiling minus the adf evidence auto-measured value', () => {
    setupRepo();
    const ctx = runJson(() => adfContextCommand(baseOptions, ['--files', 'src/full.ts']));
    const ev = runJson(() => adfEvidence(baseOptions, ['--auto-measure']));
    const measured = (ev.autoMeasured as Array<{ metric: string; lines: number }>)
      .find(m => m.metric === 'at_ceiling_loc');
    expect(ctx.ceilings).toEqual([{
      file: 'src/full.ts',
      metric: 'at_ceiling_loc',
      value: 10,
      ceiling: 10,
      headroom: 0,
      status: 'warn',
      module: 'core.adf',
    }]);
    expect(measured?.lines).toBe(10);
  });

  it('gives no entry for files without a metric and keeps existing keys', () => {
    setupRepo();
    const out = runJson(() => adfContextCommand(baseOptions, ['--files', 'src/plain.ts,src/roomy.ts']));
    expect(Object.keys(out)).toEqual(['keywords', 'resolvedModules', 'ceilings']);
    expect(out.ceilings).toEqual([expect.objectContaining({
      file: 'src/roomy.ts', value: 21, ceiling: 50, headroom: 29, status: 'pass',
    })]);
  });

  it('omits the ceilings key when only --keywords is given', () => {
    setupRepo();
    const out = runJson(() => adfContextCommand(baseOptions, ['--keywords', 'api']));
    expect(out).not.toHaveProperty('ceilings');
  });

});

describe('computeFileCeilings', () => {
  it('attributes on-demand metrics, normalizes paths, and skips missing files', () => {
    const tmp = setupRepo();
    const manifest = parseManifest(parseAdf(fs.readFileSync(path.join('.ai', 'manifest.adf'), 'utf-8')));
    const result = computeFileCeilings('.ai', manifest, [
      './src/api.ts',
      path.join(tmp, 'src', 'roomy.ts'),
      'src\\full.ts',
      'src/missing.ts',
    ]);
    const byMetric = Object.fromEntries(result.map(r => [r.metric, r]));
    expect(Object.keys(byMetric).sort()).toEqual(['at_ceiling_loc', 'on_demand_loc', 'roomy_loc']);
    expect(byMetric.on_demand_loc).toMatchObject({
      module: 'api.adf', value: 8, ceiling: 5, headroom: -3, status: 'fail',
    });
  });
});

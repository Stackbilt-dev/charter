import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { adfCommand } from '../commands/adf';

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

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-patch-test-'));
  tempDirs.push(dir);
  return dir;
}

function captureJson(fn: () => Promise<number> | number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const captured: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => captured.push(s));
    Promise.resolve(fn()).then(() => {
      spy.mockRestore();
      try {
        resolve(JSON.parse(captured[0]));
      } catch (e) {
        reject(new Error(`No JSON captured. Got: ${captured.join('\n')}`));
      }
    }).catch(reject);
  });
}

const METRIC_ADF = `ADF: 0.1
METRICS:
  total_loc: 150 / 200 [lines]
  test_count: 42 / 100 [tests]
`;

const LIST_ADF = `ADF: 0.1
DECISIONS:
  - Use TypeScript
  - Use pnpm
  - Prefer immutability
`;

describe('adf patch JSON changes array', () => {
  it('UPDATE_METRIC: captures before and after values', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'core.adf');
    fs.writeFileSync(file, METRIC_ADF);

    const ops = JSON.stringify([{ op: 'UPDATE_METRIC', section: 'METRICS', key: 'total_loc', value: 175 }]);

    const result = await captureJson(() => adfCommand(baseOptions, ['patch', file, '--ops', ops])) as Record<string, unknown>;

    expect(result.patched).toBe(true);
    expect(result.opsApplied).toBe(1);
    const changes = result.changes as Array<Record<string, unknown>>;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      op: 'UPDATE_METRIC',
      section: 'METRICS',
      key: 'total_loc',
      before: 150,
      after: 175,
    });
    expect(fs.readFileSync(file, 'utf-8')).toContain('total_loc: 175');
  });

  it('UPDATE_METRIC: multiple ops each show their own before/after', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'core.adf');
    fs.writeFileSync(file, METRIC_ADF);

    const ops = JSON.stringify([
      { op: 'UPDATE_METRIC', section: 'METRICS', key: 'total_loc', value: 160 },
      { op: 'UPDATE_METRIC', section: 'METRICS', key: 'test_count', value: 50 },
    ]);

    const result = await captureJson(() => adfCommand(baseOptions, ['patch', file, '--ops', ops])) as Record<string, unknown>;
    const changes = result.changes as Array<Record<string, unknown>>;

    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ key: 'total_loc', before: 150, after: 160 });
    expect(changes[1]).toMatchObject({ key: 'test_count', before: 42, after: 50 });
  });

  it('REPLACE_BULLET: before is the original item text', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'decisions.adf');
    fs.writeFileSync(file, LIST_ADF);

    const ops = JSON.stringify([
      { op: 'REPLACE_BULLET', section: 'DECISIONS', index: 1, value: 'Use npm' },
    ]);

    const result = await captureJson(() => adfCommand(baseOptions, ['patch', file, '--ops', ops])) as Record<string, unknown>;
    const changes = result.changes as Array<Record<string, unknown>>;

    expect(changes[0]).toMatchObject({
      op: 'REPLACE_BULLET',
      section: 'DECISIONS',
      index: 1,
      before: 'Use pnpm',
      after: 'Use npm',
    });
  });

  it('ADD_BULLET: before is null, after is the new value', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'decisions.adf');
    fs.writeFileSync(file, LIST_ADF);

    const ops = JSON.stringify([
      { op: 'ADD_BULLET', section: 'DECISIONS', value: 'Prefer functional patterns' },
    ]);

    const result = await captureJson(() => adfCommand(baseOptions, ['patch', file, '--ops', ops])) as Record<string, unknown>;
    const changes = result.changes as Array<Record<string, unknown>>;

    expect(changes[0]).toMatchObject({
      op: 'ADD_BULLET',
      section: 'DECISIONS',
      before: null,
      after: 'Prefer functional patterns',
    });
  });

  it('REMOVE_BULLET: before is the removed item, after is null', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'decisions.adf');
    fs.writeFileSync(file, LIST_ADF);

    const ops = JSON.stringify([
      { op: 'REMOVE_BULLET', section: 'DECISIONS', index: 2 },
    ]);

    const result = await captureJson(() => adfCommand(baseOptions, ['patch', file, '--ops', ops])) as Record<string, unknown>;
    const changes = result.changes as Array<Record<string, unknown>>;

    expect(changes[0]).toMatchObject({
      op: 'REMOVE_BULLET',
      section: 'DECISIONS',
      index: 2,
      before: 'Prefer immutability',
      after: null,
    });
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('Prefer immutability');
  });

  it('malformed ops: null array element is rejected cleanly, not as a TypeError', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'core.adf');
    fs.writeFileSync(file, METRIC_ADF);

    // Previously crashed in the before-capture pass with an uncaught
    // "Cannot read properties of null (reading 'op')" TypeError.
    await expect(adfCommand(baseOptions, ['patch', file, '--ops', '[null]'])).rejects.toMatchObject({
      name: 'CLIError',
      message: expect.stringContaining('Invalid --ops operation'),
    });
    // The file must be left untouched when validation fails.
    expect(fs.readFileSync(file, 'utf-8')).toBe(METRIC_ADF);
  });

  it('malformed ops: non-object and unknown-op elements are rejected with CLIError', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'core.adf');
    fs.writeFileSync(file, METRIC_ADF);

    for (const bad of ['[123]', '[{"section":"x","index":0}]', '[{"op":"FROBNICATE","section":"x"}]']) {
      await expect(adfCommand(baseOptions, ['patch', file, '--ops', bad])).rejects.toMatchObject({
        name: 'CLIError',
      });
    }
  });

  it('error: returns patched:false with error message, no changes', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'core.adf');
    fs.writeFileSync(file, METRIC_ADF);

    const ops = JSON.stringify([
      { op: 'UPDATE_METRIC', section: 'METRICS', key: 'nonexistent_key', value: 99 },
    ]);

    const captured: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => captured.push(s));
    const exitCode = await adfCommand(baseOptions, ['patch', file, '--ops', ops]);
    spy.mockRestore();

    expect(exitCode).not.toBe(0);
    const result = JSON.parse(captured[0]) as Record<string, unknown>;
    expect(result.patched).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.changes).toBeUndefined();
  });
});

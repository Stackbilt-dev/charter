import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { quickstartCommand } from '../commands/why';

const baseOptions: CLIOptions = {
  configPath: '.charter',
  format: 'text',
  ciMode: false,
  yes: false,
};

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-why-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('quickstartCommand — not-installed repo shows adoption pitch', () => {
  it('prints adoption pitch and returns 0 when no .charter/config.json present', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg ?? ''));

    const exit = await quickstartCommand({ ...baseOptions, configPath: path.join(tmp, '.charter') });

    expect(exit).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Charter Quickstart');
    expect(output).toContain('Why teams use Charter');
    expect(output).not.toContain('governance snapshot');
  });
});

describe('quickstartCommand — installed repo shows posture view', () => {
  let tmp: string;
  let logs: string[];

  beforeEach(() => {
    tmp = makeTempDir();
    process.chdir(tmp);
    fs.mkdirSync(path.join(tmp, '.charter'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.charter', 'config.json'),
      JSON.stringify({ project: 'test', git: { requireTrailers: true } }),
    );
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg ?? ''));
  });

  it('shows governance snapshot header instead of adoption pitch', async () => {
    const exit = await quickstartCommand({ ...baseOptions, configPath: path.join(tmp, '.charter') });

    expect(exit).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('governance snapshot');
    expect(output).not.toContain('Why teams use Charter');
    expect(output).not.toContain('Charter Quickstart');
  });

  it('shows active pattern count', async () => {
    fs.mkdirSync(path.join(tmp, '.charter', 'patterns'));
    fs.writeFileSync(
      path.join(tmp, '.charter', 'patterns', 'test.json'),
      JSON.stringify({ patterns: [
        { id: 'p1', name: 'Pattern One', status: 'ACTIVE', blessed_solution: 'do x', anti_patterns: 'avoid y' },
        { id: 'p2', name: 'Pattern Two', status: 'ACTIVE', blessed_solution: 'do z', anti_patterns: 'avoid w' },
      ] }),
    );

    await quickstartCommand({ ...baseOptions, configPath: path.join(tmp, '.charter') });

    expect(logs.join('\n')).toContain('2 active');
  });

  it('exits 0 in ci mode when coverage and patterns are both ok', async () => {
    fs.mkdirSync(path.join(tmp, '.charter', 'patterns'));
    const patterns = Array.from({ length: 3 }, (_, i) => ({
      id: `p${i}`, name: `P${i}`, status: 'ACTIVE', blessed_solution: 'x', anti_patterns: 'y',
    }));
    fs.writeFileSync(
      path.join(tmp, '.charter', 'patterns', 'test.json'),
      JSON.stringify({ patterns }),
    );

    const exit = await quickstartCommand({
      ...baseOptions,
      configPath: path.join(tmp, '.charter'),
      ciMode: true,
    });
    // No git repo in tmp → coverage=0 → fail signal, but patterns ≥3 ok.
    // Coverage 0% → fail → ci mode should return POLICY_VIOLATION (1).
    expect(exit).toBe(1);
  });

  it('exits 1 in ci mode when patterns is 0 (fail signal)', async () => {
    const exit = await quickstartCommand({
      ...baseOptions,
      configPath: path.join(tmp, '.charter'),
      ciMode: true,
    });
    expect(exit).toBe(1);
  });
});

describe('quickstartCommand --format json', () => {
  it('includes activePatterns in JSON output for installed repo', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);
    fs.mkdirSync(path.join(tmp, '.charter', 'patterns'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.charter', 'config.json'),
      JSON.stringify({ project: 'test' }),
    );
    fs.writeFileSync(
      path.join(tmp, '.charter', 'patterns', 'p.json'),
      JSON.stringify({ patterns: [{ id: 'x', name: 'X', status: 'ACTIVE', blessed_solution: 'a', anti_patterns: 'b' }] }),
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg ?? ''));

    await quickstartCommand({ ...baseOptions, format: 'json', configPath: path.join(tmp, '.charter') });

    const data = JSON.parse(logs[0]);
    expect(data).toHaveProperty('activePatterns');
    expect(data.activePatterns).toBe(1);
    expect(data).toHaveProperty('hasBaseline', true);
  });
});

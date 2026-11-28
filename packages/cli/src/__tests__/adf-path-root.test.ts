import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adfContextCommand } from '../commands/adf-context';
import { clearPathTokenRootCache, resolvePathTokenRoot } from '../commands/adf-path-tokens';

const { spawned } = vi.hoisted(() => ({ spawned: [] as string[] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: ((file: string, ...rest: unknown[]) => {
      spawned.push(file);
      return (actual.execFileSync as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.execFileSync,
  };
});


let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-path-root-'));
  fs.mkdirSync(path.join(tmpDir, '.ai'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.ai', 'manifest.adf'), 'ADF: 0.1\n\n📦 DEFAULT_LOAD:\n  - core.adf\n');
  spawned.length = 0;
  clearPathTokenRootCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolvePathTokenRoot memoization', () => {
  it('spawns git once per .ai location, however many files or calls', () => {
    const aiDir = path.join(tmpDir, '.ai');
    const first = resolvePathTokenRoot(aiDir);
    expect(resolvePathTokenRoot(aiDir)).toBe(first);
    expect(spawned.filter(f => f === 'git')).toHaveLength(1);
  });

  it('one adf context invocation with many --files spawns git at most once', () => {
    const options = { configPath: path.join(tmpDir, '.charter'), format: 'json' as const, ciMode: false, yes: true };
    const files = ['a/one.ts', 'b/two.ts', 'c/three.ts', path.join(tmpDir, 'd', 'four.ts')].join(',');
    expect(adfContextCommand(options, ['--files', files, '--ai-dir', path.join(tmpDir, '.ai')])).toBe(0);
    expect(adfContextCommand(options, ['--files', files, '--ai-dir', path.join(tmpDir, '.ai')])).toBe(0);
    expect(spawned.filter(f => f === 'git')).toHaveLength(1);
  });
});

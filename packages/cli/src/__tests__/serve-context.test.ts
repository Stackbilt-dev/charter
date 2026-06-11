import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { CLIError } from '../index';
import { loadCharterContextSnapshot, serveCommand } from '../commands/serve';

const contextRefreshCommandMock = vi.hoisted(() => vi.fn());
vi.mock('../commands/context-refresh', () => ({
  contextRefreshCommand: contextRefreshCommandMock,
}));

const baseOptions: CLIOptions = {
  configPath: '.charter',
  format: 'text',
  ciMode: false,
  yes: false,
};

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-serve-context-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  contextRefreshCommandMock.mockReset();
});

describe('loadCharterContextSnapshot', () => {
  it('returns existing snapshot when refresh is false', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    const aiDir = path.join(tmp, '.ai');
    fs.mkdirSync(aiDir, { recursive: true });
    const snapshotPath = path.join(aiDir, 'context.snapshot.json');
    fs.writeFileSync(snapshotPath, JSON.stringify({ version: 1, generatedAt: '2026-01-01T00:00:00Z' }), 'utf8');

    const result = await loadCharterContextSnapshot(baseOptions, aiDir, { refresh: false });
    expect(result.refreshed).toBe(false);
    expect(result.snapshotPath).toBe('.ai/context.snapshot.json');
    expect((result.snapshot as { version: number }).version).toBe(1);
  });

  it('throws actionable error when snapshot is missing and refresh is false', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    const aiDir = path.join(tmp, '.ai');
    fs.mkdirSync(aiDir, { recursive: true });

    await expect(
      loadCharterContextSnapshot(baseOptions, aiDir, { refresh: false }),
    ).rejects.toThrowError(CLIError);
    await expect(
      loadCharterContextSnapshot(baseOptions, aiDir, { refresh: false }),
    ).rejects.toThrow(/refresh=true/);
  });

  it('refreshes snapshot when refresh is true', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    const aiDir = path.join(tmp, '.ai');
    contextRefreshCommandMock.mockImplementation(async (_options: CLIOptions, args: string[]) => {
      const aiDirArgIndex = args.indexOf('--ai-dir');
      const targetAiDir = aiDirArgIndex !== -1 ? args[aiDirArgIndex + 1] : aiDir;
      fs.mkdirSync(targetAiDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetAiDir, 'context.snapshot.json'),
        JSON.stringify({ version: 1, generatedAt: '2026-01-01T00:00:00Z', sourcesUsed: ['git'] }),
        'utf8',
      );
      fs.writeFileSync(path.join(targetAiDir, 'context.adf'), 'ADF: 0.1\n\nSTATE:\n  CURRENT: Refreshed\n', 'utf8');
      return EXIT_CODE.SUCCESS;
    });

    const result = await loadCharterContextSnapshot(
      { ...baseOptions, format: 'json' },
      aiDir,
      { refresh: true, sources: ['git'] },
    );

    expect(result.refreshed).toBe(true);
    expect(contextRefreshCommandMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(aiDir, 'context.snapshot.json'))).toBe(true);
    expect(fs.existsSync(path.join(aiDir, 'context.adf'))).toBe(true);
    expect((result.snapshot as { version: number }).version).toBe(1);
  });
});

describe('serveCommand startup guards', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the resolved --ai-dir path when the directory is missing', async () => {
    const missing = path.join(makeTempDir(), 'does-not-exist');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(serveCommand(baseOptions, ['--ai-dir', missing])).rejects.toMatchObject({
      name: 'CLIError',
      message: expect.stringContaining(path.resolve(missing)),
    });
  });

  it('names the resolved manifest path when manifest.adf is missing', async () => {
    const dir = makeTempDir(); // exists, but contains no manifest.adf
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(serveCommand(baseOptions, ['--ai-dir', dir])).rejects.toMatchObject({
      name: 'CLIError',
      message: expect.stringContaining(path.join(path.resolve(dir), 'manifest.adf')),
    });
  });
});

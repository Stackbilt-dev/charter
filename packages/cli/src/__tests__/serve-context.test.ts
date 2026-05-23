import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CLIOptions } from '../index';
import { CLIError } from '../index';
import { loadCharterContextSnapshot } from '../commands/serve';

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
    const result = await loadCharterContextSnapshot(
      { ...baseOptions, format: 'json' },
      aiDir,
      { refresh: true, sources: ['git'] },
    );

    expect(result.refreshed).toBe(true);
    expect(fs.existsSync(path.join(aiDir, 'context.snapshot.json'))).toBe(true);
    expect(fs.existsSync(path.join(aiDir, 'context.adf'))).toBe(true);
    expect((result.snapshot as { version: number }).version).toBe(1);
  });
});

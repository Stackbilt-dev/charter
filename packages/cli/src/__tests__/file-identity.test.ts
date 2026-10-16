/**
 * fileIdentity must compare full-precision inodes (#318).
 *
 * NTFS file indexes exceed 2^53. Read as a JS number, two different files can
 * get the same ino, and discoverAgentConfigFiles then drops one as a duplicate.
 * Real inodes on Linux CI are small, so statSync is mocked to return two inodes
 * that collapse to one number: 2^53 and 2^53 + 1.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverAgentConfigFiles, fileIdentity } from '../commands/adf-migrate';

// vi.mock is hoisted above the imports, so its data must be hoisted too.
const FAKE_INO = vi.hoisted((): Record<string, bigint> => ({
  'CLAUDE.md': 2n ** 53n,
  '.cursorrules': 2n ** 53n + 1n,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statSync = ((p: import('node:fs').PathLike, options?: { bigint?: boolean }) => {
    const ino = FAKE_INO[String(p).split(/[\\/]/).pop() ?? ''];
    if (ino === undefined) return actual.statSync(p, options as never);
    return options?.bigint ? { dev: 7n, ino } : { dev: 7, ino: Number(ino) };
  }) as typeof actual.statSync;
  return { ...actual, statSync, default: { ...actual, statSync } };
});

describe('fileIdentity precision (#318)', () => {
  const originalCwd = process.cwd();
  let tmp = '';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-file-identity-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the two mocked inodes collapse to one JS number', () => {
    expect(Number(FAKE_INO['CLAUDE.md'])).toBe(Number(FAKE_INO['.cursorrules']));
  });

  it('tells files apart whose inodes differ only beyond 2^53', () => {
    fs.writeFileSync('CLAUDE.md', 'a');
    fs.writeFileSync('.cursorrules', 'b');
    expect(fileIdentity(path.resolve('CLAUDE.md'))).toBe(`7:${2n ** 53n}`);
    expect(fileIdentity(path.resolve('.cursorrules'))).toBe(`7:${2n ** 53n + 1n}`);
    expect(discoverAgentConfigFiles()).toEqual(['CLAUDE.md', '.cursorrules']);
  });
});

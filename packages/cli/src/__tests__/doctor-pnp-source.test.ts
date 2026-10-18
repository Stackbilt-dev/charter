/**
 * #366: doctor's Yarn PnP check must read the same source the hook text is built
 * from (PNP_MARKER_FILES, yarnrcPnpLinkerRegExp). The hook module is mocked with
 * different values here: a doctor that hard-codes its own marker list or regex
 * would miss both and fail these tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../commands/hook', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commands/hook')>();
  return {
    ...actual,
    PNP_MARKER_FILES: ['.custom-pnp-marker'],
    yarnrcPnpLinkerRegExp: () => /^customLinker: on$/m,
  };
});

import { checkPreCommitScope, DOCTOR_PNP_CLI_MSG } from '../commands/doctor-gate-enforcement';
import { PRE_COMMIT_HOOK_CONTENT, PRE_COMMIT_PM_CLI_MARKER } from '../commands/hook';

describe('doctor PnP detection uses the hook module as its only source (#366)', () => {
  let originalCwd: string;
  let tempDir: string;
  // A Charter hook from before #366: every marker but the CLI one.
  const OLD_HOOK = PRE_COMMIT_HOOK_CONTENT.split(PRE_COMMIT_PM_CLI_MARKER).join('');

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-doctor-pnp-'));
    process.chdir(tempDir);
    execFileSync('git', ['init', '-q'], { stdio: 'ignore' });
    fs.mkdirSync(path.join(tempDir, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.git', 'hooks', 'pre-commit'), OLD_HOOK);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const row = () => checkPreCommitScope();

  it('a marker file from the mocked PNP_MARKER_FILES counts as PnP', () => {
    expect(row()).toBeUndefined();
    fs.writeFileSync(path.join(tempDir, '.custom-pnp-marker'), '');
    expect(row()?.details).toBe(DOCTOR_PNP_CLI_MSG.replace('{hookPath}', '.git/hooks/pre-commit'));
  });

  it('a .yarnrc.yml matching the mocked regex counts as PnP; the real markers no longer do', () => {
    fs.writeFileSync(path.join(tempDir, '.pnp.cjs'), '');
    fs.writeFileSync(path.join(tempDir, '.yarnrc.yml'), 'nodeLinker: pnp\n');
    expect(row()).toBeUndefined();
    fs.writeFileSync(path.join(tempDir, '.yarnrc.yml'), 'customLinker: on\n');
    expect(row()?.status).toBe('INFO');
  });
});

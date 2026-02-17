import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hookCommand } from '../commands/hook';
import type { CLIOptions } from '../index';

const baseOptions: CLIOptions = {
  configPath: '.charter',
  format: 'text',
  ciMode: false,
  yes: false,
};

describe('hookCommand', () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-hook-test-'));
    process.chdir(tempDir);
    execFileSync('git', ['init'], { stdio: 'ignore' });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('installs commit-msg hook', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await hookCommand(baseOptions, ['install', '--commit-msg']);
    expect(exitCode).toBe(0);

    const hookPath = path.join(tempDir, '.git', 'hooks', 'commit-msg');
    expect(fs.existsSync(hookPath)).toBe(true);
    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('Managed by Charter: commit-msg trailer normalizer');
    expect(content).toContain('git interpret-trailers --in-place');
  });

  it('skips existing non-charter hook without --force', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const hookPath = path.join(tempDir, '.git', 'hooks', 'commit-msg');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/usr/bin/env sh\necho "custom"\n');

    const exitCode = await hookCommand(baseOptions, ['install', '--commit-msg']);
    expect(exitCode).toBe(0);

    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('echo "custom"');
  });
});

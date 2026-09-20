import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../index';

const ROOT_HELP_SIGNATURE = 'charter - repo-level governance toolkit';

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

/**
 * run() writes telemetry under cwd, so every case runs inside a throwaway dir
 * instead of the real repo's .charter/.
 */
function captureRun(args: string[]): Promise<{ exitCode: number; output: string }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-help-routing-'));
  tempDirs.push(tmp);
  process.chdir(tmp);

  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '));
  });

  return run(args).then((exitCode) => ({ exitCode, output: lines.join('\n') }));
}

describe('--help routing', () => {
  it('routes `adf <subcommand> --help` to the adf docs, not the root help', async () => {
    const { exitCode, output } = await captureRun(['adf', 'migrate', '--help']);

    expect(exitCode).toBe(0);
    expect(output).not.toContain(ROOT_HELP_SIGNATURE);
    expect(output).toContain('charter adf — Attention-Directed Format tools');
  });

  it('routes `adf --help` to the full adf subcommand reference', async () => {
    const { exitCode, output } = await captureRun(['adf', '--help']);

    expect(exitCode).toBe(0);
    expect(output).not.toContain(ROOT_HELP_SIGNATURE);
    expect(output).toContain('charter adf — Attention-Directed Format tools');
  });

  it.each(['hook', 'score', 'telemetry'])(
    'routes `%s --help` to that command instead of the root help',
    async (command) => {
      const { exitCode, output } = await captureRun([command, '--help']);

      expect(exitCode).toBe(0);
      expect(output).not.toContain(ROOT_HELP_SIGNATURE);
      expect(output).toContain(command);
    }
  );

  it('still prints the root help for `--help` with no command', async () => {
    const { exitCode, output } = await captureRun(['--help']);

    expect(exitCode).toBe(0);
    expect(output).toContain(ROOT_HELP_SIGNATURE);
  });

  it('falls back to the root help for commands that do not document themselves', async () => {
    // Guards the regression risk of this fix: bootstrap has no --help handler,
    // so narrowing the top-level check too far would run onboarding for real.
    const { exitCode, output } = await captureRun(['bootstrap', '--help']);

    expect(exitCode).toBe(0);
    expect(output).toContain(ROOT_HELP_SIGNATURE);
  });

  it('still reports the version for `--version` after a command name', async () => {
    const { exitCode, output } = await captureRun(['adf', '--version']);

    expect(exitCode).toBe(0);
    expect(output).toMatch(/^charter v\d/m);
  });
});

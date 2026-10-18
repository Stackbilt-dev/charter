import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS_WITH_OWN_HELP, run } from '../index';

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
 * instead of the real repo's .charter/. Returns what the run left behind so a
 * caller can tell a printed help from a command that actually executed.
 */
async function captureRun(args: string[]): Promise<{
  exitCode: number;
  output: string;
  createdEntries: string[];
}> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-help-routing-'));
  tempDirs.push(tmp);
  process.chdir(tmp);

  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '));
  });

  const exitCode = await run(args);

  // run() writes .charter/telemetry for every invocation, help prints included.
  // Everything else — including anything else under .charter/, which is where
  // `init` and `setup` scaffold — means the command did real work.
  const createdEntries = fs.readdirSync(tmp).flatMap((entry) =>
    entry === '.charter'
      ? fs
          .readdirSync(path.join(tmp, entry))
          .filter((child) => child !== 'telemetry')
          .map((child) => `${entry}/${child}`)
      : [entry]
  );

  return { exitCode, output: lines.join('\n'), createdEntries };
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

  // Derived from the exported set rather than a hardcoded list: a command added
  // to COMMANDS_WITH_OWN_HELP is automatically held to the contract that earns
  // it a place there. Without this, adding a command whose handler does NOT
  // short-circuit on --help would silently make `charter <cmd> --help` run it.
  it.each([...COMMANDS_WITH_OWN_HELP])(
    '`%s --help` prints that command\'s help instead of executing it',
    async (command) => {
      const { exitCode, output, createdEntries } = await captureRun([command, '--help']);

      expect(exitCode).toBe(0);
      expect(output).not.toContain(ROOT_HELP_SIGNATURE);
      expect(output).toContain('Usage:');
      // A command that ran for real would leave work behind; help prints do not.
      expect(createdEntries).toEqual([]);
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
    const { exitCode, output, createdEntries } = await captureRun(['bootstrap', '--help']);

    expect(exitCode).toBe(0);
    expect(output).toContain(ROOT_HELP_SIGNATURE);
    expect(createdEntries).toEqual([]);
  });

  it('documents doctor\'s --ci, --format and hook-only --staged/--tidy-skipped flags in the root help (#363)', async () => {
    const { output } = await captureRun(['--help']);

    expect(output).toContain('charter doctor [--adf-only] [--ci] [--format text|json]');
    expect(output).toMatch(/--staged \[--tidy-skipped "<files>"\]: pre-commit hook only/);
  });

  // The subcommands adfCommand dispatches (its "Supported:" list). Each must be
  // named in the root help's adf entry and documented in `adf --help`.
  const ADF_SUBCOMMANDS = [
    'init', 'fmt', 'patch', 'create', 'populate', 'bundle', 'sync', 'evidence',
    'migrate', 'tidy', 'metrics', 'context', 'compile', 'suggest', 'vendor',
  ];

  it('keeps the subcommand list above in step with adfCommand\'s dispatch', async () => {
    const message = await captureRun(['adf', 'no-such-subcommand']).then(
      () => '',
      (err: Error) => err.message,
    );
    const supported = message.match(/Supported: (.*)$/)?.[1].split(', ');

    expect(supported).toEqual(ADF_SUBCOMMANDS);
  });

  it('lists every adf subcommand in the root help and in `adf --help` (#363)', async () => {
    const root = (await captureRun(['--help'])).output;
    const adfEntry = root.slice(root.indexOf('charter adf <subcommand>'), root.indexOf('charter serve'));
    const adf = (await captureRun(['adf', '--help'])).output;

    for (const sub of ADF_SUBCOMMANDS) {
      expect(adfEntry).toMatch(new RegExp(`[(\\s]${sub}[,)]`));
      expect(adf).toContain(`charter adf ${sub}`);
    }
  });

  it('describes tidy --source/--print-paths and each adf vendor subcommand in `adf --help` (#363)', async () => {
    const { output } = await captureRun(['adf', '--help']);

    expect(output).toContain('--source <file>: tidy only this file; repeat it');
    expect(output).toContain('--print-paths: print only `vendor <path>` then `module <path>` lines');
    expect(output).toContain('--mode compiled: with --write');
    for (const usage of [
      'status [--all]:',
      'set <file> <pointer|compiled|unmanaged> [--dry-run]:',
      'init [--dry-run]:',
      'restore <file> [--dry-run]:',
      'rename-legacy [--dry-run]:',
    ]) {
      expect(output).toContain(`      ${usage}`);
    }
  });

  it('still reports the version for `--version` after a command name', async () => {
    const { exitCode, output } = await captureRun(['adf', '--version']);

    expect(exitCode).toBe(0);
    expect(output).toMatch(/^charter v\d/m);
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { architectCommand } from '../commands/architect';
import { runCommand } from '../commands/run';
import { scaffoldCommand } from '../commands/scaffold';
import { loginCommand } from '../commands/login';
import type { CLIOptions } from '../index';
import { CLIError } from '../index';
import { DEPRECATION_WARNING_ENV_VAR } from '../commands/deprecation-warning';

const baseOptions: CLIOptions = {
  format: 'text',
  configPath: '.charter',
  ciMode: false,
  yes: false,
};

describe('deprecated build commands warnings', () => {
  const originalSuppress = process.env[DEPRECATION_WARNING_ENV_VAR];

  beforeEach(() => {
    delete process.env[DEPRECATION_WARNING_ENV_VAR];
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalSuppress === undefined) {
      delete process.env[DEPRECATION_WARNING_ENV_VAR];
    } else {
      process.env[DEPRECATION_WARNING_ENV_VAR] = originalSuppress;
    }
    vi.restoreAllMocks();
  });

  it('emits warning for login', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await loginCommand(baseOptions, []);

    const stderrOutput = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrOutput).toContain('charter login');
    expect(stderrOutput).toContain('@stackbilt/build');
  });

  it('emits warning for architect', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(architectCommand(baseOptions, [])).rejects.toBeInstanceOf(CLIError);

    const stderrOutput = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrOutput).toContain('charter architect');
  });

  it('emits warning for run', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runCommand(baseOptions, [])).rejects.toBeInstanceOf(CLIError);

    const stderrOutput = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrOutput).toContain('charter run');
  });

  it('emits warning for scaffold', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const options = { ...baseOptions, configPath: '.charter-missing-cache-for-test' };

    await expect(scaffoldCommand(options, [])).rejects.toBeInstanceOf(CLIError);

    const stderrOutput = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrOutput).toContain('charter scaffold');
  });
});

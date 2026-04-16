import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginCommand } from '../commands/login';
import type { CLIOptions } from '../index';
import { API_KEY_ENV_VAR } from '../credentials';

const options: CLIOptions = {
  format: 'text',
  configPath: '.charter',
  ciMode: false,
  yes: false,
};

describe('charter login — deprecation notice', () => {
  const originalEnv = process.env[API_KEY_ENV_VAR];

  beforeEach(() => {
    delete process.env[API_KEY_ENV_VAR];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[API_KEY_ENV_VAR];
    } else {
      process.env[API_KEY_ENV_VAR] = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it('writes a deprecation notice to stderr when invoked without args', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await loginCommand(options, []);

    const stderrOutput = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrOutput).toMatch(/deprecated/i);
    expect(stderrOutput).toContain(API_KEY_ENV_VAR);
  });

  it('reports env-var usage when STACKBILT_API_KEY is set and no --key flag', async () => {
    process.env[API_KEY_ENV_VAR] = 'ea_login_test_key';
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await loginCommand(options, []);

    const stdoutOutput = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stdoutOutput).toMatch(new RegExp(`Using ${API_KEY_ENV_VAR} from environment`));
  });
});

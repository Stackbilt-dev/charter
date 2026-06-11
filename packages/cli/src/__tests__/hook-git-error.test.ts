import { describe, it, expect, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { hookCommand } from '../commands/hook';

// Simulate a git environment where the repo check passes but resolving the
// hooks directory fails (e.g. `git rev-parse --git-dir` errors). This path
// previously escaped as a raw `Error`; it must now surface as a clean CLIError.
// hook.ts consumes only these three helpers from git-helpers.
vi.mock('../git-helpers', () => ({
  isGitRepo: () => true,
  runGit: (args: string[]) => {
    throw Object.assign(new Error(`git ${args.join(' ')} failed`), {
      stderr: 'fatal: not a git repository',
    });
  },
  getGitErrorMessage: (err: unknown) => {
    const e = err as Error & { stderr?: string };
    return e?.stderr?.trim() || e?.message || 'Unknown git error.';
  },
}));

const baseOptions: CLIOptions = {
  configPath: '.charter',
  format: 'text',
  ciMode: false,
  yes: false,
};

describe('hook install — git resolution failure', () => {
  it('surfaces a CLIError (not a raw Error) when the hooks dir cannot be resolved', async () => {
    await expect(hookCommand(baseOptions, ['install', '--commit-msg'])).rejects.toMatchObject({
      name: 'CLIError',
      message: expect.stringContaining('Could not resolve git hooks directory'),
    });
  });
});

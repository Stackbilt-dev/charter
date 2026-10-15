import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hookCommand, printClaudeHookConfig } from '../commands/hook';
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
    expect(content).toContain('Charter commit-msg trailer gate');
    expect(content).toContain('git interpret-trailers --in-place');
    expect(content).toContain('git.requireTrailers');
  });

  describe('generated commit-msg hook as a trailer gate (#299)', () => {
    // Drives the real hook through `git commit` so git's own sh runs it from the
    // repo root with relative paths; no absolute Windows paths reach the shell.
    function setupRepo(config?: string): void {
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test'], { stdio: 'ignore' });
      if (config !== undefined) {
        fs.mkdirSync('.charter', { recursive: true });
        fs.writeFileSync(path.join('.charter', 'config.json'), config);
      }
    }

    async function installHook(): Promise<void> {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await hookCommand(baseOptions, ['install', '--commit-msg'])).toBe(0);
    }

    function commit(message: string) {
      return spawnSync('git', ['commit', '--allow-empty', '-q', '-m', message], { encoding: 'utf-8' });
    }

    function lastMessage(): string {
      return execFileSync('git', ['log', '-1', '--format=%B'], { encoding: 'utf-8' });
    }

    const strict = JSON.stringify({ git: { requireTrailers: true }, validation: { citationStrictness: 'FAIL' } });

    it('rejects a message with no trailer when requireTrailers is on', { timeout: 30000 }, async () => {
      setupRepo(strict);
      await installHook();

      const result = commit('feat: no trailer here');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('git.requireTrailers is on');
      expect(result.stderr).toContain('Governed-By: ADR-001');
      expect(spawnSync('git', ['rev-parse', '--verify', 'HEAD']).status).not.toBe(0);
    });

    it('rejects under the default strictness, and ignores a trailer-like line outside the trailer block', { timeout: 30000 }, async () => {
      setupRepo(JSON.stringify({ git: { requireTrailers: true } }));
      await installHook();

      // Same rule as charter validate: only the terminal trailer block counts.
      const result = commit('feat: thing\n\nGoverned-By:\n\nmore body text');

      expect(result.status).toBe(1);
    });

    it('accepts either trailer, case-insensitively, and still normalizes it', { timeout: 30000 }, async () => {
      setupRepo(strict);
      await installHook();

      expect(commit('feat: governed\n\ngoverned-by:   ADR-007').status).toBe(0);
      expect(lastMessage()).toContain('Governed-By: ADR-007');

      expect(commit('feat: request\n\nResolves-Request: REQ-12').status).toBe(0);
      expect(lastMessage()).toContain('Resolves-Request: REQ-12');
    });

    it('moves a body-only Governed-By line into the trailer block and accepts it', { timeout: 30000 }, async () => {
      setupRepo(strict);
      await installHook();

      expect(commit('feat: misplaced\n\nGoverned-By: ADR-003\n\ntrailing paragraph').status).toBe(0);
      expect(lastMessage().trimEnd().endsWith('Governed-By: ADR-003')).toBe(true);
    });

    it('only warns when citation strictness is advisory', { timeout: 30000 }, async () => {
      setupRepo(JSON.stringify({ git: { requireTrailers: true }, validation: { citationStrictness: 'WARN' } }));
      await installHook();

      const result = commit('chore: advisory');

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('not blocking');
    });

    it('blocks under advisory strictness when ci.failOnWarn makes CI fail', { timeout: 30000 }, async () => {
      setupRepo(JSON.stringify({
        git: { requireTrailers: true },
        validation: { citationStrictness: 'WARN' },
        ci: { failOnWarn: true },
      }));
      await installHook();

      expect(commit('chore: fails on warn').status).toBe(1);
    });

    it.each([
      ['requireTrailers is false', JSON.stringify({ git: { requireTrailers: false } })],
      ['requireTrailers is absent', JSON.stringify({ git: {} })],
      ['the config is malformed JSON', '{ "git": { "requireTrailers": true '],
      ['there is no config file', undefined],
    ])('does not block when %s', { timeout: 30000 }, async (_label, config) => {
      setupRepo(config);
      await installHook();

      const result = commit('chore: ungoverned');

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('[commit-msg]');
    });
  });

  it('generates the same staged-vendor loop, compiled-file skip included, as the repo pre-commit hook (#320)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await hookCommand(baseOptions, ['install', '--pre-commit']);
    expect(exitCode).toBe(0);

    const generated = fs.readFileSync(path.join(tempDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
    const repoHook = fs.readFileSync(path.resolve(__dirname, '../../../../.githooks/pre-commit'), 'utf-8');
    const vendorLoop = (script: string): string => {
      const match = script.replace(/\r\n/g, '\n').match(/  VENDOR_FILES=[\s\S]*?\n  done\n/);
      expect(match).not.toBeNull();
      return match![0];
    };

    // The compiled-file skip keeps STAGED_VENDORS empty for compiled-only commits,
    // which is what stops tidy (and the .ai/*.adf re-stage) from running at all.
    expect(generated).toContain("grep -q 'GENERATED by charter adf compile' \"$vf\"");
    expect(generated).toContain('"totalExtracted": *[0-9][0-9]*');
    expect(vendorLoop(generated)).toBe(vendorLoop(repoHook));
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

  it('surfaces a CLIError (not a raw fs Error) when the hook file cannot be written', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Point the hooks dir at an existing regular file so creating the hooks
    // directory fails for real — no fs mocking, exercises the actual guard.
    const blocker = path.join(tempDir, 'blocker');
    fs.writeFileSync(blocker, 'i am a file, not a directory');
    execFileSync('git', ['config', 'core.hooksPath', blocker], { stdio: 'ignore' });

    await expect(hookCommand(baseOptions, ['install', '--commit-msg'])).rejects.toMatchObject({
      name: 'CLIError',
      message: expect.stringContaining('Could not write git hook'),
    });
  });

  it('hook print --claude returns 0 and outputs UserPromptSubmit config', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const exitCode = await hookCommand(baseOptions, ['print', '--claude']);
    expect(exitCode).toBe(0);

    const output = logs.join('\n');
    expect(output).toContain('UserPromptSubmit');
    expect(output).toContain('charter context-refresh --once');
  });

  it('printClaudeHookConfig outputs valid JSON with correct shape', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    printClaudeHookConfig();

    const output = logs.join('\n');
    const parsed = JSON.parse(output) as {
      hooks: { UserPromptSubmit: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
    };
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toBe('charter context-refresh --once');
  });

  it('hook print without --claude throws', async () => {
    await expect(hookCommand(baseOptions, ['print'])).rejects.toThrow('hook print requires --claude');
  });

  describe('hook print --mcp-config', () => {
    it('returns 0 and emits mcpServers JSON to stdout', async () => {
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const exitCode = await hookCommand(baseOptions, ['print', '--mcp-config']);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(logs.join('\n')) as { mcpServers: { charter: { command: string; args: string[] } } };
      expect(parsed.mcpServers.charter.command).toBe('charter');
      expect(parsed.mcpServers.charter.args).toEqual(['serve']);
    });

    it('defaults to --client claude when --client is absent', async () => {
      const errors: string[] = [];
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });

      await hookCommand(baseOptions, ['print', '--mcp-config']);
      expect(errors.join('\n')).toContain('.claude/settings.json');
    });

    it('--client cursor emits .mcp.json hint', async () => {
      const errors: string[] = [];
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });

      await hookCommand(baseOptions, ['print', '--mcp-config', '--client', 'cursor']);
      expect(errors.join('\n')).toContain('.mcp.json');
    });

    it('--ai-dir adds --ai-dir to server args', async () => {
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await hookCommand(baseOptions, ['print', '--mcp-config', '--ai-dir', 'custom/ai']);
      const parsed = JSON.parse(logs.join('\n')) as { mcpServers: { charter: { args: string[] } } };
      expect(parsed.mcpServers.charter.args).toEqual(['serve', '--ai-dir', 'custom/ai']);
    });

    it('unknown --client value falls back to claude', async () => {
      const errors: string[] = [];
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });

      await hookCommand(baseOptions, ['print', '--mcp-config', '--client', 'vscode']);
      expect(errors.join('\n')).toContain('.claude/settings.json');
    });
  });
});

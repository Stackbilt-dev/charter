import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
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

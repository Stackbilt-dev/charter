import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { CLIError } from '../index';
import { contextRefreshCommand } from '../commands/context-refresh';

const options: CLIOptions = {
  configPath: '.charter',
  format: 'text',
  ciMode: false,
  yes: false,
};

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-context-refresh-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('contextRefreshCommand', () => {
  it('writes .ai/context.adf even when git is unavailable', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await contextRefreshCommand(options, []);
    expect(exitCode).toBe(0);

    const contextPath = path.join(tmp, '.ai', 'context.adf');
    expect(fs.existsSync(contextPath)).toBe(true);
    const content = fs.readFileSync(contextPath, 'utf8');
    expect(content).toContain('OPEN_WORK:');
    expect(content).toContain('Git source unavailable');
  });

  it('captures branch/commits and mirrors markdown output when requested', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmp, stdio: 'ignore' });

    fs.writeFileSync(path.join(tmp, 'README.md'), '# Repo\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: tmp, stdio: 'ignore' });

    fs.writeFileSync(path.join(tmp, 'README.md'), '# Repo\n\nupdate\n', 'utf8');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      logs.push(String(value ?? ''));
    });

    const mdPath = path.join(tmp, 'CONTEXT.md');
    const exitCode = await contextRefreshCommand({ ...options, format: 'json' }, ['--output', mdPath]);
    expect(exitCode).toBe(0);

    const payload = JSON.parse(logs[0]) as {
      git: { available: boolean; branch: string | null; dirty: boolean; recentCommits: Array<{ subject: string }> };
      files: { contextAdf: string; outputMarkdown: string | null };
    };

    expect(payload.git.available).toBe(true);
    expect(payload.git.branch).toBeTruthy();
    expect(payload.git.dirty).toBe(true);
    expect(payload.git.recentCommits.length).toBeGreaterThanOrEqual(1);
    expect(payload.git.recentCommits[0].subject).toContain('initial commit');
    expect(payload.files.contextAdf).toBe('.ai/context.adf');
    expect(payload.files.outputMarkdown).toBe('CONTEXT.md');

    const contextAdf = fs.readFileSync(path.join(tmp, '.ai', 'context.adf'), 'utf8');
    expect(contextAdf).toContain('RECENT_ACTIVITY:');
    expect(contextAdf).toContain('initial commit');

    const markdown = fs.readFileSync(mdPath, 'utf8');
    expect(markdown).toContain('# Live Context');
    expect(markdown).toContain('## Recent Activity');
  });

  it('rejects unsupported sources during phase 1', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    await expect(contextRefreshCommand(options, ['--sources', 'git,github'])).rejects.toBeInstanceOf(CLIError);
  });
});

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
const originalToken = process.env.GITHUB_TOKEN;
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
  if (originalToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalToken;
  }
  vi.restoreAllMocks();
});

describe('contextRefreshCommand', () => {
  it('writes both context.adf and context.snapshot.json when git is unavailable', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await contextRefreshCommand(options, []);
    expect(exitCode).toBe(0);

    const contextPath = path.join(tmp, '.ai', 'context.adf');
    const snapshotPath = path.join(tmp, '.ai', 'context.snapshot.json');
    expect(fs.existsSync(contextPath)).toBe(true);
    expect(fs.existsSync(snapshotPath)).toBe(true);

    const adf = fs.readFileSync(contextPath, 'utf8');
    expect(adf).toContain('OPEN_WORK:');
    expect(adf).toContain('none');

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
      version: number;
      sources: { git: { available: boolean } };
      openWork: unknown[];
      recentActivity: unknown[];
      pendingDecisions: unknown[];
    };
    expect(snapshot.version).toBe(1);
    expect(snapshot.sources.git.available).toBe(false);
    expect(Array.isArray(snapshot.openWork)).toBe(true);
    expect(Array.isArray(snapshot.recentActivity)).toBe(true);
    expect(Array.isArray(snapshot.pendingDecisions)).toBe(true);
  });

  it('captures git signals, writes markdown mirror, and returns json summary', async () => {
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
      status: string;
      reason: string;
      files: { contextAdf: string; snapshotJson: string; outputMarkdown: string | null };
      warnings: string[];
      errors: string[];
    };

    expect(payload.status).toBe('ok');
    expect(payload.reason).toBe('refreshed');
    expect(payload.files.contextAdf).toBe('.ai/context.adf');
    expect(payload.files.snapshotJson).toBe('.ai/context.snapshot.json');
    expect(payload.files.outputMarkdown).toBe('CONTEXT.md');
    expect(payload.warnings).toHaveLength(0);
    expect(payload.errors).toHaveLength(0);

    const contextAdf = fs.readFileSync(path.join(tmp, '.ai', 'context.adf'), 'utf8');
    expect(contextAdf).toContain('RECENT_ACTIVITY:');
    expect(contextAdf).toContain('initial commit');

    const snapshot = JSON.parse(fs.readFileSync(path.join(tmp, '.ai', 'context.snapshot.json'), 'utf8')) as {
      sources: { git: { available: boolean; dirty: boolean; recentCommits: Array<{ subject: string }> } };
      openWork: Array<{ source: string }>;
      recentActivity: Array<{ source: string }>;
    };
    expect(snapshot.sources.git.available).toBe(true);
    expect(snapshot.sources.git.dirty).toBe(true);
    expect(snapshot.sources.git.recentCommits[0].subject).toContain('initial commit');
    expect(snapshot.openWork.some((item) => item.source === 'git')).toBe(true);
    expect(snapshot.recentActivity.some((item) => item.source === 'git')).toBe(true);

    const markdown = fs.readFileSync(mdPath, 'utf8');
    expect(markdown).toContain('# Live Context');
    expect(markdown).toContain('## Recent Activity');
  });

  it('supports --once ttl skip using fresh existing snapshot', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmp, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'a\n', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmp, stdio: 'ignore' });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await contextRefreshCommand({ ...options, format: 'json' }, []);
    const firstSnapshot = JSON.parse(
      fs.readFileSync(path.join(tmp, '.ai', 'context.snapshot.json'), 'utf8')
    ) as { generatedAt: string };

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      logs.push(String(value ?? ''));
    });
    const exitCode = await contextRefreshCommand(
      { ...options, format: 'json' },
      ['--once', '--ttl-minutes', '60']
    );
    expect(exitCode).toBe(0);
    const payload = JSON.parse(logs[0]) as { status: string; reason: string; generatedAt: string };
    expect(payload.status).toBe('skipped');
    expect(payload.reason).toBe('fresh_snapshot');
    expect(payload.generatedAt).toBe(firstSnapshot.generatedAt);
  });

  it('fails closed for github source when GITHUB_TOKEN is missing', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    delete process.env.GITHUB_TOKEN;
    fs.mkdirSync(path.join(tmp, '.charter'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.charter', 'context-sources.json'),
      JSON.stringify({
        version: 1,
        defaults: {
          sources: ['github'],
          ttlMinutes: 30,
          maxItems: { gitCommits: 10, gitDirtyFiles: 25, githubIssues: 20 },
        },
        sources: {
          git: { enabled: false },
          github: {
            enabled: true,
            repo: 'Stackbilt-dev/charter',
            labels: ['auto-fix'],
            includePullRequests: true,
            includeChecks: true,
          },
        },
      }, null, 2),
      'utf8'
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      logs.push(String(value ?? ''));
    });

    const exitCode = await contextRefreshCommand(
      { ...options, format: 'json', configPath: path.join(tmp, '.charter') },
      []
    );
    expect(exitCode).toBe(0);
    const payload = JSON.parse(logs[0]) as {
      status: string;
      reason: string;
      warnings: string[];
      errors: string[];
    };
    expect(payload.status).toBe('ok');
    expect(payload.reason).toBe('partial_source_failure');
    expect(payload.warnings.some((warning) => warning.includes('missing GITHUB_TOKEN'))).toBe(true);
    expect(payload.errors).toHaveLength(0);

    const snapshot = JSON.parse(
      fs.readFileSync(path.join(tmp, '.ai', 'context.snapshot.json'), 'utf8')
    ) as {
      sources: { github: { available: boolean; error?: string } };
    };
    expect(snapshot.sources.github.available).toBe(false);
    expect(snapshot.sources.github.error).toContain('missing GITHUB_TOKEN');
  });

  it('rejects unsupported source names', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    await expect(contextRefreshCommand(options, ['--sources', 'git,foobar'])).rejects.toBeInstanceOf(CLIError);
  });
});

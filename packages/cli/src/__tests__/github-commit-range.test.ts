import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { getRecentCommitRange } from '../git-helpers';
import { auditCommand } from '../commands/audit';
import { validateCommand } from '../commands/validate';
import { getGithubWorkflow } from '../commands/setup';
import { GITHUB_COMMIT_RANGE_SCRIPT } from '../commands/github-commit-range';

const originalCwd = process.cwd();
const options: CLIOptions = { configPath: '.charter', format: 'json', ciMode: true, yes: false };
let repo: string;
let output: string[];
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

function commit(name: string, governed = true): string {
  fs.writeFileSync(path.join(repo, `${name}.md`), `${name}\n`);
  git('add', `${name}.md`);
  git('commit', '-qm', name, ...(governed ? ['-m', 'Governed-By: ADR-409'] : []));
  return git('rev-parse', 'HEAD');
}

function eventRange(base: string, head: string): { status: number | null; range: string; error: string } {
  const envFile = path.join(repo, 'github-env');
  fs.writeFileSync(envFile, '');
  // Git for Windows ships bash next to its exec-path; do not invoke WSL's bash.
  const bash = process.platform === 'win32'
    ? path.resolve(git('--exec-path'), '../../../bin/bash.exe') : 'bash';
  const result = spawnSync(bash, ['-c', GITHUB_COMMIT_RANGE_SCRIPT], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, BASE_SHA: base, HEAD_SHA: head, GITHUB_ENV: envFile },
  });
  return { status: result.status, range: fs.readFileSync(envFile, 'utf8').trim().replace(/^CHARTER_COMMIT_RANGE=/, ''), error: `${result.stdout}${result.stderr}` };
}

async function command(kind: 'validate' | 'audit', range?: string): Promise<{ code: number; json: any }> {
  output = [];
  const args = range === undefined ? [] : ['--range', range];
  const code = await (kind === 'validate' ? validateCommand(options, args) : auditCommand(options, args));
  return { code, json: JSON.parse(output.join('\n')) };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-event-range-'));
  git('init', '-q', '-b', 'trunk');
  git('config', 'user.name', 'Charter Test');
  git('config', 'user.email', 'test@example.test');
  fs.mkdirSync(path.join(repo, '.charter'));
  fs.writeFileSync(path.join(repo, '.charter/config.json'), JSON.stringify({
    project: 'event-range', git: { requireTrailers: true, trailerThreshold: 'HIGH' },
    validation: { citationStrictness: 'FAIL' },
  }));
  process.chdir(repo);
  output = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => output.push(args.map(String).join(' ')));
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('GitHub event commit ranges (#409)', () => {
  it('checks an early untrailered commit in a seven-commit PR and excludes the synthetic merge', async () => {
    const base = commit('base');
    git('checkout', '-qb', 'feature');
    const missing = commit('first-feature', false);
    for (let i = 2; i <= 7; i++) commit(`feature-${i}`);
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'trunk');
    git('merge', '--no-ff', '-qm', 'Synthetic merge without trailer', 'feature');
    const resolved = eventRange(base, head);
    expect(resolved.status).toBe(0);
    expect(resolved.range).toBe(`${base}..${head}`);
    const validation = await command('validate', resolved.range);
    expect(validation.code).toBe(1);
    expect(validation.json.evidence.policyOffenders.map((o: { sha: string }) => o.sha)).toEqual([missing]);
    const audit = await command('audit', resolved.range);
    expect(audit.json.git).toMatchObject({ totalCommits: 7, commitsWithTrailers: 6, commitRange: resolved.range });
  });

  it('uses a valid first-parent boundary for default validate/audit on a young synthetic merge', async () => {
    commit('base');
    git('checkout', '-qb', 'feature');
    commit('first-feature');
    commit('second-feature');
    git('checkout', '-q', 'trunk');
    git('merge', '--no-ff', '-qm', 'Synthetic merge without trailer', 'feature');
    expect(getRecentCommitRange()).toBe('HEAD~1..HEAD');
    const validation = await command('validate');
    expect(validation.code).toBe(1); // Existing trailer policy still applies to the merge locally.
    expect(validation.json.status).toBe('FAIL');
    const audit = await command('audit');
    expect(audit.code).not.toBe(2);
    expect(audit.json.git.totalCommits).toBe(3);
  });

  it.each(['', '0'.repeat(40)])('checks all history for missing/zero event bases (%s)', async base => {
    const missing = commit('initial', false);
    const head = commit('second');
    const resolved = eventRange(base, head);
    expect(resolved).toMatchObject({ status: 0, range: head });
    const validation = await command('validate', resolved.range);
    expect(validation.json.evidence.policyOffenders.map((o: { sha: string }) => o.sha)).toEqual([missing]);
    expect((await command('audit', resolved.range)).json.git.totalCommits).toBe(2);
  });

  it('uses the entire push event, including more than five commits', async () => {
    const base = commit('base');
    for (let i = 0; i < 8; i++) commit(`push-${i}`);
    const head = git('rev-parse', 'HEAD');
    const resolved = eventRange(base, head);
    expect(resolved).toMatchObject({ status: 0, range: `${base}..${head}` });
    expect((await command('audit', resolved.range)).json.git.totalCommits).toBe(8);
  });

  it('handles an empty repository and a single commit without invalid ancestry', async () => {
    expect(getRecentCommitRange()).toBe('HEAD');
    expect((await command('validate')).code).toBe(0);
    expect((await command('audit')).code).toBe(0);
    commit('only');
    expect(getRecentCommitRange()).toBe('HEAD');
    expect((await command('validate')).code).toBe(0);
    expect((await command('audit')).json.git.totalCommits).toBe(1);
  });

  it.each(['', '0'.repeat(40), 'HEAD', 'f'.repeat(40)])('refuses missing, deleted, malformed or unavailable event heads (%s)', head => {
    const base = commit('base');
    const result = eventRange(base, head);
    expect(result.status).not.toBe(0);
    expect(result.range).toBe('');
    expect(result.error).toContain('::error::');
  });

  it.each(['HEAD~1', 'f'.repeat(40)])('refuses malformed/unavailable bases instead of checking a smaller range (%s)', base => {
    const head = commit('base');
    const result = eventRange(base, head);
    expect(result.status).not.toBe(0);
    expect(result.range).toBe('');
    expect(result.error).toContain('::error::');
  });

  it('keeps explicit invalid ranges as runtime errors instead of silently falling back', async () => {
    commit('base');
    for (const kind of ['validate', 'audit'] as const) {
      const result = await command(kind, 'HEAD~10..HEAD');
      expect(result.code).toBe(2);
      expect(result.json.status).toBe('ERROR');
      expect(result.json.details).toContain('HEAD~10..HEAD');
    }
  });

  it.each(['npm', 'pnpm'] as const)('wires both commands to the resolved %s event range', pm => {
    const workflow = getGithubWorkflow(pm);
    expect(workflow).toContain("if: github.event.deleted != true");
    expect(workflow).toContain('BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}');
    expect(workflow).toContain('HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(workflow).toContain('validate --ci --format text --range "$CHARTER_COMMIT_RANGE"');
    expect(workflow).toContain('audit --format json --range "$CHARTER_COMMIT_RANGE"');
    expect(workflow).toContain("if: always() && steps.commit_range.outcome == 'success'");
    expect(workflow).toContain(GITHUB_COMMIT_RANGE_SCRIPT.split('\n').map(line => `          ${line}`).join('\n'));
  });
});

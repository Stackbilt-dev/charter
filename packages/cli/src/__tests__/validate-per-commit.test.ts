import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { validateCommand } from '../commands/validate';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

interface ValidateOutput {
  status: 'PASS' | 'WARN' | 'FAIL';
  summary: string;
  trailersFound: number;
  strictTrailerMode: { active: boolean; reason: string };
  evidence: { policyOffenders: Array<{ sha: string }> };
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

function commit(repo: string, subject: string, governedBy?: string): string {
  const file = path.join(repo, `${subject.replace(/\W+/g, '-')}.md`);
  fs.writeFileSync(file, `${subject}\n`);
  git(repo, 'add', path.basename(file));
  const args = ['commit', '-q', '-m', subject];
  if (governedBy) args.push('-m', `Governed-By: ${governedBy}`);
  git(repo, ...args);
  return git(repo, 'rev-parse', 'HEAD');
}

function makeRepo(strictness: 'FAIL' | 'WARN' = 'FAIL'): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-validate-commits-'));
  tempDirs.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Charter Test');
  git(repo, 'config', 'user.email', 'charter@example.test');
  fs.mkdirSync(path.join(repo, '.charter'));
  fs.writeFileSync(path.join(repo, '.charter', 'config.json'), JSON.stringify({
    project: 'validate-fixture',
    git: { requireTrailers: true, trailerThreshold: 'HIGH' },
    validation: { citationStrictness: strictness },
    ci: { failOnWarn: false },
  }));
  commit(repo, 'base');
  process.chdir(repo);
  return repo;
}

async function validate(range: string): Promise<{ exitCode: number; output: ValidateOutput }> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => logs.push(args.map(String).join(' ')));
  const options: CLIOptions = { configPath: '.charter', format: 'json', ciMode: true, yes: false };
  const exitCode = await validateCommand(options, ['--range', range]);
  return { exitCode, output: JSON.parse(logs.join('\n')) as ValidateOutput };
}

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('charter validate per-commit trailer enforcement', () => {
  it('fails a mixed range and preserves the untrailered commit as a policy offender', async () => {
    const repo = makeRepo();
    const missingSha = commit(repo, 'untrailered docs change');
    commit(repo, 'trailered docs change', 'ADR-289');

    const { exitCode, output } = await validate('HEAD~2..HEAD');

    expect(exitCode).toBe(1);
    expect(output.status).toBe('FAIL');
    expect(output.summary).toBe('1 of 2 commit(s) missing required governance trailers.');
    expect(output.trailersFound).toBe(1);
    expect(output.strictTrailerMode.active).toBe(true);
    expect(output.evidence.policyOffenders.map(offender => offender.sha)).toEqual([missingSha]);
  });

  it('passes only when every commit in a strict range has a trailer', async () => {
    const repo = makeRepo();
    commit(repo, 'first governed change', 'ADR-1');
    commit(repo, 'second governed change', 'ADR-2');

    const { exitCode, output } = await validate('HEAD~2..HEAD');

    expect(exitCode).toBe(0);
    expect(output.status).toBe('PASS');
    expect(output.strictTrailerMode.active).toBe(false);
    expect(output.evidence.policyOffenders).toEqual([]);
  });

  it('reports WARN rather than PASS for partial coverage in advisory mode', async () => {
    const repo = makeRepo('WARN');
    commit(repo, 'untrailered advisory change');
    commit(repo, 'trailered advisory change', 'ADR-3');

    const { exitCode, output } = await validate('HEAD~2..HEAD');

    expect(exitCode).toBe(0);
    expect(output.status).toBe('WARN');
    expect(output.evidence.policyOffenders).toHaveLength(1);
  });
});

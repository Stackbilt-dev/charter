import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { doctorCommand } from '../commands/doctor';

const originalCwd = process.cwd();
const tempDirs: string[] = [];
const options: CLIOptions = {
  configPath: '.charter',
  format: 'json',
  ciMode: false,
  yes: false,
};

interface DoctorOutput {
  checks: Array<{ name: string; status: string; details: string }>;
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-doctor-gates-'));
  tempDirs.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, '.charter'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.charter', 'config.json'), JSON.stringify({
    project: 'gate-fixture',
    git: { requireTrailers: true, trailerThreshold: 'HIGH' },
    validation: { citationStrictness: 'FAIL' },
  }));
  process.chdir(repo);
  return repo;
}

async function gateCheck() {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => logs.push(args.map(String).join(' ')));
  await doctorCommand(options, []);
  const output = JSON.parse(logs.join('\n')) as DoctorOutput;
  return output.checks.find(check => check.name === 'gate enforcement');
}

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('charter doctor gate enforcement', () => {
  it('warns when a strict trailer gate has no hook or CI enforcement', async () => {
    makeRepo();

    const check = await gateCheck();

    expect(check?.status).toBe('WARN');
    expect(check?.details).toContain('charter validate --ci');
  });

  it('inspects core.hooksPath and ignores unrelated hooks', async () => {
    const repo = makeRepo();
    execFileSync('git', ['config', 'core.hooksPath', '.githooks']);
    fs.mkdirSync(path.join(repo, '.githooks'));
    fs.writeFileSync(path.join(repo, '.githooks', 'pre-commit'), '#!/bin/sh\npnpm test\n');

    const check = await gateCheck();

    expect(check?.status).toBe('WARN');
    expect(check?.details).toContain('Active hooks directory: .githooks');
  });

  it('warns when the Charter commit-msg normalizer is the only local hook', async () => {
    const repo = makeRepo();
    execFileSync('git', ['config', 'core.hooksPath', '.githooks']);
    fs.mkdirSync(path.join(repo, '.githooks'));
    fs.writeFileSync(
      path.join(repo, '.githooks', 'commit-msg'),
      '#!/bin/sh\n# Managed by Charter: commit-msg trailer normalizer\n',
    );

    const check = await gateCheck();

    expect(check?.status).toBe('WARN');
    expect(check?.details).toContain('.githooks/commit-msg');
    expect(check?.details).toContain('normalizes supplied trailers but does not reject missing trailers');
  });

  it('passes with a local hook that invokes validate --ci', async () => {
    const repo = makeRepo();
    execFileSync('git', ['config', 'core.hooksPath', '.githooks']);
    fs.mkdirSync(path.join(repo, '.githooks'));
    fs.writeFileSync(
      path.join(repo, '.githooks', 'pre-commit'),
      '#!/bin/sh\nnpx charter validate --ci --format text\n',
    );

    const check = await gateCheck();

    expect(check?.status).toBe('PASS');
    expect(check?.details).toContain('.githooks/pre-commit');
  });

  it('passes with a CI validate --ci step', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.github', 'workflows', 'governance.yml'),
      'steps:\n  - run: npx charter validate --format text --ci\n',
    );

    const check = await gateCheck();

    expect(check?.status).toBe('PASS');
    expect(check?.details).toContain('.github/workflows/governance.yml');
  });

  it('does not treat an audit-only workflow as trailer enforcement', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.github', 'workflows', 'governance.yml'),
      'steps:\n  - run: npx charter audit --ci --format json\n',
    );

    expect((await gateCheck())?.status).toBe('WARN');
  });

  it('omits the enforcement check when trailer validation is advisory', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, '.charter', 'config.json'), JSON.stringify({
      git: { requireTrailers: true },
      validation: { citationStrictness: 'WARN' },
    }));

    expect(await gateCheck()).toBeUndefined();
  });
});

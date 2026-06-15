import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectStack, getGithubWorkflow, loadPackageContexts, syncPackageManifest } from '../commands/setup';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('loadPackageContexts + detectStack (npm workspaces)', () => {
  it('discovers packages listed via npm workspaces array glob', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-setup-ws-'));
    tempDirs.push(tmp);
    process.chdir(tmp);

    fs.writeFileSync(
      'package.json',
      JSON.stringify({ name: 'my-monorepo', version: '0.1.0', private: true, workspaces: ['packages/*'] }, null, 2),
    );
    fs.mkdirSync(path.join(tmp, 'packages', 'alpha'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'packages', 'alpha', 'package.json'),
      JSON.stringify({ name: '@mono/alpha', version: '1.0.0', dependencies: { hono: '^4.0.0' } }, null, 2),
    );
    fs.mkdirSync(path.join(tmp, 'packages', 'beta'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'packages', 'beta', 'package.json'),
      JSON.stringify({ name: '@mono/beta', version: '1.0.0' }, null, 2),
    );

    const contexts = loadPackageContexts();
    const sources = contexts.map((c) => c.source);
    expect(sources).toContain('packages/alpha/package.json');
    expect(sources).toContain('packages/beta/package.json');
  });

  it('discovers packages via npm workspaces object form { packages: [...] }', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-setup-ws-obj-'));
    tempDirs.push(tmp);
    process.chdir(tmp);

    fs.writeFileSync(
      'package.json',
      JSON.stringify({
        name: 'obj-monorepo',
        version: '0.1.0',
        private: true,
        workspaces: { packages: ['apps/*'], nohoist: ['**/react'] },
      }, null, 2),
    );
    fs.mkdirSync(path.join(tmp, 'apps', 'web'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'apps', 'web', 'package.json'),
      JSON.stringify({ name: 'web', version: '0.0.1', dependencies: { react: '^18.0.0' } }, null, 2),
    );

    const contexts = loadPackageContexts();
    const sources = contexts.map((c) => c.source);
    expect(sources).toContain('apps/web/package.json');
  });

  it('sets monorepo=true and detects correct preset for npm workspace repo', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-setup-ws-detect-'));
    tempDirs.push(tmp);
    process.chdir(tmp);

    fs.writeFileSync(
      'package.json',
      JSON.stringify({ name: 'hono-mono', version: '0.1.0', private: true, workspaces: ['packages/*'] }, null, 2),
    );
    fs.mkdirSync(path.join(tmp, 'packages', 'api'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'packages', 'api', 'package.json'),
      JSON.stringify({
        name: '@mono/api',
        version: '1.0.0',
        dependencies: { hono: '^4.0.0', wrangler: '^3.0.0' },
      }, null, 2),
    );

    const contexts = loadPackageContexts();
    const result = detectStack(contexts);
    expect(result.monorepo).toBe(true);
    expect(result.suggestedPreset).toBe('worker');
  });
});

describe('syncPackageManifest', () => {
  it('adds ongoing governance scripts during setup sync', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-setup-test-'));
    tempDirs.push(tmp);
    process.chdir(tmp);

    fs.writeFileSync('package.json', JSON.stringify({ name: 'tmp', version: '1.0.0' }, null, 2));

    syncPackageManifest('worker', true, true);

    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['charter:detect']).toBe('charter setup --detect-only --format json');
    expect(pkg.scripts?.['charter:setup']).toBe('charter setup --preset worker --ci github --yes');
    expect(pkg.scripts?.['verify:adf']).toBe('charter doctor --adf-only --ci --format json && charter adf evidence --auto-measure --ci --format json');
    expect(pkg.scripts?.['charter:doctor']).toBe('charter doctor --format json');
    expect(pkg.scripts?.['charter:adf:bundle']).toBe('charter adf bundle --task "describe task" --format json');
  });

  it('github workflow template enforces ADF routing checks', () => {
    const workflow = getGithubWorkflow('pnpm');
    expect(workflow).toContain('ADF Wiring & Pointer Integrity');
    expect(workflow).toContain('npx charter doctor --adf-only --ci --format text');
    expect(workflow).toContain('ADF Evidence');
    expect(workflow).toContain('npx charter adf evidence --auto-measure --ci --format text');
  });

  it('github workflow template refreshes the score badge on push', () => {
    const workflow = getGithubWorkflow('pnpm');
    expect(workflow).toContain('push:');
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('Refresh Score Badge');
    expect(workflow).toContain('npx charter score --badge --write');
    expect(workflow).toContain('Commit Score Badge');
    expect(workflow).toContain('git status --porcelain -- .charter/badge.json');
    expect(workflow).toContain('Governed-By: charter-score-badge');
  });
});

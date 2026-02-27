import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getGithubWorkflow, syncPackageManifest } from '../commands/setup';

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
});

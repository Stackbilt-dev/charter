/**
 * charter adf populate — stack-specific constraint emission (#294)
 *
 * The ESM `.js` extension rule is load-bearing ("violation causes incorrect
 * output"), so it must only appear when the project's TypeScript
 * moduleResolution actually requires extensions on relative imports.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adfCommand } from '../commands/adf';
import type { CLIOptions } from '../index';

const OPTIONS: CLIOptions = {
  configPath: '.charter',
  format: 'text',
  ciMode: false,
  yes: false,
};

const ESM_RULE = 'Use .js extensions for all ESM imports';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function makeTmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'charter-adf-populate-')));
  tempDirs.push(dir);
  process.chdir(dir);
  return dir;
}

/** Writes a file relative to the temp project, creating parent directories. */
function write(dir: string, relative: string, contents: string): void {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

/** Scaffolds `.ai/`, runs `adf populate`, and returns the resulting core.adf. */
async function populate(dir: string): Promise<string> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await adfCommand(OPTIONS, ['init']);
  await adfCommand(OPTIONS, ['populate']);
  return fs.readFileSync(path.join(dir, '.ai', 'core.adf'), 'utf-8');
}

describe('adf populate — ESM extension constraint (#294)', () => {
  it('omits the rule for a bundler project (Vite: type:module + moduleResolution Bundler)', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'vite-app', type: 'module' }));
    write(tmp, 'tsconfig.json', JSON.stringify({
      compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' },
    }));

    expect(await populate(tmp)).not.toContain(ESM_RULE);
  });

  it('emits the rule for a nodenext project', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'node-app', type: 'module' }));
    write(tmp, 'tsconfig.json', JSON.stringify({
      compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext' },
    }));

    expect(await populate(tmp)).toContain(ESM_RULE);
  });

  it('emits the rule when moduleResolution is only implied by module: node16', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'node16-app', type: 'module' }));
    write(tmp, 'tsconfig.json', JSON.stringify({ compilerOptions: { module: 'node16' } }));

    expect(await populate(tmp)).toContain(ESM_RULE);
  });

  it('follows one level of relative extends to find NodeNext', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'extends-app', type: 'module' }));
    write(tmp, 'tsconfig.base.json', JSON.stringify({
      compilerOptions: { moduleResolution: 'NodeNext' },
    }));
    write(tmp, 'tsconfig.json', JSON.stringify({
      extends: './tsconfig.base',
      compilerOptions: { noEmit: true },
    }));

    expect(await populate(tmp)).toContain(ESM_RULE);
  });

  it('omits the rule when a relative extends resolves to bundler', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'extends-bundler', type: 'module' }));
    write(tmp, 'tsconfig.base.json', JSON.stringify({
      compilerOptions: { moduleResolution: 'bundler' },
    }));
    write(tmp, 'tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json' }));

    expect(await populate(tmp)).not.toContain(ESM_RULE);
  });

  it('omits the rule for a solution-style tsconfig that only lists references', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'solution-style', type: 'module' }));
    write(tmp, 'tsconfig.json', JSON.stringify({
      files: [],
      references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
    }));
    write(tmp, 'tsconfig.app.json', JSON.stringify({
      compilerOptions: { moduleResolution: 'bundler' },
    }));

    expect(await populate(tmp)).not.toContain(ESM_RULE);
  });

  it('omits the rule when tsconfig.json is JSONC and cannot be parsed', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'jsonc-app', type: 'module' }));
    write(tmp, 'tsconfig.json', [
      '{',
      '  // TypeScript accepts comments here; JSON.parse does not.',
      '  "compilerOptions": {',
      '    "moduleResolution": "nodenext",',
      '  },',
      '}',
    ].join('\n'));

    expect(await populate(tmp)).not.toContain(ESM_RULE);
  });

  it('omits the rule when extends points at a bare package name', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'preset-app', type: 'module' }));
    write(tmp, 'tsconfig.json', JSON.stringify({ extends: '@tsconfig/node20/tsconfig.json' }));

    expect(await populate(tmp)).not.toContain(ESM_RULE);
  });

  it('emits the rule for a plain JS ESM package with no tsconfig and no typescript dep', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'plain-esm', type: 'module' }));

    expect(await populate(tmp)).toContain(ESM_RULE);
  });

  it('omits the rule when typescript is a dependency but no tsconfig was found', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({
      name: 'ts-no-config',
      type: 'module',
      devDependencies: { typescript: '^5.9.0' },
    }));

    expect(await populate(tmp)).not.toContain(ESM_RULE);
  });

  it('omits the rule when no package declares type: module', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'cjs-app' }));
    write(tmp, 'tsconfig.json', JSON.stringify({
      compilerOptions: { moduleResolution: 'nodenext' },
    }));

    expect(await populate(tmp)).not.toContain(ESM_RULE);
  });

  it('lets a single bundler package veto the rule for the whole repo', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'root-worker', type: 'module' }));
    write(tmp, 'tsconfig.json', JSON.stringify({
      compilerOptions: { moduleResolution: 'nodenext' },
    }));
    write(tmp, 'client/package.json', JSON.stringify({ name: 'client', type: 'module' }));
    write(tmp, 'client/tsconfig.json', JSON.stringify({
      compilerOptions: { moduleResolution: 'bundler' },
    }));

    expect(await populate(tmp)).not.toContain(ESM_RULE);
  });

  it('stops after one level of extends rather than resolving a grandparent', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'two-hop', type: 'module' }));
    write(tmp, 'tsconfig.base.json', JSON.stringify({
      compilerOptions: { moduleResolution: 'nodenext' },
    }));
    write(tmp, 'tsconfig.mid.json', JSON.stringify({ extends: './tsconfig.base' }));
    write(tmp, 'tsconfig.json', JSON.stringify({ extends: './tsconfig.mid.json' }));

    // The nodenext two hops up is real, but MAX_EXTENDS_DEPTH stops before it.
    // Over-resolving would only ever find a true answer, so the boundary is
    // pinned here to keep the miss deliberate rather than accidental.
    expect(await populate(tmp)).not.toContain(ESM_RULE);
  });

  it('emits the rule for a nested package inheriting nodenext from the root tsconfig', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'root', private: true }));
    write(tmp, 'tsconfig.json', JSON.stringify({
      compilerOptions: { moduleResolution: 'nodenext' },
    }));
    write(tmp, 'worker/package.json', JSON.stringify({
      name: 'worker',
      type: 'module',
      devDependencies: { typescript: '^5.9.0' },
    }));

    // Inferred from a different package's config. Defensible — TypeScript's own
    // lookup walks up — but it is the one path where a package with no config of
    // its own still produces a load-bearing rule, so it is pinned deliberately.
    expect(await populate(tmp)).toContain(ESM_RULE);
  });

  it('falls back to the root tsconfig for a nested package that has none', async () => {
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'root', private: true }));
    write(tmp, 'tsconfig.json', JSON.stringify({
      compilerOptions: { moduleResolution: 'Bundler' },
    }));
    write(tmp, 'web/package.json', JSON.stringify({
      name: 'web',
      type: 'module',
      devDependencies: { typescript: '^5.9.0' },
    }));

    expect(await populate(tmp)).not.toContain(ESM_RULE);
  });
});

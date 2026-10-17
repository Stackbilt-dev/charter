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

// ============================================================================
// #371: a CONSTRAINTS section the user edited is left alone
// ============================================================================

const CF_RULE = 'No Node.js-specific APIs in Worker handlers; use CF-native APIs (fetch, KV, D1, R2)';
const ESM_FULL = 'Use .js extensions for all ESM imports (never .ts in import paths)';
const SECRETS_DEFAULT = '  - Never commit secrets or credentials\n';
const CORE = path.join('.ai', 'core.adf');

/** A Worker project; `esm` also makes it plain-JS ESM, so populate wants two constraints. */
function workerRepo(esm = false): string {
  const tmp = makeTmp();
  write(tmp, 'package.json', JSON.stringify({ name: 'demo-371', ...(esm ? { type: 'module' } : {}), devDependencies: { wrangler: '^3.0.0' } }));
  write(tmp, 'wrangler.toml', 'name = "demo"\n');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return tmp;
}

interface Row { file: string; status: string; reason?: string; changes?: string[] }

async function populateJson(args: string[] = []): Promise<Row> {
  const lines: string[] = [];
  vi.mocked(console.log).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  expect(await adfCommand({ ...OPTIONS, format: 'json' }, ['populate', ...args])).toBe(0);
  vi.mocked(console.log).mockImplementation(() => {});
  const rows = (JSON.parse(lines.join('\n')) as { results: Row[] }).results;
  return rows.find(r => r.file === CORE)!;
}

const readCore = (): string => fs.readFileSync(CORE, 'utf-8');
const count = (text: string, needle: string): number => text.split(needle).length - 1;
/** core.adf from the CONSTRAINTS header on (CONTEXT, above it, may legitimately be filled). */
const fromConstraints = (text: string): string => text.slice(text.indexOf('\u26A0\uFE0F CONSTRAINTS'));

describe('adf populate — CONSTRAINTS edits are respected (#371)', () => {
  it('adds the stack constraint once to a template-only CONSTRAINTS, and a second run is a no-op', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    const first = await populateJson();
    expect(first.changes).toContain(`Added CONSTRAINTS item: ${CF_RULE}`);
    expect(first.reason).toBeUndefined();
    const after = readCore();
    expect(count(after, CF_RULE)).toBe(1);

    const second = await populateJson();
    expect(second.status).toBe('skipped');
    expect(second.reason).toBeUndefined();
    expect(readCore()).toBe(after);
  });

  it('a deleted default stays deleted, and the stack constraint is not added (reason in JSON)', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    const edited = readCore().replace(SECRETS_DEFAULT, '');
    fs.writeFileSync(CORE, edited);

    const row = await populateJson();
    const core = readCore();
    expect(core).not.toContain('Never commit secrets');
    expect(core).not.toContain(CF_RULE);
    expect(row.status).toBe('populated');
    expect(row.changes).toEqual(['Filled CONTEXT']);
    expect(row.reason).toContain('CONSTRAINTS was edited');
    expect(row.reason).toContain(CF_RULE);
    expect(fromConstraints(core)).toBe(fromConstraints(edited));
  });

  it('a user-added bullet leaves CONSTRAINTS untouched', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    fs.writeFileSync(CORE, readCore().replace(SECRETS_DEFAULT, `${SECRETS_DEFAULT}  - CUSTOM: money math in integer cents\n`));
    const before = readCore();
    const row = await populateJson();
    expect(readCore()).not.toContain(CF_RULE);
    expect(fromConstraints(readCore())).toBe(fromConstraints(before));
    expect(row.reason).toContain('CONSTRAINTS was edited');
  });

  it('a reworded default leaves CONSTRAINTS untouched', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    fs.writeFileSync(CORE, readCore().replace('Never commit secrets or credentials', 'Never commit secrets'));
    await populateJson();
    expect(readCore()).not.toContain(CF_RULE);
  });

  it('an emptied CONSTRAINTS (every default deleted) counts as an edit', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    const core = readCore();
    const header = '\u26A0\uFE0F CONSTRAINTS [load-bearing]:\n';
    const start = core.indexOf(header) + header.length;
    const emptied = core.slice(0, start) + core.slice(core.indexOf('\n\n', start) + 1);
    fs.writeFileSync(CORE, emptied);
    const row = await populateJson();
    expect(readCore()).not.toContain(CF_RULE);
    expect(fromConstraints(readCore())).toBe(fromConstraints(emptied));
    expect(row.reason).toContain('CONSTRAINTS was edited');
  });

  it("deleting one of populate's own earlier bullets is an edit: it is not re-added", async () => {
    workerRepo(true);
    await adfCommand(OPTIONS, ['init']);
    await populateJson();
    expect(readCore()).toContain(CF_RULE);
    expect(readCore()).toContain(ESM_FULL);
    const edited = readCore().replace(`  - ${CF_RULE}\n`, '');
    fs.writeFileSync(CORE, edited);
    const row = await populateJson();
    expect(readCore()).toBe(edited);
    expect(row.reason).toContain(CF_RULE);
  });

  it('a missing CONSTRAINTS section is created with the stack constraints, once', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    const core = readCore();
    const start = core.indexOf('\u26A0\uFE0F CONSTRAINTS');
    fs.writeFileSync(CORE, core.slice(0, start) + core.slice(core.indexOf('\n\n', start) + 2));
    expect(readCore()).not.toContain('\u26A0\uFE0F CONSTRAINTS');

    const row = await populateJson();
    expect(row.changes).toContain('Filled CONSTRAINTS');
    const after = readCore();
    expect(after).toContain(`\u26A0\uFE0F CONSTRAINTS [load-bearing]:\n  - ${CF_RULE}\n`);
    expect(after).not.toContain('Never commit secrets');

    const again = await populateJson();
    expect(again.reason).toBeUndefined();
    expect(readCore()).toBe(after);
  });

  it('CRLF: a template-only CONSTRAINTS gets the bullet with CRLF; an edited one stays byte-identical', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    fs.writeFileSync(CORE, readCore().replace(/\n/g, '\r\n'));
    await populateJson();
    const filled = readCore();
    expect(filled).toContain(`  - Pure functions in library code; side effects only in entry points\r\n  - ${CF_RULE}\r\n`);
    expect(filled).not.toMatch(/[^\r]\n/);

    const edited = filled.replace(`  - ${CF_RULE}\r\n`, '').replace('  - Never commit secrets or credentials\r\n', '');
    fs.writeFileSync(CORE, edited);
    await populateJson();
    expect(readCore()).toBe(edited);
  });

  it('--force keeps the additive add into an edited CONSTRAINTS (semantics unchanged)', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    fs.writeFileSync(CORE, readCore().replace(SECRETS_DEFAULT, ''));
    const row = await populateJson(['--force']);
    const core = readCore();
    expect(row.changes).toContain(`Added CONSTRAINTS item: ${CF_RULE}`);
    expect(row.reason).toBeUndefined();
    expect(count(core, CF_RULE)).toBe(1);
    // --force restores no deleted default; it only adds missing stack constraints.
    expect(core).not.toContain('Never commit secrets');
    await populateJson(['--force']);
    expect(count(readCore(), CF_RULE)).toBe(1);
  });

  it('--force fills an emptied CONSTRAINTS with the stack constraints', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    const core = readCore();
    const header = 'CONSTRAINTS [load-bearing]:\n';
    const start = core.indexOf(header) + header.length;
    fs.writeFileSync(CORE, core.slice(0, start) + core.slice(core.indexOf('\n\n', start) + 1));
    await populateJson(['--force']);
    expect(readCore()).toContain(`${header}  - ${CF_RULE}\n\n`);
  });

  it('text output names the reason on the core.adf line', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    fs.writeFileSync(CORE, readCore().replace(SECRETS_DEFAULT, ''));
    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    await adfCommand(OPTIONS, ['populate']);
    expect(lines.find(l => l.includes(CORE))).toMatch(/1 op applied; CONSTRAINTS was edited/);
  });
});

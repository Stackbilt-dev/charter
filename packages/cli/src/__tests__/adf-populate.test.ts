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
import { applyOpsAsText } from '../commands/adf-text-patch';
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

interface Row { file: string; status: string; reason?: string; changes?: string[]; notAdded?: { section: string; why: string; constraints: string[] } }

async function populateRows(args: string[] = []): Promise<Row[]> {
  const lines: string[] = [];
  vi.mocked(console.log).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  expect(await adfCommand({ ...OPTIONS, format: 'json' }, ['populate', ...args])).toBe(0);
  vi.mocked(console.log).mockImplementation(() => {});
  return (JSON.parse(lines.join('\n')) as { results: Row[] }).results;
}

async function populateJson(args: string[] = []): Promise<Row> {
  return (await populateRows(args)).find(r => r.file === CORE)!;
}

const readCore = (): string => fs.readFileSync(CORE, 'utf-8');
const count = (text: string, needle: string): number => text.split(needle).length - 1;
/** core.adf from the CONSTRAINTS header on (CONTEXT, above it, may legitimately be filled). */
const fromConstraints = (text: string): string => text.slice(text.indexOf('\u26A0\uFE0F CONSTRAINTS'));
/** core.adf from the GUIDE header on. */
const fromGuide = (text: string): string => text.slice(text.indexOf('GUIDE [advisory]:'));

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
    expect(row.reason).toContain('CONSTRAINTS has been edited');
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
    expect(row.reason).toContain('CONSTRAINTS has been edited');
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
    expect(row.reason).toContain('CONSTRAINTS has been edited');
  });

  it("deleting one of populate's own earlier bullets: it is not re-added, silently (it is recorded)", async () => {
    workerRepo(true);
    await adfCommand(OPTIONS, ['init']);
    await populateJson();
    expect(readCore()).toContain(CF_RULE);
    expect(readCore()).toContain(ESM_FULL);
    const edited = readCore().replace(`  - ${CF_RULE}\n`, '');
    fs.writeFileSync(CORE, edited);
    const row = await populateJson();
    expect(readCore()).toBe(edited);
    expect(row.status).toBe('skipped');
    expect(row.reason).toBeUndefined();
  });

  it('single constraint (plain Worker): deleting the one bullet populate added sticks across runs (finding 2)', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    const template = readCore();
    await populateJson();
    expect(count(readCore(), CF_RULE)).toBe(1);
    // Deleting it leaves CONSTRAINTS byte-for-byte the template's again.
    const edited = readCore().replace(`  - ${CF_RULE}\n`, '');
    expect(fromConstraints(edited)).toBe(fromConstraints(template));
    fs.writeFileSync(CORE, edited);
    for (let i = 0; i < 2; i++) {
      const row = await populateJson();
      expect(readCore()).toBe(edited);
      expect(row.reason).toBeUndefined();
    }
  });

  it('not-a-list CONSTRAINTS: left alone, hint says to add by hand, never mentions --force', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    const core = readCore();
    const header = 'CONSTRAINTS [load-bearing]:';
    const start = core.indexOf(header);
    const textual = core.slice(0, start) + `${header} none yet\n` + core.slice(core.indexOf('\n\n', start) + 1);
    fs.writeFileSync(CORE, textual);
    const row = await populateJson();
    expect(fromConstraints(readCore())).toBe(fromConstraints(textual));
    expect(row.reason).toContain('CONSTRAINTS is not a list, so populate did not add the stack constraint');
    expect(row.reason).toContain('Add it by hand if you want it');
    expect(row.reason).not.toContain('--force');
    expect(row.notAdded).toEqual({ section: 'CONSTRAINTS', why: 'not-a-list', constraints: [CF_RULE] });
  });

  it('duplicate CONSTRAINTS headers: the first is the one judged and edited', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    fs.writeFileSync(CORE, `${readCore()}\nCONSTRAINTS:\n  - second section\n`);
    await populateJson();
    const after = readCore();
    // The first (template) section gets the bullet; the second is untouched.
    expect(after).toContain(`  - Pure functions in library code; side effects only in entry points\n  - ${CF_RULE}\n`);
    expect(after.endsWith('\nCONSTRAINTS:\n  - second section\n')).toBe(true);
    expect(count(after, CF_RULE)).toBe(1);

    // Edited first section: neither is touched.
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    const edited = `${readCore().replace(SECRETS_DEFAULT, '')}\nCONSTRAINTS:\n  - second section\n`;
    fs.writeFileSync(CORE, edited);
    const row = await populateJson();
    expect(fromConstraints(readCore())).toBe(fromConstraints(edited));
    expect(row.notAdded?.why).toBe('edited');
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
    expect(lines.find(l => l.includes(CORE))).toMatch(/1 op applied; CONSTRAINTS has been edited/);
  });
});

describe('adf populate — the populate record, .ai/.populate.json (#371)', () => {
  const RECORD = path.join('.ai', '.populate.json');
  const readRecord = (): string => fs.readFileSync(RECORD, 'utf-8');

  it('is created on the first add, deterministic, and not rewritten by a run with nothing to do', async () => {
    workerRepo(true);
    await adfCommand(OPTIONS, ['init']);
    expect(fs.existsSync(RECORD)).toBe(false);
    const rows = await populateRows();
    expect(rows.find(r => r.file === RECORD)?.changes).toEqual(['Created .ai/.populate.json']);
    expect(readRecord()).toBe(JSON.stringify({
      version: 1,
      constraints: { 'core.adf': { added: [CF_RULE, ESM_FULL].sort(), offered: [] } },
    }, null, 2) + '\n');

    const before = fs.statSync(RECORD).mtimeMs;
    const text = readRecord();
    const again = await populateRows();
    expect(again.find(r => r.file === RECORD)).toBeUndefined();
    expect(readRecord()).toBe(text);
    expect(fs.statSync(RECORD).mtimeMs).toBe(before);
  });

  it('is not written by --dry-run', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    const rows = await populateRows(['--dry-run']);
    expect(rows.find(r => r.file === RECORD)?.changes).toEqual(['Created .ai/.populate.json']);
    expect(fs.existsSync(RECORD)).toBe(false);
  });

  it('a deleted CONSTRAINTS section is not recreated once the file has a record', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    await populateJson();
    const core = readCore();
    const start = core.indexOf('\u26A0\uFE0F CONSTRAINTS');
    const removed = core.slice(0, start) + core.slice(core.indexOf('\n\n', start) + 2);
    fs.writeFileSync(CORE, removed);
    const row = await populateJson();
    expect(readCore()).toBe(removed);
    // CF_RULE is recorded as added, so there is nothing new to offer either.
    expect(row.reason).toBeUndefined();
  });

  it('an edited section: a newly detected constraint is warned about once, recorded as offered, then quiet', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    await populateJson(); // adds CF_RULE, records it
    fs.writeFileSync(CORE, readCore().replace(SECRETS_DEFAULT, ''));
    const edited = readCore();
    // The stack gains plain-JS ESM: a new constraint for an edited section.
    write(process.cwd(), 'package.json', JSON.stringify({ name: 'demo-371', type: 'module', devDependencies: { wrangler: '^3.0.0' } }));

    const first = await populateJson();
    expect(readCore()).toBe(edited);
    expect(first.reason).toContain(`CONSTRAINTS has been edited, so populate did not add the stack constraint: ${ESM_FULL}. Add it by hand if you want it`);
    expect(first.reason).not.toContain('--force');
    expect(first.notAdded).toEqual({ section: 'CONSTRAINTS', why: 'edited', constraints: [ESM_FULL] });
    expect(JSON.parse(readRecord()).constraints['core.adf']).toEqual({ added: [CF_RULE], offered: [ESM_FULL] });

    const record = readRecord();
    const second = await populateJson();
    expect(second.reason).toBeUndefined();
    expect(second.notAdded).toBeUndefined();
    expect(readRecord()).toBe(record);
    expect(readCore()).toBe(edited);
  });

  it('an untouched section (template plus recorded bullets) still gets a newly detected constraint', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    await populateJson();
    write(process.cwd(), 'package.json', JSON.stringify({ name: 'demo-371', type: 'module', devDependencies: { wrangler: '^3.0.0' } }));
    const row = await populateJson();
    expect(row.changes).toContain(`Added CONSTRAINTS item: ${ESM_FULL}`);
    expect(row.reason).toBeUndefined();
    expect(JSON.parse(readRecord()).constraints['core.adf'].added).toEqual([CF_RULE, ESM_FULL].sort());
  });

  it('--force appends a recorded-but-deleted constraint, as before, and keeps it recorded', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    await populateJson();
    fs.writeFileSync(CORE, readCore().replace(`  - ${CF_RULE}\n`, '').replace(SECRETS_DEFAULT, ''));
    const record = readRecord();
    const row = await populateJson(['--force']);
    expect(row.changes).toContain(`Added CONSTRAINTS item: ${CF_RULE}`);
    expect(readRecord()).toBe(record);
  });

  const INVALID: Array<[string, string]> = [
    ['not JSON', '{ not json'],
    ['version 2', JSON.stringify({ version: 2, constraints: { 'core.adf': { added: [], offered: [] } } })],
    ['an array "constraints"', JSON.stringify({ version: 1, constraints: [] })],
    ['a string "added"', JSON.stringify({ version: 1, constraints: { 'core.adf': { added: 'x', offered: [] } } })],
    ['a non-string item', JSON.stringify({ version: 1, constraints: { 'core.adf': { added: [1], offered: [] } } })],
    ['an entry that is not an object', JSON.stringify({ version: 1, constraints: { 'core.adf': [] } })],
  ];
  for (const [label, text] of INVALID) {
    it(`an invalid record (${label}) blocks every stack constraint: core.adf CONSTRAINTS byte-identical, record untouched, warned once`, async () => {
      workerRepo();
      await adfCommand(OPTIONS, ['init']);
      // CONSTRAINTS deleted entirely and CF_RULE missing: a valid empty record would recreate it.
      const core = readCore();
      const start = core.indexOf('\u26A0\uFE0F CONSTRAINTS');
      fs.writeFileSync(CORE, core.slice(0, start) + core.slice(core.indexOf('\n\n', start) + 2));
      const before = readCore();
      fs.writeFileSync(RECORD, text);
      const rows = await populateRows();
      const recordRows = rows.filter(r => r.file === RECORD);
      expect(recordRows).toHaveLength(1);
      expect(recordRows[0].status).toBe('refused');
      expect(recordRows[0].reason).toMatch(/^could not be read \(.+\), so populate added no stack constraints this run; fix or delete it$/);
      expect(readRecord()).toBe(text);
      // CONTEXT is still filled; nothing else in core.adf changes.
      const coreRow = rows.find(r => r.file === CORE)!;
      expect(coreRow.changes).toEqual(['Filled CONTEXT']);
      expect(fromGuide(readCore())).toBe(fromGuide(before));
      expect(readCore()).not.toContain('\u26A0\uFE0F CONSTRAINTS');
    });
  }

  it('a record with a UTF-8 BOM is read normally', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    await populateJson();
    fs.writeFileSync(CORE, readCore().replace(`  - ${CF_RULE}\n`, ''));
    const edited = readCore();
    fs.writeFileSync(RECORD, String.fromCharCode(0xfeff) + readRecord());
    const rows = await populateRows();
    expect(rows.find(r => r.file === RECORD)).toBeUndefined();
    expect(readCore()).toBe(edited);
  });

  it('keys are bare module names: ".ai/core.adf" means core.adf, and nothing is duplicated', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    fs.writeFileSync(RECORD, JSON.stringify({ version: 1, constraints: { '.ai/core.adf': { added: [CF_RULE], offered: [] } } }));
    const edited = readCore();
    const row = await populateJson();
    expect(fromConstraints(readCore())).toBe(fromConstraints(edited));
    expect(readCore()).not.toContain(CF_RULE);
    expect(row.reason).toBeUndefined();
    // Not rewritten: nothing was added or offered.
    expect(readRecord()).toBe(JSON.stringify({ version: 1, constraints: { '.ai/core.adf': { added: [CF_RULE], offered: [] } } }));
  });

  it('a "__proto__" key is kept as an ordinary key when the record is rewritten', async () => {
    workerRepo(true);
    await adfCommand(OPTIONS, ['init']);
    fs.writeFileSync(RECORD, '{"version":1,"constraints":{"__proto__":{"added":["p"],"offered":[]},"core.adf":{"added":["' + CF_RULE + '"],"offered":[]}}}');
    await populateJson(); // adds ESM_FULL to the template section, so the record is rewritten
    const parsed = JSON.parse(readRecord());
    expect(Object.keys(parsed.constraints)).toEqual(['__proto__', 'core.adf']);
    expect(Object.getOwnPropertyDescriptor(parsed.constraints, '__proto__')?.value).toEqual({ added: ['p'], offered: [] });
    expect(parsed.constraints['core.adf'].added).toEqual([CF_RULE, ESM_FULL].sort());
  });
});

describe('adf populate — where a created CONSTRAINTS goes (#371)', () => {
  const body = `\u26A0\uFE0F CONSTRAINTS [load-bearing]:\n  - ${CF_RULE}\n`;

  it('the scaffold with CONSTRAINTS deleted: it comes back where the scaffold has it (after GUIDE, before METRICS)', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    const scaffold = readCore();
    const start = scaffold.indexOf('\u26A0\uFE0F CONSTRAINTS');
    const end = scaffold.indexOf('\n\n', start) + 2;
    fs.writeFileSync(CORE, scaffold.slice(0, start) + scaffold.slice(end));
    await populateJson();
    const after = readCore();
    const order = ['CONTEXT:', 'GUIDE [advisory]:', 'CONSTRAINTS [load-bearing]:', 'METRICS:'].map(h => after.indexOf(h));
    expect(order.every((at, i) => at > (order[i - 1] ?? -1))).toBe(true);
    expect(after).toContain(`custom\n\n${body}\n\u{1F4CA} METRICS:`);
  });

  it('after CONTEXT when CONTEXT comes after GUIDE', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    fs.writeFileSync(CORE, 'ADF: 0.1\n\nGUIDE:\n  - g\n\n\u{1F4CB} CONTEXT:\n  - mine\n\n\u{1F4CA} METRICS:\n  entry_loc: 1 / 2 [lines]\n');
    await populateJson();
    expect(readCore()).toBe(`ADF: 0.1\n\nGUIDE:\n  - g\n\n\u{1F4CB} CONTEXT:\n  - mine\n\n${body}\n\u{1F4CA} METRICS:\n  entry_loc: 1 / 2 [lines]\n`);
  });

  it('with no CONTEXT, populate appends one and CONSTRAINTS follows that new CONTEXT, keeping CRLF', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    fs.writeFileSync(CORE, 'ADF: 0.1\r\n\r\nGUIDE:\r\n  - g\r\n\r\n\u{1F4CA} METRICS:\r\n  entry_loc: 1 / 2 [lines]\r\n');
    const row = await populateJson();
    expect(row.changes).toEqual(['Filled CONTEXT', 'Filled CONSTRAINTS']);
    const after = readCore();
    expect(after).not.toMatch(/[^\r]\n/);
    const sections = [...after.matchAll(/^(?:\S+ )?([A-Z]+)(?: \[[a-z-]+\])?:/gm)].map(m => m[1]);
    expect(sections).toEqual(['ADF', 'GUIDE', 'METRICS', 'CONTEXT', 'CONSTRAINTS']);
    expect(after).toMatch(/CONTEXT:\r\n(?: {2}- .*\r\n)+\r\n\u26A0\uFE0F CONSTRAINTS \[load-bearing\]:\r\n {2}- No Node/);
  });

  it('at the end of a CONTEXT that is the last section without a trailing newline', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    fs.writeFileSync(CORE, 'ADF: 0.1\n\n\u{1F4CB} CONTEXT:\n  - mine');
    await populateJson();
    expect(readCore()).toBe(`ADF: 0.1\n\n\u{1F4CB} CONTEXT:\n  - mine\n\n${body.slice(0, -1)}`);
  });

  it('before METRICS when neither CONTEXT nor GUIDE is present (text-patch, guard intact)', () => {
    const text = 'ADF: 0.1\n\nNOTES:\n  - n\n\n\u{1F4CA} METRICS:\n  entry_loc: 1 / 2 [lines]\n';
    const r = applyOpsAsText(text, [{
      op: 'ADD_SECTION', key: 'CONSTRAINTS', decoration: '⚠', weight: 'load-bearing',
      content: { type: 'list', items: ['x'] }, anchor: { after: ['CONTEXT', 'GUIDE'], before: ['METRICS'] },
    }]);
    expect(r).toEqual({
      status: 'applied',
      next: 'ADF: 0.1\n\nNOTES:\n  - n\n\n\u26A0\uFE0F CONSTRAINTS [load-bearing]:\n  - x\n\n\u{1F4CA} METRICS:\n  entry_loc: 1 / 2 [lines]\n',
    });
  });
});

describe('adf populate — round 3 review fixes (#371)', () => {
  const RECORD = path.join('.ai', '.populate.json');

  it("a skipped core.adf row never suggests --force", async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    await populateJson();
    const core = readCore();
    const start = core.indexOf('CONSTRAINTS [load-bearing]:\n');
    const from = core.lastIndexOf('\n\n', start) + 2;
    fs.writeFileSync(CORE, core.slice(0, from) + core.slice(core.indexOf('\n\n', start) + 2));
    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    await adfCommand(OPTIONS, ['populate']);
    const line = lines.find(l => l.includes(CORE))!;
    expect(line).toContain('[skip]');
    expect(line).toContain('CONTEXT already customized; no stack constraints to add');
    expect(lines.join('\n')).not.toMatch(/core\.adf.*--force/);
  });

  it('the record row has status "recorded", not "populated"', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    const rows = await populateRows();
    expect(rows.find(r => r.file === RECORD)?.status).toBe('recorded');
  });

  it('adf init --reset-adf drops core.adf from the record (backed up), so populate fills the rule in again', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    await populateJson();
    fs.writeFileSync(CORE, readCore().replace(`  - ${CF_RULE}\n`, ''));
    const recordBefore = fs.readFileSync(RECORD, 'utf-8');
    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    expect(await adfCommand({ ...OPTIONS, yes: true }, ['init', '--reset-adf', '--yes'])).toBe(0);
    const out = lines.join('\n');
    expect(out).toMatch(/Dropped core\.adf from \.ai\/\.populate\.json \(backup: \.ai\/\.backup\/\.populate\.json\.[^)]+\), so populate treats the reset module as new\./);
    const backup = fs.readdirSync(path.join('.ai', '.backup')).find(f => f.startsWith('.populate.json.'))!;
    expect(fs.readFileSync(path.join('.ai', '.backup', backup), 'utf-8')).toBe(recordBefore);
    expect(JSON.parse(fs.readFileSync(RECORD, 'utf-8')).constraints).toEqual({});
    vi.mocked(console.log).mockImplementation(() => {});
    const row = await populateJson();
    expect(row.changes).toContain(`Added CONSTRAINTS item: ${CF_RULE}`);
    expect(count(readCore(), CF_RULE)).toBe(1);
  });

  it('adf init --reset-adf with nothing recorded for a replaced module leaves the record alone', async () => {
    workerRepo();
    await adfCommand(OPTIONS, ['init']);
    fs.writeFileSync(RECORD, JSON.stringify({ version: 1, constraints: { 'other.adf': { added: ['x'], offered: [] } } }));
    const text = fs.readFileSync(RECORD, 'utf-8');
    fs.writeFileSync(CORE, readCore().replace(SECRETS_DEFAULT, ''));
    expect(await adfCommand({ ...OPTIONS, yes: true }, ['init', '--reset-adf', '--yes'])).toBe(0);
    expect(fs.readFileSync(RECORD, 'utf-8')).toBe(text);
    expect(fs.readdirSync(path.join('.ai', '.backup')).some(f => f.startsWith('.populate.json.'))).toBe(false);
  });
});

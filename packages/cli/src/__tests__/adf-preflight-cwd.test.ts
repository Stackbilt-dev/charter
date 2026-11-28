/**
 * Round-2 review follow-ups for the #447 preflight slice (PR #455):
 * - rules and ceilings resolve --files through one helper, so the answer is
 *   the same from the repo root, from packages/cli, and over MCP from any cwd;
 * - locate() handles column-0 list items;
 * - MCP keeps the task's bundle when task and files are given and nothing binds;
 * - multi-file Binds names the file each module applies to.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { adfContextCommand } from '../commands/adf-context';
import { locate } from '../commands/adf-preflight';
import type { FileCeiling } from '../commands/adf-ceilings';
import { projectContextContent, resolveProjectContext } from '../commands/project-context';

const originalCwd = process.cwd();
const repoRoot = path.resolve(__dirname, '../../../..');
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function run(format: 'json' | 'text', args: string[]): { code: number; out: string[] } {
  const options: CLIOptions = { configPath: tempDir('charter-cwd-cfg-'), format, ciMode: false, yes: false };
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => { out.push(String(msg ?? '')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = adfContextCommand(options, args);
  vi.restoreAllMocks();
  return { code, out };
}

function runJson(args: string[]): Record<string, unknown> {
  const r = run('json', args);
  expect(r.code).toBe(0);
  return JSON.parse(r.out.join('\n')) as Record<string, unknown>;
}

const MIGRATE = 'packages/cli/src/commands/adf-migrate.ts';

describe('this repo: same Binds and Headroom from the root and from packages/cli', () => {
  it('relative (repo- and cwd-relative) and absolute paths agree with the root run', () => {
    process.chdir(repoRoot);
    const rootJson = runJson(['--files', MIGRATE]);
    const rootText = run('text', ['--files', MIGRATE]).out;
    expect((rootJson.ceilings as FileCeiling[]).map(c => c.metric)).toContain('adf_migrate_loc');
    expect(rootText.some(l => l.startsWith('Headroom:  adf_migrate_loc'))).toBe(true);

    process.chdir(path.join(repoRoot, 'packages', 'cli'));
    const spellings = [MIGRATE, 'src/commands/adf-migrate.ts', path.join(repoRoot, ...MIGRATE.split('/'))];
    for (const spelling of spellings) {
      const sub = runJson(['--files', spelling, '--ai-dir', '../../.ai']);
      expect(sub.resolvedModules, spelling).toEqual(rootJson.resolvedModules);
      expect(sub.rules, spelling).toEqual(rootJson.rules);
      expect(sub.ceilings, spelling).toEqual(rootJson.ceilings);
      expect(sub.binds, spelling).toBe(true);
      expect(run('text', ['--files', spelling, '--ai-dir', '../../.ai']).out, spelling).toEqual(rootText);
    }
  });

  it('MCP with an absolute aiDir finds the ceiling from any cwd (repo root, packages, temp)', () => {
    const aiDir = path.join(repoRoot, '.ai');
    process.chdir(repoRoot);
    const atRoot = resolveProjectContext(aiDir, undefined, [MIGRATE]);
    expect(atRoot.preflight?.ceilings.map(c => c.metric)).toContain('adf_migrate_loc');
    for (const cwd of [path.join(repoRoot, 'packages'), tempDir('charter-mcp-cwd-')]) {
      process.chdir(cwd);
      const r = resolveProjectContext(aiDir, undefined, [MIGRATE]);
      expect(r.preflight?.rules, cwd).toEqual(atRoot.preflight?.rules);
      expect(r.preflight?.ceilings, cwd).toEqual(atRoot.preflight?.ceilings);
      expect(r.preflightText, cwd).toBe(atRoot.preflightText);
    }
  });
});

describe('locate() with column-0 list items', () => {
  it('reports each item on its own line, as for indented items', () => {
    const flat = ['ADF: 0.1', '', 'CONSTRAINTS [load-bearing]:', '- first rule', '- second rule'];
    expect(locate(flat, 'CONSTRAINTS', ['first rule', 'second rule'])).toEqual([4, 5]);
    const indented = ['ADF: 0.1', '', 'CONSTRAINTS [load-bearing]:', '  - first rule', '  - second rule'];
    expect(locate(indented, 'CONSTRAINTS', ['first rule', 'second rule'])).toEqual([4, 5]);
  });

  it('stops at the next section header, so a later match is not taken', () => {
    const lines = ['CONSTRAINTS [load-bearing]:', '- first rule', 'CONTEXT:', '- missing rule'];
    expect(locate(lines, 'CONSTRAINTS', ['first rule', 'missing rule'])).toEqual([2, 1]);
  });
});

/** Small fixture: billing.adf on demand, a ceiling on src/billing/ledger.ts. */
function setupRepo(): string {
  const tmp = tempDir('charter-cwd-repo-');
  fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'billing'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), `ADF: 0.1
DEFAULT_LOAD:
  - core.adf

ON_DEMAND:
  - billing.adf (Triggers on: billing)
  - notes.adf (Triggers on: notes)

METRICS:
  LEDGER_LOC: src/billing/ledger.ts
`);
  fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), 'ADF: 0.1\nCONSTRAINTS [load-bearing]:\n  - Default rule applies everywhere\n\nMETRICS:\n  ledger_loc: 1 / 12 [lines]\n');
  fs.writeFileSync(path.join(tmp, '.ai', 'billing.adf'), 'ADF: 0.1\nCONSTRAINTS [load-bearing]:\n- Amounts are integer cents\n');
  fs.writeFileSync(path.join(tmp, '.ai', 'notes.adf'), 'ADF: 0.1\nCONSTRAINTS [load-bearing]:\n  - Notes are append-only\n');
  fs.writeFileSync(path.join(tmp, 'src', 'billing', 'ledger.ts'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(tmp, 'src', 'notes.ts'), 'n\n');
  fs.writeFileSync(path.join(tmp, 'src', 'plain.yml'), 'x: 1\n');
  process.chdir(tmp);
  return process.cwd();
}

describe('column-0 rules end to end', () => {
  it('a module written with `- rule` reports the rule line, not the header', () => {
    setupRepo();
    const out = runJson(['--files', 'src/billing/ledger.ts']);
    expect(out.rules).toEqual([expect.objectContaining({ module: 'billing.adf', rule: 'Amounts are integer cents', line: 3 })]);
  });
});

describe('MCP: task and files, nothing binds the files', () => {
  it('still returns the task bundle, then the nothing-binds line and the JSON', () => {
    const root = setupRepo();
    const result = resolveProjectContext(path.join(root, '.ai'), 'release checklist', ['src/plain.yml']);
    const content = projectContextContent(result);
    expect(content).toHaveLength(3);
    expect(content[0].text).toMatch(/^ADF: 0\.1/);
    expect(content[0].text).toContain('Default rule applies everywhere');
    expect(content[1].text).toBe('Nothing binds src/plain.yml: no on-demand module or ceiling applies. Default modules only.');
    expect(JSON.parse(content[2].text)).toEqual({ rules: [], ceilings: [], unreadable: [], binds: false });
  });

  it('files only (no task) keeps the short answer without the bundle', () => {
    const root = setupRepo();
    const content = projectContextContent(resolveProjectContext(path.join(root, '.ai'), undefined, ['src/plain.yml']));
    expect(content).toHaveLength(2);
    expect(content[0].text).toMatch(/^Nothing binds/);
    const blank = projectContextContent(resolveProjectContext(path.join(root, '.ai'), '   ', ['src/plain.yml']));
    expect(blank).toHaveLength(2);
  });
});

describe('multi-file Binds attribution', () => {
  it('names the file whose path triggers each module, and the task keywords otherwise', () => {
    setupRepo();
    const r = run('text', ['--files', 'src/billing/ledger.ts,src/notes.ts']);
    expect(r.out).toContain('Binds:     billing.adf → "Amounts are integer cents"  (.ai/billing.adf:3) for src/billing/ledger.ts');
    expect(r.out).toContain('           notes.adf → "Notes are append-only"  (.ai/notes.adf:3) for src/notes.ts');

    const kw = run('text', ['--files', 'src/plain.yml,src/notes.ts', '--keywords', 'billing']);
    expect(kw.out).toContain('Binds:     billing.adf → "Amounts are integer cents"  (.ai/billing.adf:3) for the task keywords');
  });

  it('a module every file triggers has no suffix', () => {
    setupRepo();
    fs.writeFileSync(path.join('src', 'billing', 'refunds.ts'), 'r\n');
    const r = run('text', ['--files', 'src/billing/ledger.ts,src/billing/refunds.ts']);
    expect(r.out[0]).toBe('Binds:     billing.adf → "Amounts are integer cents"  (.ai/billing.adf:3)');
  });

  it('a single file keeps the unsuffixed line', () => {
    setupRepo();
    const r = run('text', ['--files', 'src/billing/ledger.ts']);
    expect(r.out[0]).toBe('Binds:     billing.adf → "Amounts are integer cents"  (.ai/billing.adf:3)');
  });
});

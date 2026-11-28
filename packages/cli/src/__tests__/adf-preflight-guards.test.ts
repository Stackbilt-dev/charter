/**
 * Review follow-ups for the #447 preflight slice (PR #455): absolute and
 * Windows-style --files paths, unparseable modules, exact section-header
 * location, repo-root display paths, the MCP content array, --bundle text,
 * and multi-file output.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CLIOptions } from '../index';
import { adfContextCommand, filePathToKeywords as contextFilePathToKeywords } from '../commands/adf-context';
import { filePathToKeywords } from '../commands/adf-path-tokens';
import { locate, sectionHeaderRe } from '../commands/adf-preflight';
import type { BindingRule, UnreadableModule } from '../commands/adf-preflight';
import type { FileCeiling } from '../commands/adf-ceilings';
import { registerTools } from '../commands/serve';

const originalCwd = process.cwd();
const repoRoot = path.resolve(__dirname, '../../../..');
const tempDirs: string[] = [];
const isWin = process.platform === 'win32';

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

function opts(format: 'json' | 'text'): CLIOptions {
  return { configPath: tempDir('charter-guards-cfg-'), format, ciMode: false, yes: false };
}

interface Run { code: number; out: string[]; err: string[] }

function run(format: 'json' | 'text', args: string[]): Run {
  const options = opts(format);
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => { out.push(String(msg ?? '')); });
  vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => { err.push(String(msg ?? '')); });
  const code = adfContextCommand(options, args);
  vi.restoreAllMocks();
  return { code, out, err };
}

function runJson(args: string[]): Record<string, unknown> {
  const r = run('json', args);
  expect(r.code).toBe(0);
  return JSON.parse(r.out.join('\n')) as Record<string, unknown>;
}

/**
 * Fixture repo nested under `Users/kover/Documents/`, with an on-demand
 * module that triggers on `users` -- the shape of the review finding, where
 * the checkout's own `C:\Users\...` routed typed-data-access.adf.
 */
function setupRepo(): string {
  const base = tempDir('charter-guards-');
  const tmp = path.join(base, 'Users', 'kover', 'Documents', 'repo');
  fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'billing'), { recursive: true });
  process.chdir(tmp);
  fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), `ADF: 0.1
DEFAULT_LOAD:
  - core.adf

ON_DEMAND:
  - billing.adf (Triggers on: billing)
  - people.adf (Triggers on: users, kover)

METRICS:
  LEDGER_LOC: src/billing/ledger.ts
  NOTES_LOC: src/notes.ts
`);
  fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), `ADF: 0.1
CONSTRAINTS [load-bearing]:
  - Default rule applies everywhere

METRICS:
  ledger_loc: 1 / 12 [lines]
  notes_loc: 1 / 5 [lines]
`);
  fs.writeFileSync(path.join(tmp, '.ai', 'billing.adf'), `ADF: 0.1

CONTEXT:
  - Ledger lives in src/billing

CONSTRAINTS [load-bearing]:
  - Amounts are integer cents
  - Never delete ledger rows
`);
  fs.writeFileSync(path.join(tmp, '.ai', 'people.adf'), 'ADF: 0.1\nCONSTRAINTS [load-bearing]:\n  - PII stays encrypted\n');
  fs.writeFileSync(path.join(tmp, 'src', 'billing', 'ledger.ts'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(tmp, 'src', 'notes.ts'), 'n\n');
  fs.writeFileSync(path.join(tmp, 'src', 'plain.yml'), 'x: 1\n');
  return process.cwd();
}

/** The same file written as the agent might pass it: relative, absolute, and Windows variants. */
function spellings(root: string, rel: string): string[] {
  const abs = path.join(root, ...rel.split('/'));
  const out = [rel, abs];
  if (isWin) {
    out.push(abs.replace(/\\/g, '/'));
    out.push(abs.charAt(0).toLowerCase() + abs.slice(1));
    out.push(rel.replace(/\//g, '\\'));
  }
  return out;
}

describe('absolute and Windows-style --files paths (fixture under Users/...)', () => {
  it('give the same rules, ceilings and module set as the relative path', () => {
    const root = setupRepo();
    const expected = runJson(['--files', 'src/billing/ledger.ts']);
    expect(expected.resolvedModules).toEqual(['core.adf', 'billing.adf']);
    for (const spelling of spellings(root, 'src/billing/ledger.ts')) {
      const out = runJson(['--files', spelling]);
      expect(out.resolvedModules, spelling).toEqual(['core.adf', 'billing.adf']);
      expect(out.keywords, spelling).not.toContain('users');
      expect(out.rules, spelling).toEqual(expected.rules);
      expect(out.ceilings, spelling).toEqual(expected.ceilings);
    }
  });

  it('a file with no governance still says nothing binds when given absolutely', () => {
    const root = setupRepo();
    for (const spelling of spellings(root, 'src/plain.yml')) {
      const text = run('text', ['--files', spelling]);
      expect(text.code).toBe(0);
      expect(text.out, spelling).toEqual(['Nothing binds src/plain.yml: no on-demand module or ceiling applies. Default modules only.']);
      const out = runJson(['--files', spelling]);
      expect(out).toMatchObject({ rules: [], ceilings: [], unreadable: [], binds: false });
    }
  });
});

describe('this repo: absolute paths through the preflight', () => {
  it('.github/workflows/ci.yml given absolutely: nothing binds (no false typed-data-access rules)', () => {
    process.chdir(repoRoot);
    for (const spelling of spellings(repoRoot, '.github/workflows/ci.yml')) {
      const text = run('text', ['--files', spelling]);
      expect(text.code).toBe(0);
      expect(text.out, spelling).toEqual(['Nothing binds .github/workflows/ci.yml: no on-demand module or ceiling applies. Default modules only.']);
      const out = runJson(['--files', spelling]);
      expect(out.resolvedModules, spelling).not.toContain('typed-data-access.adf');
      expect(out).toMatchObject({ rules: [], ceilings: [], binds: false });
    }
  });

  it('adf-migrate.ts given absolutely binds only adf-dev.adf, as the relative path does', () => {
    process.chdir(repoRoot);
    const rel = runJson(['--files', 'packages/cli/src/commands/adf-migrate.ts']);
    for (const spelling of spellings(repoRoot, 'packages/cli/src/commands/adf-migrate.ts').slice(1)) {
      const out = runJson(['--files', spelling]);
      expect(out.resolvedModules, spelling).toEqual(rel.resolvedModules);
      expect(out.rules, spelling).toEqual(rel.rules);
      expect(out.ceilings, spelling).toEqual(rel.ceilings);
      expect((out.rules as BindingRule[]).every(r => r.module === 'adf-dev.adf'), spelling).toBe(true);
    }
  });
});

describe('a module the ADF parser rejects', () => {
  it('is reported as unreadable with the reason, and exit code stays 0', () => {
    setupRepo();
    fs.writeFileSync(path.join('.ai', 'billing.adf'), 'ADF: 9.9\nCONSTRAINTS [load-bearing]:\n  - x\n');
    const out = runJson(['--files', 'src/billing/ledger.ts']);
    expect(out.rules).toEqual([]);
    expect(out.unreadable).toEqual([
      expect.objectContaining({ module: 'billing.adf', file: '.ai/billing.adf' }),
    ]);
    expect((out.unreadable as UnreadableModule[])[0].reason).toMatch(/Unsupported ADF version/);
    expect(out.binds).toBe(true);

    const text = run('text', ['--files', 'src/billing/ledger.ts']);
    expect(text.code).toBe(0);
    expect(text.out[0]).toMatch(/^Binds: {5}billing\.adf \(unreadable: .*Unsupported ADF version: 9\.9\) {2}\(\.ai\/billing\.adf\)$/);
  });
});

describe('rule source lines match the real section header', () => {
  it('ignores an earlier TASK line that mentions the key', () => {
    setupRepo();
    fs.writeFileSync(path.join('.ai', 'billing.adf'), [
      'ADF: 0.1',
      'TASK: tighten the CONSTRAINTS: list before release',
      '',
      'CONTEXT:',
      '  - CONSTRAINTS: are reviewed weekly',
      '',
      '📐 CONSTRAINTS [load-bearing]:',
      '  - Amounts are integer cents',
      '',
      'CONSTRAINTS [load-bearing]:',
      '  - Amounts are integer cents',
      '',
    ].join('\n'));
    const out = runJson(['--files', 'src/billing/ledger.ts']);
    expect((out.rules as BindingRule[]).map(r => r.line)).toEqual([8, 11]);
  });

  it('sectionHeaderRe escapes the key and accepts only header forms', () => {
    const re = sectionHeaderRe('CONSTRAINTS');
    expect(re.test('CONSTRAINTS:')).toBe(true);
    expect(re.test('CONSTRAINTS [load-bearing]:')).toBe(true);
    expect(re.test('📐 CONSTRAINTS [advisory]:')).toBe(true);
    expect(re.test('TASK: fix CONSTRAINTS: now')).toBe(false);
    expect(re.test('MY_CONSTRAINTS:')).toBe(false);
    expect(re.test('CONSTRAINTS_X:')).toBe(false);
    expect(sectionHeaderRe('A.B').test('AxB:')).toBe(false);
    expect(locate(['ADF: 0.1', 'TASK: CONSTRAINTS: x', 'CONSTRAINTS:', '  - r'], 'CONSTRAINTS', ['r'])).toEqual([4]);
  });
});

describe('display paths are relative to the repo root, not cwd', () => {
  it('from a subdirectory with --ai-dir ../.ai, rules and ceilings read the same', () => {
    setupRepo();
    const fromRoot = runJson(['--files', 'src/billing/ledger.ts']);
    process.chdir('src');
    const fromSub = runJson(['--files', 'billing/ledger.ts', '--ai-dir', '../.ai']);
    expect(fromSub.rules).toEqual(fromRoot.rules);
    expect(fromSub.ceilings).toEqual(fromRoot.ceilings);
    expect((fromSub.rules as BindingRule[])[0].file).toBe('.ai/billing.adf');
    expect((fromSub.ceilings as FileCeiling[])[0]).toMatchObject({ file: 'src/billing/ledger.ts', value: 4, headroom: 8 });
  });
});

describe('text output', () => {
  it('--bundle text prints the preflight block on stderr and keeps stdout pure ADF', () => {
    setupRepo();
    const r = run('text', ['--files', 'src/billing/ledger.ts', '--bundle']);
    expect(r.code).toBe(0);
    expect(r.err[0]).toBe('Binds:     billing.adf → "Amounts are integer cents"  (.ai/billing.adf:7)');
    expect(r.err).toContain('Headroom:  ledger_loc 4/12 → 8 lines left [pass] (core.adf)');
    expect(r.out.join('\n')).toMatch(/^ADF: 0\.1/);
    expect(r.out.join('\n')).not.toContain('Binds:');
  });

  it('multi-file Headroom names the file each ceiling measures', () => {
    setupRepo();
    const r = run('text', ['--files', 'src/billing/ledger.ts,src/notes.ts']);
    expect(r.out).toContain('Headroom:  ledger_loc 4/12 → 8 lines left [pass] (core.adf) for src/billing/ledger.ts');
    expect(r.out).toContain('           notes_loc 2/5 → 3 lines left [pass] (core.adf) for src/notes.ts');
  });
});

describe('filePathToKeywords moved to a leaf module', () => {
  it('adf-context still exports the same function', () => {
    expect(contextFilePathToKeywords).toBe(filePathToKeywords);
    expect(filePathToKeywords(['src/api/handler.ts'])).toEqual(['api', 'backend']);
  });
});

describe('MCP getProjectContext content array (serve.ts)', () => {
  type Handler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

  function projectContextHandler(aiDir: string): Handler {
    const handlers = new Map<string, Handler>();
    const stub = { registerTool: (name: string, _cfg: unknown, handler: Handler) => { handlers.set(name, handler); } };
    registerTools(stub as unknown as McpServer, aiDir, opts('text'), 'test-session');
    const handler = handlers.get('getProjectContext');
    if (!handler) throw new Error('getProjectContext not registered');
    return handler;
  }

  it('no files: one item, the bundle (unchanged)', async () => {
    const root = setupRepo();
    const res = await projectContextHandler(path.join(root, '.ai'))({ task: 'billing' });
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toMatch(/^ADF: 0\.1/);
  });

  it('files that bind: bundle, preflight text, then the CLI JSON fields', async () => {
    const root = setupRepo();
    const cli = runJson(['--files', 'src/billing/ledger.ts']);
    const res = await projectContextHandler(path.join(root, '.ai'))({ files: [path.join(root, 'src', 'billing', 'ledger.ts')] });
    expect(res.content).toHaveLength(3);
    expect(res.content[0].text).toMatch(/^ADF: 0\.1/);
    expect(res.content[1].text.split('\n')[0]).toBe('Binds:     billing.adf → "Amounts are integer cents"  (.ai/billing.adf:7)');
    expect(JSON.parse(res.content[2].text)).toEqual({ rules: cli.rules, ceilings: cli.ceilings, unreadable: [], binds: true });
  });

  it('files where nothing binds: the short answer first, and no default bundle', async () => {
    const root = setupRepo();
    const res = await projectContextHandler(path.join(root, '.ai'))({ files: [path.join(root, 'src', 'plain.yml')] });
    expect(res.content).toHaveLength(2);
    expect(res.content[0].text).toBe('Nothing binds src/plain.yml: no on-demand module or ceiling applies. Default modules only.');
    expect(JSON.parse(res.content[1].text)).toEqual({ rules: [], ceilings: [], unreadable: [], binds: false });
    expect(res.content.some(c => c.text.includes('Default rule applies everywhere'))).toBe(false);
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { adfContextCommand } from '../commands/adf-context';
import { resolveProjectContext } from '../commands/project-context';
import type { BindingRule } from '../commands/adf-preflight';
import type { FileCeiling } from '../commands/adf-ceilings';

const jsonOptions: CLIOptions = {
  configPath: '.charter',
  format: 'json',
  ciMode: false,
  yes: false,
};
const textOptions: CLIOptions = { ...jsonOptions, format: 'text' };

const originalCwd = process.cwd();
const repoRoot = path.resolve(__dirname, '../../../..');
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function setupRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-preflight-test-'));
  tempDirs.push(tmp);
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'billing'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), `ADF: 0.1
DEFAULT_LOAD:
  - core.adf

ON_DEMAND:
  - billing.adf (Triggers on: billing)
  - empty.adf (Triggers on: docs)

METRICS:
  LEDGER_LOC: src/billing/ledger.ts
`);
  fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), `ADF: 0.1
CONSTRAINTS [load-bearing]:
  - Default rule applies everywhere

METRICS:
  ledger_loc: 1 / 12 [lines]
`);
  fs.writeFileSync(path.join(tmp, '.ai', 'billing.adf'), `ADF: 0.1

CONTEXT:
  - Ledger lives in src/billing

CONSTRAINTS [load-bearing]:
  - Amounts are integer cents
  - Never delete ledger rows

RULES [advisory]:
  - Prefer small functions
`);
  fs.writeFileSync(path.join(tmp, '.ai', 'empty.adf'), 'ADF: 0.1\nCONTEXT:\n  - Nothing load-bearing here\n');
  fs.writeFileSync(path.join(tmp, 'src', 'billing', 'ledger.ts'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(tmp, 'src', 'plain.yml'), 'x: 1\n');
  return tmp;
}

function capture(fn: () => number): string[] {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => { logs.push(String(msg ?? '')); });
  const code = fn();
  vi.restoreAllMocks();
  expect(code).toBe(0);
  return logs;
}

function runJson(args: string[], options: CLIOptions = jsonOptions): Record<string, unknown> {
  return JSON.parse(capture(() => adfContextCommand(options, args)).join('\n')) as Record<string, unknown>;
}

/** Runs against the real repo, with telemetry written to a temp dir instead of the repo's .charter. */
function useRepoRoot(): { json: CLIOptions; text: CLIOptions } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-preflight-cfg-'));
  tempDirs.push(tmp);
  process.chdir(repoRoot);
  return { json: { ...jsonOptions, configPath: tmp }, text: { ...textOptions, configPath: tmp } };
}

describe('adf context --files preflight (fixture)', () => {
  it('lists load-bearing rules of resolved on-demand modules with source lines', () => {
    setupRepo();
    const out = runJson(['--files', 'src/billing/ledger.ts']);
    expect(out.rules).toEqual([
      { module: 'billing.adf', section: 'CONSTRAINTS', rule: 'Amounts are integer cents', file: '.ai/billing.adf', line: 7 },
      { module: 'billing.adf', section: 'CONSTRAINTS', rule: 'Never delete ledger rows', file: '.ai/billing.adf', line: 8 },
    ]);
    expect(out.ceilings).toEqual([expect.objectContaining({ metric: 'ledger_loc', value: 4, ceiling: 12, headroom: 8 })]);
    // Unbuilt fields (#440, #444, #445) are not invented in JSON.
    for (const key of ['contract', 'tests', 'fresh', 'nextActions']) expect(out).not.toHaveProperty(key);
  });

  it('prints Binds, Headroom and unknown placeholders in text mode', () => {
    setupRepo();
    const logs = capture(() => adfContextCommand(textOptions, ['--files', 'src/billing/ledger.ts']));
    expect(logs.slice(0, 6)).toEqual([
      'Binds:     billing.adf → "Amounts are integer cents"  (.ai/billing.adf:7)',
      '           billing.adf → "Never delete ledger rows"  (.ai/billing.adf:8)',
      'Headroom:  ledger_loc 4/12 → 8 lines left [pass] (core.adf)',
      'Contract:  unknown',
      'Run first: unknown',
      'Fresh:     unknown',
    ]);
    expect(logs).toContain('    billing.adf (ON_DEMAND)');
  });

  it('names an on-demand module with no load-bearing rules', () => {
    setupRepo();
    const logs = capture(() => adfContextCommand(textOptions, ['--files', 'src/plain.yml', '--keywords', 'docs']));
    expect(logs[0]).toBe('Binds:     empty.adf (no load-bearing rules)');
    expect(logs[1]).toBe('Headroom:  no ceiling tracks this file');
  });

  it('prints one short line when nothing binds the file', () => {
    setupRepo();
    const logs = capture(() => adfContextCommand(textOptions, ['--files', 'src/plain.yml']));
    expect(logs).toEqual(['Nothing binds src/plain.yml: no on-demand module or ceiling applies. Default modules only.']);
    const out = runJson(['--files', 'src/plain.yml']);
    expect(out.rules).toEqual([]);
    expect(out.ceilings).toEqual([]);
  });

  it('adds rules to --bundle JSON and leaves --keywords-only output alone', () => {
    setupRepo();
    const bundled = runJson(['--files', 'src/billing/ledger.ts', '--bundle']);
    expect((bundled.rules as BindingRule[]).map(r => r.rule)).toEqual(['Amounts are integer cents', 'Never delete ledger rows']);
    const kwOnly = runJson(['--keywords', 'billing']);
    expect(Object.keys(kwOnly)).toEqual(['keywords', 'resolvedModules', 'triggerMatches']);
  });

  it('MCP getProjectContext with files gives the same rules, ceilings and text as the CLI', () => {
    setupRepo();
    const cli = runJson(['--files', 'src/billing/ledger.ts', '--keywords', 'refund flow']);
    const cliText = capture(() => adfContextCommand(textOptions, ['--files', 'src/billing/ledger.ts', '--keywords', 'refund flow']));
    const mcp = resolveProjectContext('.ai', 'refund flow', ['src/billing/ledger.ts']);
    expect(mcp.keywords).toEqual(cli.keywords);
    expect(mcp.bundle.resolvedModules).toEqual(cli.resolvedModules);
    expect(mcp.preflight?.rules).toEqual(cli.rules);
    expect(mcp.preflight?.ceilings).toEqual(cli.ceilings);
    expect(mcp.preflightText?.split('\n')).toEqual(cliText.slice(0, 6));
    // `charter serve` passes an absolute aiDir; locations must still match the CLI.
    const served = resolveProjectContext(path.resolve('.ai'), 'refund flow', ['src/billing/ledger.ts']);
    expect(served.preflight?.rules).toEqual(cli.rules);
    expect(served.preflightText).toEqual(mcp.preflightText);
  });

  it('MCP getProjectContext without files is unchanged', () => {
    setupRepo();
    const mcp = resolveProjectContext('.ai', 'billing');
    expect(mcp.preflight).toBeUndefined();
    expect(mcp.preflightText).toBeUndefined();
    expect(mcp.keywords).toEqual(['billing']);
  });
});

describe('adf context --files preflight (this repo)', () => {
  it('packages/cli/src/commands/adf-migrate.ts: adf-dev rules and the adf_migrate_loc ceiling', () => {
    const opts = useRepoRoot();
    const out = runJson(['--files', 'packages/cli/src/commands/adf-migrate.ts'], opts.json);
    const rules = out.rules as BindingRule[];
    const zeroDeps = rules.find(r => r.rule === 'ADF package has zero runtime dependencies');
    expect(zeroDeps).toMatchObject({ module: 'adf-dev.adf', section: 'CONSTRAINTS', file: '.ai/adf-dev.adf' });
    // The source location points at the rule's actual line.
    for (const r of rules) {
      const line = fs.readFileSync(path.join(repoRoot, r.file), 'utf-8').split(/\r?\n/)[r.line - 1];
      expect(line).toContain(r.rule);
    }
    const [ceiling] = out.ceilings as FileCeiling[];
    expect(ceiling).toMatchObject({ file: 'packages/cli/src/commands/adf-migrate.ts', metric: 'adf_migrate_loc', module: 'core.adf' });
    expect(ceiling.headroom).toBe(ceiling.ceiling - ceiling.value);

    const logs = capture(() => adfContextCommand(opts.text, ['--files', 'packages/cli/src/commands/adf-migrate.ts']));
    expect(logs[0]).toMatch(/^Binds: {5}adf-dev\.adf → "ADF package has zero runtime dependencies" {2}\(\.ai\/adf-dev\.adf:\d+\)$/);
    expect(logs).toContain(`Headroom:  adf_migrate_loc ${ceiling.value}/${ceiling.ceiling} → ${ceiling.headroom} lines left [${ceiling.status}] (core.adf)`);
    expect(logs).toEqual(expect.arrayContaining(['Contract:  unknown', 'Run first: unknown', 'Fresh:     unknown']));
  });

  it('.github/workflows/ci.yml: nothing binds it', () => {
    const opts = useRepoRoot();
    const logs = capture(() => adfContextCommand(opts.text, ['--files', '.github/workflows/ci.yml']));
    expect(logs).toEqual(['Nothing binds .github/workflows/ci.yml: no on-demand module or ceiling applies. Default modules only.']);
    const out = runJson(['--files', '.github/workflows/ci.yml'], opts.json);
    expect(out.rules).toEqual([]);
    expect(out.ceilings).toEqual([]);
  });
});

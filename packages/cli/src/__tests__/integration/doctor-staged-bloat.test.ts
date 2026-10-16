/**
 * Integration tests: doctor --staged / --tidy-skipped (#357).
 *
 * The generated pre-commit hook's gate runs doctor with --staged, so vendor
 * bloat blocks only in vendor files the commit stages, and not in the ones
 * its tidy block skipped (--tidy-skipped). Everything else doctor checks is
 * unscoped, and doctor without --staged behaves exactly as before.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../../index';
import { CLIError, EXIT_CODE } from '../../index';
import { BLOAT_SCOPE_MSG, doctorCommand } from '../../commands/doctor';

const options: CLIOptions = { configPath: '.charter', format: 'json', ciMode: true, yes: false };

const POINTER = `# CLAUDE.md

> **DO NOT add rules, constraints, or context to this file.**
> This file is auto-managed by Charter. All project rules live in \`.ai/\`.
> See \`.ai/manifest.adf\` for the module routing manifest.

## Environment
- Node 20
`;

const DB_BLOAT = `
## Database Rules
- All database migrations must be reversible
- Schema changes require migration scripts
`;

const CLAUDE_BLOAT = 'CLAUDE.md: "Database Rules" section overlaps ADF section "rules"; trigger keywords [database (2x)] suggest content belongs in backend.adf';
const GEMINI_BLOAT = CLAUDE_BLOAT.replace('CLAUDE.md', 'GEMINI.md');

interface Check { name: string; status: string; details: string }

let originalCwd: string;
let tmp: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: tmp, stdio: 'ignore' });
}

async function doctor(args: string[], opts: CLIOptions = options): Promise<{ code: number; status: string; checks: Check[] }> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  try {
    const code = await doctorCommand(opts, args);
    const json = JSON.parse(logs.join('\n')) as { status: string; checks: Check[] };
    return { code, status: json.status, checks: json.checks };
  } finally {
    vi.restoreAllMocks();
  }
}

const bloatRows = (checks: Check[]): Check[] => checks.filter(c => c.name.startsWith('adf vendor bloat'));

beforeEach(() => {
  originalCwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-doctor-staged-'));
  process.chdir(tmp);
  git('init', '-q');
  fs.mkdirSync('.ai');
  fs.writeFileSync('.ai/manifest.adf', 'ADF: 0.1\n\n📦 DEFAULT_LOAD:\n  - core.adf\n  - state.adf\n\n📂 ON_DEMAND:\n  - backend.adf (Triggers on: database, API, migration)\n');
  fs.writeFileSync('.ai/core.adf', 'ADF: 0.1\n\n📐 RULES:\n  - All changes require tests\n');
  fs.writeFileSync('.ai/state.adf', 'ADF: 0.1\n\n📋 STATE:\n  - CURRENT: testing\n');
  fs.writeFileSync('.ai/backend.adf', 'ADF: 0.1\n\n📐 RULES:\n  - Database access through repository pattern\n');
  fs.writeFileSync('CLAUDE.md', POINTER + DB_BLOAT);
  fs.writeFileSync('GEMINI.md', (POINTER + DB_BLOAT).replace('# CLAUDE.md', '# GEMINI.md'));
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('doctor without --staged is unchanged', () => {
  it.each([[[] as string[]], [['--adf-only']]])('args %j: one WARN row naming every bloated file, whole-tree advice, exit 1', async (args) => {
    git('add', 'CLAUDE.md'); // staging must not matter without --staged
    const { code, checks } = await doctor(args);
    expect(code).toBe(EXIT_CODE.POLICY_VIOLATION);
    expect(bloatRows(checks)).toEqual([{
      name: 'adf vendor bloat',
      status: 'WARN',
      details: `Vendor file bloat detected:\n    ${CLAUDE_BLOAT}\n    ${GEMINI_BLOAT}\n    Run: charter adf tidy --dry-run`,
    }]);
  });

  it('--tidy-skipped without --staged is a usage error, never a silent downgrade', async () => {
    await expect(doctorCommand(options, ['--adf-only', '--tidy-skipped', 'CLAUDE.md'])).rejects.toThrow(CLIError);
    await expect(doctorCommand(options, ['--adf-only', '--tidy-skipped', 'CLAUDE.md'])).rejects.toThrow(BLOAT_SCOPE_MSG.tidySkippedNeedsStaged);
  });

  it('--tidy-skipped with no value is a usage error', async () => {
    await expect(doctorCommand(options, ['--adf-only', '--staged', '--tidy-skipped'])).rejects.toThrow(BLOAT_SCOPE_MSG.tidySkippedMissing);
    await expect(doctorCommand(options, ['--adf-only', '--staged', '--tidy-skipped', '--format'])).rejects.toThrow(BLOAT_SCOPE_MSG.tidySkippedMissing);
  });
});

describe('doctor --staged', () => {
  it('nothing staged: bloat is INFO (not blocking), and --ci passes', async () => {
    const { code, status, checks } = await doctor(['--adf-only', '--staged', '--tidy-skipped', '']);
    expect(code).toBe(EXIT_CODE.SUCCESS);
    expect(status).toBe('PASS');
    expect(bloatRows(checks)).toEqual([
      { name: 'adf vendor bloat', status: 'PASS', details: '0 staged vendor file(s) checked, within bloat thresholds.' },
      {
        name: 'adf vendor bloat (not blocking)',
        status: 'INFO',
        details: `${BLOAT_SCOPE_MSG.outsideHeader}\n    CLAUDE.md (not staged): ${CLAUDE_BLOAT.slice('CLAUDE.md: '.length)}\n    GEMINI.md (not staged): ${GEMINI_BLOAT.slice('GEMINI.md: '.length)}\n    ${BLOAT_SCOPE_MSG.outsideRun}`,
      },
    ]);
  });

  it('a staged bloated file blocks, with advice scoped to it; an unstaged one is INFO', async () => {
    git('add', 'CLAUDE.md');
    const { code, checks } = await doctor(['--adf-only', '--staged']);
    expect(code).toBe(EXIT_CODE.POLICY_VIOLATION);
    const rows = bloatRows(checks);
    expect(rows[0]).toEqual({
      name: 'adf vendor bloat',
      status: 'WARN',
      details: `Vendor file bloat detected:\n    ${CLAUDE_BLOAT}\n    Run: charter adf tidy --dry-run --source CLAUDE.md`,
    });
    expect(rows[1].status).toBe('INFO');
    expect(rows[1].details).toContain('GEMINI.md (not staged): ');
    expect(rows[1].details).not.toContain('CLAUDE.md');
  });

  it('a staged file named in --tidy-skipped is INFO, labelled as skipped', async () => {
    git('add', 'CLAUDE.md', 'GEMINI.md');
    const { code, checks } = await doctor(['--adf-only', '--staged', '--tidy-skipped', ' CLAUDE.md']);
    expect(code).toBe(EXIT_CODE.POLICY_VIOLATION); // GEMINI.md is staged and not skipped
    const rows = bloatRows(checks);
    expect(rows[0].status).toBe('WARN');
    expect(rows[0].details).toContain('GEMINI.md: ');
    expect(rows[0].details).not.toContain('CLAUDE.md');
    expect(rows[1].details).toContain('CLAUDE.md (auto-tidy skipped for it in this commit): ');

    const both = await doctor(['--adf-only', '--staged', '--tidy-skipped', ' CLAUDE.md GEMINI.md']);
    expect(both.code).toBe(EXIT_CODE.SUCCESS);
    expect(bloatRows(both.checks)[0]).toEqual({
      name: 'adf vendor bloat',
      status: 'PASS',
      details: '0 staged vendor file(s) checked, within bloat thresholds. 2 staged vendor file(s) skipped by auto-tidy are not checked here (see the INFO row).',
    });
  });

  it('a staged deletion does not count as staged', async () => {
    git('add', 'CLAUDE.md');
    git('commit', '-q', '--no-verify', '-m', 'x');
    git('rm', '-q', '--cached', 'CLAUDE.md');
    const { checks } = await doctor(['--adf-only', '--staged']);
    expect(bloatRows(checks).find(c => c.status === 'WARN')).toBeUndefined();
  });

  it('an unreadable index falls back to enforcing every vendor file', async () => {
    git('add', 'CLAUDE.md');
    fs.writeFileSync(path.join(tmp, '.git', 'index'), 'not an index');
    expect(() => execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: tmp, stdio: 'ignore' })).toThrow();
    const { code, checks } = await doctor(['--adf-only', '--staged', '--tidy-skipped', 'CLAUDE.md']);
    expect(code).toBe(EXIT_CODE.POLICY_VIOLATION);
    expect(bloatRows(checks)).toEqual([{
      name: 'adf vendor bloat',
      status: 'WARN',
      details: `Vendor file bloat detected:\n    ${CLAUDE_BLOAT}\n    ${GEMINI_BLOAT}\n    Run: charter adf tidy --dry-run`,
    }]);
  });

  it('only bloat is scoped: any other WARN still fails --ci', async () => {
    fs.rmSync('.ai/state.adf');
    const { code, checks } = await doctor(['--adf-only', '--staged', '--tidy-skipped', 'CLAUDE.md']);
    expect(code).toBe(EXIT_CODE.POLICY_VIOLATION);
    expect(checks.find(c => c.name === 'adf default modules')?.status).toBe('WARN');
    expect(bloatRows(checks).some(c => c.status === 'WARN')).toBe(false);
  });

  it('text output shows the INFO row', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    await doctorCommand({ ...options, format: 'text' }, ['--adf-only', '--staged']);
    vi.restoreAllMocks();
    expect(logs.join('\n')).toContain(`  [info] adf vendor bloat (not blocking): ${BLOAT_SCOPE_MSG.outsideHeader}`);
  });
});

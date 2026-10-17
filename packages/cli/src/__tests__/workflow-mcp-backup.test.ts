/**
 * #374: bootstrap backs up .mcp.json before reformatting it, and refreshes
 * .github/workflows/charter-governance.yml only while it is a workflow Charter
 * generated; a hand-edited one is kept, or backed up and replaced under --force.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';

vi.mock('../git-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-helpers')>();
  return { ...actual, isGitRepo: () => true };
});

import { bootstrapCommand } from '../commands/bootstrap';
import { getGithubWorkflow, setupCommand } from '../commands/setup';
import { applyGovernanceWorkflow, KNOWN_WORKFLOWS, normalizeWorkflow, workflowHash, workflowWidening } from '../commands/github-workflow';

const TEXT: CLIOptions = { configPath: '.charter', format: 'text', ciMode: false, yes: false };
const JSON_OPTS: CLIOptions = { ...TEXT, format: 'json' };
const YES: CLIOptions = { ...TEXT, yes: true };
const BOOT = ['--preset', 'worker', '--skip-install', '--skip-doctor'];
const WF = '.github/workflows/charter-governance.yml';
const P = (rel: string): string => path.normalize(rel);
const CHARTER_ENTRY = { command: 'npx', args: ['@stackbilt/cli', 'serve', '--ai-dir', '.ai'] };

let out: string[] = [];
let tempDir = '';
const originalCwd = process.cwd();

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'charter-374-')));
  process.chdir(tempDir);
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(rel), { recursive: true });
  fs.writeFileSync(rel, text);
}
const read = (rel: string): string => fs.readFileSync(rel, 'utf-8');
const backups = (prefix: string): string[] =>
  fs.existsSync('.charter/.backup') ? fs.readdirSync('.charter/.backup').filter(f => f.startsWith(prefix)) : [];
const setupStep = () => JSON.parse(out.join('\n')).steps.find((s: { name: string }) => s.name === 'setup');

// ============================================================================
// .mcp.json
// ============================================================================

describe('#374 .mcp.json: adding mcpServers.charter', () => {
  const DATA = { other: { keep: [1, 2] }, mcpServers: { github: { command: 'npx', args: ['gh'] } } };

  it('backs up a non-canonically formatted .mcp.json first, and keeps every key', async () => {
    const original = '{"other":{"keep":[1,2]},\r\n "mcpServers": {"github": {"command": "npx", "args": ["gh"]}}}';
    write('.mcp.json', original);
    expect(await bootstrapCommand(YES, ['--yes', ...BOOT])).toBe(0);

    const parsed = JSON.parse(read('.mcp.json'));
    expect(parsed).toEqual({ ...DATA, mcpServers: { ...DATA.mcpServers, charter: CHARTER_ENTRY } });
    expect(Object.keys(parsed)).toEqual(['other', 'mcpServers']);
    const files = backups('mcp.json.');
    expect(files).toHaveLength(1);
    expect(read(`.charter/.backup/${files[0]}`)).toBe(original);
    expect(read('.charter/.backup/.gitignore')).toBe('*\n');
    expect(out).toContain(`  Updated .mcp.json (backup: .charter/.backup/${files[0]})`);
  });

  it('reports the backup in the JSON setup step', async () => {
    write('.mcp.json', JSON.stringify(DATA));
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--yes', ...BOOT])).toBe(0);
    expect(setupStep().details.mcpBackup).toMatch(/^\.charter\/\.backup\/mcp\.json\./);
    expect(setupStep().details.updated).toContain('.mcp.json');
  });

  it('writes no backup when .mcp.json is already in the canonical formatting', async () => {
    write('.mcp.json', JSON.stringify(DATA, null, 2) + '\n');
    expect(await bootstrapCommand(YES, ['--yes', ...BOOT])).toBe(0);
    expect(JSON.parse(read('.mcp.json')).mcpServers.charter).toEqual(CHARTER_ENTRY);
    expect(backups('mcp.json.')).toEqual([]);
    expect(out).toContain('  Updated .mcp.json');
  });

  it('leaves the file untouched and warns when the backup fails', async () => {
    const original = '{ "mcpServers": { "github": { "command": "npx" } } }\n';
    write('.mcp.json', original);
    write('.charter/.backup', 'a file where the backup directory should be\n');
    expect(await bootstrapCommand(YES, ['--yes', ...BOOT])).toBe(0);
    expect(read('.mcp.json')).toBe(original);
    expect(out.some(l => l.includes('could not back up .mcp.json to .charter/.backup/') && l.includes('was not added'))).toBe(true);
    expect(out.some(l => l.startsWith('  Updated .mcp.json'))).toBe(false);
  });
});

// ============================================================================
// .github/workflows/charter-governance.yml
// ============================================================================

const HAND_EDITED = getGithubWorkflow('npm').replace("node-version: '20'", "node-version: '22'") + '\n# ours\n';

// The CLI-version-pinned template shipped before npx charter (the pin is normalized away).
const PINNED_HISTORICAL = `name: Governance Check

on:
  pull_request:
    branches: [main, master]

permissions:
  contents: read
  pull-requests: write

jobs:
  governance:
    name: Charter
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Charter CLI
        run: npm install -g @stackbilt/cli@0.4.2

      - name: Validate Commits
        run: charter validate --ci --format text

      - name: Drift Scan
        run: charter drift --ci --format text

      - name: Audit Report
        run: charter audit --format json > /tmp/audit.json
        if: always()
`;

describe('#374 .mcp.json: CRLF', () => {
  it('backs up a CRLF copy of the canonical formatting (the rewrite changes its line endings)', async () => {
    const DATA = { mcpServers: { github: { command: 'npx' } }, z: 1, a: 2 };
    const original = (JSON.stringify(DATA, null, 2) + '\n').replace(/\n/g, '\r\n');
    write('.mcp.json', original);
    expect(await bootstrapCommand(YES, ['--yes', ...BOOT])).toBe(0);
    expect(JSON.parse(read('.mcp.json'))).toEqual({ ...DATA, mcpServers: { github: { command: 'npx' }, charter: CHARTER_ENTRY } });
    const files = backups('mcp.json.');
    expect(files).toHaveLength(1);
    expect(read(`.charter/.backup/${files[0]}`)).toBe(original);
  });
});

describe('#374 known workflow versions', () => {
  it('lists the current npm and pnpm templates as safe (add new hashes when the template changes)', () => {
    for (const pm of ['npm', 'pnpm'] as const) {
      const entry = KNOWN_WORKFLOWS.find(k => k.hash === workflowHash(getGithubWorkflow(pm)));
      expect(entry?.safe).toBe(true);
    }
  });

  it('every known hash is unique, a sha256, and has a safe flag', () => {
    const hashes = KNOWN_WORKFLOWS.map(k => k.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const k of KNOWN_WORKFLOWS) {
      expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof k.safe).toBe('boolean');
      expect(k.origin.length).toBeGreaterThan(0);
    }
  });

  it('the pinned historical template is listed as not safe, and its widening is named', () => {
    expect(KNOWN_WORKFLOWS.find(k => k.hash === workflowHash(PINNED_HISTORICAL))?.safe).toBe(false);
    expect(workflowWidening(PINNED_HISTORICAL, getGithubWorkflow('npm'))).toEqual([
      'CI permissions (contents: read → write)',
      'triggers (adds push, workflow_dispatch)',
      'an auto-commit step that runs git push',
    ]);
    expect(workflowWidening(getGithubWorkflow('pnpm'), getGithubWorkflow('npm'))).toEqual([]);
  });

  it('normalizes a BOM, CRLF, trailing whitespace, trailing blank lines and a pinned CLI version', () => {
    const t = getGithubWorkflow('npm');
    expect(normalizeWorkflow('﻿' + t.replace(/\n/g, '  \r\n') + '\r\n\r\n')).toBe(normalizeWorkflow(t));
    expect(workflowHash(PINNED_HISTORICAL.replace('0.4.2', '9.9.9-rc.1'))).toBe(workflowHash(PINNED_HISTORICAL));
  });
});

describe('#374 applyGovernanceWorkflow with an injected known list', () => {
  // A same-permission older variant: the current template without its Audit Report step.
  const current = getGithubWorkflow('npm');
  const samePerms = current.replace(/\n {6}- name: Audit Report\n[^\n]*\n[^\n]*\n/, '\n');
  const widening = samePerms.replace('contents: write', 'contents: read');

  it('refreshes a known same-permission variant silently', () => {
    expect(samePerms).not.toBe(current);
    write(WF, samePerms);
    const known = new Map([[workflowHash(samePerms), { hash: workflowHash(samePerms), origin: 'test', safe: true }]]);
    expect(applyGovernanceWorkflow(WF, current, { force: false, configDir: '.charter', command: 'setup', known })).toEqual({ action: 'updated' });
    expect(read(WF)).toBe(current);
  });

  it('keeps a variant flagged safe whose permissions differ (the run-time check wins)', () => {
    write(WF, widening);
    const known = new Map([[workflowHash(widening), { hash: workflowHash(widening), origin: 'test', safe: true }]]);
    const outcome = applyGovernanceWorkflow(WF, current, { force: false, configDir: '.charter', command: 'setup', known });
    expect(outcome).toMatchObject({ action: 'kept', reason: 'would-widen-permissions', widens: ['CI permissions (contents: read → write)'] });
    expect(read(WF)).toBe(widening);
  });
});

const WIDEN_PARTS = ['contents: read → write', 'adds push, workflow_dispatch', 'git push'];

describe('#374 bootstrap --ci github: the workflow', () => {
  it('creates a missing workflow', async () => {
    expect(await bootstrapCommand(YES, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
    expect(read(WF)).toBe(getGithubWorkflow('npm'));
    expect(out).toContain(`  Created ${P(WF)}`);
  });

  it('leaves an identical workflow alone', async () => {
    write(WF, getGithubWorkflow('npm'));
    expect(await bootstrapCommand(YES, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
    expect(out.some(l => l.includes(P(WF)) || l.includes(WF))).toBe(false);
    expect(fs.existsSync('.charter/.backup')).toBe(false);
  });

  it('silently refreshes the current pnpm template to npm (and the reverse): same permissions', async () => {
    write(WF, getGithubWorkflow('pnpm'));
    expect(await bootstrapCommand(YES, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
    expect(read(WF)).toBe(getGithubWorkflow('npm'));
    expect(out).toContain(`  Updated ${P(WF)}`);
    expect(out.some(l => l.includes('Warning') && l.includes('charter-governance.yml'))).toBe(false);
    expect(fs.existsSync('.charter/.backup')).toBe(false);

    write('pnpm-lock.yaml', '');
    out = [];
    expect(await bootstrapCommand(YES, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
    expect(read(WF)).toBe(getGithubWorkflow('pnpm'));
    expect(out).toContain(`  Updated ${P(WF)}`);
  });

  it('counts a CRLF copy of the template as known', async () => {
    write(WF, getGithubWorkflow('pnpm').replace(/\n/g, '\r\n'));
    expect(await bootstrapCommand(YES, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
    expect(read(WF)).toBe(getGithubWorkflow('npm'));
    expect(fs.existsSync('.charter/.backup')).toBe(false);
  });

  it('counts a copy with a BOM as known', async () => {
    write(WF, '﻿' + getGithubWorkflow('pnpm'));
    expect(await bootstrapCommand(YES, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
    expect(read(WF)).toBe(getGithubWorkflow('npm'));
    expect(fs.existsSync('.charter/.backup')).toBe(false);
  });

  for (const flags of [[], ['--yes']]) {
    it(`keeps a contents: read historical template, naming the widening${flags.length ? ` under ${flags.join(' ')}` : ''}`, async () => {
      write(WF, PINNED_HISTORICAL);
      expect(await bootstrapCommand(flags.length ? YES : TEXT, [...flags, '--ci', 'github', ...BOOT])).toBe(0);
      expect(read(WF)).toBe(PINNED_HISTORICAL);
      expect(fs.existsSync('.charter/.backup')).toBe(false);
      const warning = out.find(l => l.startsWith(`  Warning: Kept ${WF}: it is an older Charter template`));
      for (const part of WIDEN_PARTS) expect(warning).toContain(part);
      expect(warning).toContain("'charter bootstrap --ci github --force' upgrades it");
    });
  }

  it('JSON: a widening historical template is kept with reason would-widen-permissions', async () => {
    write(WF, PINNED_HISTORICAL);
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
    const step = setupStep();
    expect(step.details.kept).toContain(WF);
    expect(step.details.workflow).toMatchObject({ file: WF, action: 'kept', reason: 'would-widen-permissions' });
    expect(step.details.workflow.widens).toHaveLength(3);
  });

  it('--force backs a widening historical template up, then replaces it, saying what widened', async () => {
    write(WF, PINNED_HISTORICAL);
    expect(await bootstrapCommand(TEXT, ['--force', '--ci', 'github', ...BOOT])).toBe(0);
    expect(read(WF)).toBe(getGithubWorkflow('npm'));
    const files = backups('github-workflows-charter-governance.yml.');
    expect(files).toHaveLength(1);
    expect(read(`.charter/.backup/${files[0]}`)).toBe(PINNED_HISTORICAL);
    const line = out.find(l => l.startsWith(`  Replaced ${WF} (backup: .charter/.backup/${files[0]}; widened `));
    for (const part of WIDEN_PARTS) expect(line).toContain(part);
  });

  for (const flags of [[], ['--yes']]) {
    it(`keeps a hand-edited workflow byte-for-byte with a warning${flags.length ? ` under ${flags.join(' ')}` : ''}`, async () => {
      write(WF, HAND_EDITED);
      expect(await bootstrapCommand(flags.length ? YES : TEXT, [...flags, '--ci', 'github', ...BOOT])).toBe(0);
      expect(read(WF)).toBe(HAND_EDITED);
      expect(fs.existsSync('.charter/.backup')).toBe(false);
      const warning = out.find(l => l.startsWith(`  Warning: Kept ${WF}: it differs from every workflow Charter generated`));
      expect(warning).toContain("'charter bootstrap --ci github --force' replaces it");
      expect(warning).toContain('backing it up to .charter/.backup/ first');
      // The hint names what else bootstrap --force does, and the narrower alternative.
      expect(warning).toContain('rewrites every Charter-managed pointer');
      expect(warning).toContain("replaces .mcp.json's mcpServers.charter entry");
      expect(warning).toContain('merges the preset template into .ai/*.adf');
      expect(warning).toContain('To replace only the workflow, delete it and re-run');
      expect(out.some(l => l.startsWith('  Updated') && l.includes('charter-governance'))).toBe(false);
      // Not folded into the .charter/ "Kept existing ... 'charter init --force'" line.
      expect(out.some(l => l.startsWith('  Kept existing') && l.includes('charter-governance'))).toBe(false);
    });
  }

  it('JSON: a kept hand-edited workflow is listed in kept (with /), with the warning', async () => {
    write(WF, HAND_EDITED);
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
    const step = setupStep();
    expect(step.details.kept).toContain(WF);
    expect(step.details.updated).not.toContain(P(WF));
    expect(step.details.workflow).toEqual({ file: WF, action: 'kept', reason: 'hand-edited' });
    expect(step.warnings.some((w: string) => w.startsWith(`Kept ${WF}`))).toBe(true);
  });

  it('--force backs a hand-edited workflow up, then replaces it', async () => {
    write(WF, HAND_EDITED);
    expect(await bootstrapCommand(TEXT, ['--force', '--ci', 'github', ...BOOT])).toBe(0);
    expect(read(WF)).toBe(getGithubWorkflow('npm'));
    const files = backups('github-workflows-charter-governance.yml.');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^github-workflows-charter-governance\.yml\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    expect(read(`.charter/.backup/${files[0]}`)).toBe(HAND_EDITED);
    expect(read('.charter/.backup/.gitignore')).toBe('*\n');
    expect(out).toContain(`  Replaced ${WF} (backup: .charter/.backup/${files[0]})`);
  });

  it('--force JSON lists the replaced workflow with its backup', async () => {
    write(WF, HAND_EDITED);
    expect(await bootstrapCommand(JSON_OPTS, ['--force', '--ci', 'github', ...BOOT])).toBe(0);
    const step = setupStep();
    expect(step.details.replaced).toEqual([{ file: WF, reason: 'hand-edited', backup: expect.stringMatching(/^\.charter\/\.backup\/github-workflows-charter-governance\.yml\./) }]);
    expect(step.details.kept).not.toContain(WF);
  });

  it('--force does not replace it when the backup fails: warns, lists it in notReplaced, exits 1', async () => {
    write(WF, HAND_EDITED);
    write('.charter/.backup', 'a file where the backup directory should be\n');
    expect(await bootstrapCommand(TEXT, ['--force', '--ci', 'github', ...BOOT])).toBe(1);
    expect(read(WF)).toBe(HAND_EDITED);
    expect(out.some(l => l.includes(`Could not back up ${WF} to .charter/.backup/`) && l.includes('not replaced (backup failed)'))).toBe(true);
    expect(out).toContain(`  Not replaced ${WF} (backup failed; see warning)`);
    expect(out.some(l => l.startsWith('  Replaced') && l.includes('charter-governance'))).toBe(false);
  });

  it('--force JSON with a failed backup: notReplaced, exit 1', async () => {
    write(WF, HAND_EDITED);
    write('.charter/.backup', 'a file where the backup directory should be\n');
    expect(await bootstrapCommand(JSON_OPTS, ['--force', '--ci', 'github', ...BOOT])).toBe(1);
    const step = setupStep();
    expect(step.details.notReplaced).toEqual([{ file: WF, reason: 'hand-edited', detail: expect.stringContaining('not replaced (backup failed)') }]);
    expect(step.details.workflow).toMatchObject({ file: WF, action: 'not-replaced' });
    expect(read(WF)).toBe(HAND_EDITED);
  });
});

const SETUP = ['--ci', 'github', '--preset', 'worker', '--no-dependency-sync'];

describe('#374 setup --ci github: the workflow', () => {
  it('keeps a hand-edited workflow without --force, with a warning naming what else --force does', async () => {
    write(WF, HAND_EDITED);
    expect(await setupCommand(YES, SETUP)).toBe(0);
    expect(read(WF)).toBe(HAND_EDITED);
    expect(out).toContain(`  CI policy gate: kept (not the Charter template) (${P(WF)})`);
    const warning = out.find(l => l.includes("'charter setup --ci github --force' replaces it"));
    expect(warning).toContain('--force also replaces every .charter/ template that differs');
    expect(warning).toContain('To replace only the workflow, delete it and re-run');
  });

  it('keeps a contents: read historical template without --force, naming the widening', async () => {
    write(WF, PINNED_HISTORICAL);
    expect(await setupCommand(YES, SETUP)).toBe(0);
    expect(read(WF)).toBe(PINNED_HISTORICAL);
    expect(out).toContain(`  CI policy gate: kept (refreshing it would widen CI permissions) (${P(WF)})`);
    const warning = out.find(l => l.startsWith(`  Warning: Kept ${WF}: it is an older Charter template`));
    for (const part of WIDEN_PARTS) expect(warning).toContain(part);
    expect(warning).toContain("'charter setup --ci github --force' upgrades it");
  });

  it('JSON: a widening template is kept, planned and applied as noop', async () => {
    write(WF, PINNED_HISTORICAL);
    expect(await setupCommand(JSON_OPTS, SETUP)).toBe(0);
    const result = JSON.parse(out.join('\n'));
    expect(result.workflow).toMatchObject({ kept: true, reason: 'would-widen-permissions', updated: false });
    expect(result.mutationPlan.workflow.action).toBe('noop');
    expect(result.appliedMutations.workflow.action).toBe('noop');
  });

  it('--force backs a widening template up and replaces it, saying what widened', async () => {
    write(WF, PINNED_HISTORICAL);
    expect(await setupCommand(TEXT, [...SETUP, '--force'])).toBe(0);
    expect(read(WF)).toBe(getGithubWorkflow('npm'));
    const files = backups('github-workflows-charter-governance.yml.');
    expect(files).toHaveLength(1);
    expect(read(`.charter/.backup/${files[0]}`)).toBe(PINNED_HISTORICAL);
    const line = out.find(l => l.startsWith(`  CI policy gate: replaced, backup: .charter/.backup/${files[0]}; widened `));
    for (const part of WIDEN_PARTS) expect(line).toContain(part);
  });

  it('refreshes the other package manager\'s current template without --force', async () => {
    write(WF, getGithubWorkflow('pnpm'));
    expect(await setupCommand(YES, SETUP)).toBe(0);
    expect(read(WF)).toBe(getGithubWorkflow('npm'));
    expect(out).toContain(`  CI policy gate: updated (${P(WF)})`);
  });

  it('--force backs a hand-edited workflow up, then replaces it; JSON names the backup', async () => {
    write(WF, HAND_EDITED);
    expect(await setupCommand(JSON_OPTS, [...SETUP, '--force'])).toBe(0);
    expect(read(WF)).toBe(getGithubWorkflow('npm'));
    const result = JSON.parse(out.join('\n'));
    const files = backups('github-workflows-charter-governance.yml.');
    expect(files).toHaveLength(1);
    expect(read(`.charter/.backup/${files[0]}`)).toBe(HAND_EDITED);
    expect(result.workflow).toMatchObject({ updated: true, reason: 'hand-edited', backup: `.charter/.backup/${files[0]}` });
    expect(result.mutationPlan.workflow.action).toBe('update');
  });

  it('plans a noop for a hand-edited workflow without --force', async () => {
    write(WF, HAND_EDITED);
    expect(await setupCommand(JSON_OPTS, SETUP)).toBe(0);
    const result = JSON.parse(out.join('\n'));
    expect(result.mutationPlan.workflow.action).toBe('noop');
    expect(result.appliedMutations.workflow.action).toBe('noop');
    expect(result.workflow).toMatchObject({ kept: true, reason: 'hand-edited' });
  });

  it('--force with a failed backup: not replaced (backup failed), listed in notReplaced, exit 1', async () => {
    write(WF, HAND_EDITED);
    write('.charter/.backup', 'a file where the backup directory should be\n');
    expect(await setupCommand(TEXT, [...SETUP, '--force'])).toBe(1);
    expect(read(WF)).toBe(HAND_EDITED);
    expect(out).toContain(`  CI policy gate: not replaced (backup failed) (${P(WF)})`);
    expect(out.some(l => l.includes('kept (not the Charter template)'))).toBe(false);
  });

  it('--force JSON with a failed backup: notReplaced lists the workflow, exit 1', async () => {
    write(WF, HAND_EDITED);
    write('.charter/.backup', 'a file where the backup directory should be\n');
    expect(await setupCommand(JSON_OPTS, [...SETUP, '--force'])).toBe(1);
    const result = JSON.parse(out.join('\n'));
    expect(result.notReplaced).toEqual(expect.arrayContaining([{ file: WF, detail: expect.stringContaining('not replaced (backup failed)') }]));
    expect(result.workflow).toMatchObject({ notReplaced: true, updated: false });
    expect(result.workflow.kept).toBeUndefined();
  });
});

describe('bootstrap --preset validation', () => {
  it('names all six presets in the invalid-preset error', async () => {
    await expect(bootstrapCommand(YES, ['--yes', '--preset', 'nope', '--skip-install', '--skip-doctor']))
      .rejects.toThrow('Use worker|frontend|backend|fullstack|docs|rust-wasm.');
  });
});

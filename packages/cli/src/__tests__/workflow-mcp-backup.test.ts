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
import { applyGovernanceWorkflow, KNOWN_WORKFLOWS, normalizeWorkflow, TEMPLATE_PERMISSIONS, workflowHash } from '../commands/github-workflow';

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

// Every historical template (not the current ones), as setup.ts generated it.
// `safe: true` marks one with the current permissions and triggers (#380).
const HISTORY: Array<{ commit: string; packageManager: 'npm' | 'pnpm'; safe?: boolean; text: string }> = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'charter-governance-history.json'), 'utf-8'),
);
const PRE_BADGE = 'contents: read → write; adds push and workflow_dispatch triggers; adds a step that commits and pushes to the repo';
const TEMPLATE_LINE = 'the current Charter template grants contents: write and pull-requests: write, runs on push, pull_request and workflow_dispatch, and has a step that commits and pushes to the repo';

// Hand edits that a YAML diff could misread; none may be described as a change.
const CURRENT = getGithubWorkflow('npm');
const HAND_VARIANTS: Record<string, string> = {
  'flow-style permissions': CURRENT.replace('permissions:\n  contents: write\n  pull-requests: write\n', 'permissions: { contents: write, pull-requests: write }\n'),
  'job-level permissions': CURRENT.replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n'),
  'quoted on:': CURRENT.replace('\non:\n', '\n"on":\n'),
  'write-all': CURRENT.replace('permissions:\n  contents: write\n  pull-requests: write\n', 'permissions: write-all\n'),
  'narrowed (contents: read)': CURRENT.replace('  contents: write\n', '  contents: read\n'),
};

describe('#374 known workflow versions', () => {
  it('lists the current npm and pnpm templates as safe (add new hashes when the template changes)', () => {
    for (const pm of ['npm', 'pnpm'] as const) {
      const entry = KNOWN_WORKFLOWS.find(k => k.hash === workflowHash(getGithubWorkflow(pm)));
      expect(entry).toMatchObject({ safe: true, packageManager: pm });
    }
    const pinned = KNOWN_WORKFLOWS.find(k => k.hash === workflowHash(getGithubWorkflow('pnpm', 'pnpm@10.34.6')));
    expect(pinned).toMatchObject({ safe: true, packageManager: 'pnpm' });
  });

  it('every known hash is unique, a sha256, with a safe flag; every unsafe one has a description', () => {
    const hashes = KNOWN_WORKFLOWS.map(k => k.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const k of KNOWN_WORKFLOWS) {
      expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof k.safe).toBe('boolean');
      expect(k.origin).toMatch(/^(?:[0-9a-f]{7}|#\d+)[ ,]/);
      if (!k.safe) expect(k.refreshChanges.trim().length).toBeGreaterThan(0);
    }
  });

  it('the history fixture and the known list match one to one, and every pre-badge template is unsafe', () => {
    const fixtureHashes = HISTORY.map(h => workflowHash(h.text));
    const current = [workflowHash(getGithubWorkflow('npm')), workflowHash(getGithubWorkflow('pnpm')), workflowHash(getGithubWorkflow('pnpm', 'pnpm@10.34.6'))];
    expect(new Set([...fixtureHashes, ...current])).toEqual(new Set(KNOWN_WORKFLOWS.map(k => k.hash)));
    expect(fixtureHashes.length + current.length).toBe(KNOWN_WORKFLOWS.length);
    for (const h of HISTORY.filter(e => e.safe)) {
      // A safe historical template grants exactly what the current one does (#380).
      const k = KNOWN_WORKFLOWS.find(e => e.hash === workflowHash(h.text));
      expect(k).toMatchObject({ safe: true, packageManager: h.packageManager });
      expect(k?.origin.startsWith(h.commit)).toBe(true);
      const head = (t: string): string => t.slice(0, t.indexOf('\njobs:'));
      expect(head(h.text)).toBe(head(getGithubWorkflow(h.packageManager)));
      expect(h.text).toContain('git push');
      expect(getGithubWorkflow(h.packageManager)).toContain('validate --ci --format text --range "$CHARTER_COMMIT_RANGE"');
      if (h.commit === '003ec8d') expect(h.text).toContain('npx charter validate');
      // Older templates keep their permissions/triggers while receiving the
      // explicit event range and project-local CLI execution fixes.
    }
    for (const h of HISTORY.filter(e => !e.safe)) {
      const k = KNOWN_WORKFLOWS.find(e => e.hash === workflowHash(h.text));
      expect(k).toMatchObject({ safe: false, packageManager: h.packageManager, refreshChanges: PRE_BADGE });
      expect(k?.origin.startsWith(h.commit)).toBe(true);
      // The static description is true of every historical template.
      expect(h.text).toContain('permissions:\n  contents: read\n');
      expect(h.text).not.toContain('git push');
      // ...and its triggers are pull_request only: no push, no workflow_dispatch.
      const on = /\non:\n((?: {2}.*\n|\n)*?)\S/.exec(h.text)?.[1] ?? '';
      expect(on).toContain('pull_request:');
      expect(on).not.toMatch(/^ {2}push:/m);
      expect(on).not.toContain('workflow_dispatch');
    }
  });

  it('TEMPLATE_PERMISSIONS describes the current template', () => {
    expect(TEMPLATE_PERMISSIONS).toBe(TEMPLATE_LINE);
    for (const pm of ['npm', 'pnpm'] as const) {
      const t = getGithubWorkflow(pm);
      expect(t).toContain('permissions:\n  contents: write\n  pull-requests: write\n\njobs:');
      expect(t).toContain('on:\n  push:\n    branches: [main, master]\n  pull_request:\n    branches: [main, master]\n  workflow_dispatch:\n');
      expect(t).toContain('git push');
    }
  });

  it('normalizes a BOM, CRLF, trailing whitespace, trailing blank lines and a pinned CLI version', () => {
    expect(normalizeWorkflow('﻿' + CURRENT.replace(/\n/g, '  \r\n') + '\r\n\r\n')).toBe(normalizeWorkflow(CURRENT));
    expect(workflowHash(PINNED_HISTORICAL.replace('0.4.2', '9.9.9-rc.1'))).toBe(workflowHash(PINNED_HISTORICAL));
  });
});

describe('#374 applyGovernanceWorkflow with an injected known list', () => {
  const samePerms = CURRENT.replace(/\n {6}- name: Audit Report\n[^\n]*\n[^\n]*\n/, '\n');
  const entry = (text: string, safe: boolean) =>
    new Map([[workflowHash(text), { hash: workflowHash(text), origin: 'test', packageManager: 'npm' as const, safe, refreshChanges: safe ? '' : 'some change' }]]);
  const opts = { force: false, configDir: '.charter', command: 'setup' as const, packageManager: 'npm' as const };

  it('refreshes a known safe variant silently', () => {
    expect(samePerms).not.toBe(CURRENT);
    write(WF, samePerms);
    expect(applyGovernanceWorkflow(WF, CURRENT, { ...opts, known: entry(samePerms, true) })).toEqual({ action: 'updated' });
    expect(read(WF)).toBe(CURRENT);
  });

  it('keeps a known unsafe variant with its static description', () => {
    write(WF, samePerms);
    const outcome = applyGovernanceWorkflow(WF, CURRENT, { ...opts, known: entry(samePerms, false) });
    expect(outcome).toMatchObject({ action: 'kept', reason: 'would-widen-permissions', changes: 'some change', templatePermissions: TEMPLATE_LINE });
    expect(read(WF)).toBe(samePerms);
  });
});

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

  it('names a package-manager switch when it refreshes the other current template', async () => {
    write(WF, getGithubWorkflow('npm'));
    write('pnpm-lock.yaml', '');
    expect(await bootstrapCommand(YES, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
    expect(read(WF)).toBe(getGithubWorkflow('pnpm'));
    expect(out).toContain(`  Updated ${P(WF)} (package manager npm → pnpm; adds pnpm/action-setup@v4)`);
    expect(out.some(l => l.includes('Warning') && l.includes('charter-governance.yml'))).toBe(false);
    expect(fs.existsSync('.charter/.backup')).toBe(false);

    fs.rmSync('pnpm-lock.yaml');
    out = [];
    expect(await bootstrapCommand(YES, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
    expect(read(WF)).toBe(getGithubWorkflow('npm'));
    expect(out).toContain(`  Updated ${P(WF)} (package manager pnpm → npm; removes pnpm/action-setup@v4)`);
  });

  it('JSON records the package-manager switch', async () => {
    write(WF, getGithubWorkflow('npm'));
    write('pnpm-lock.yaml', '');
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
    expect(setupStep().details.workflow).toEqual({
      file: WF, action: 'updated', packageManagerChange: { from: 'npm', to: 'pnpm', detail: 'adds pnpm/action-setup@v4' },
    });
  });

  it('refreshes a CRLF or BOM copy of the template it would write, with no note', async () => {
    for (const copy of [CURRENT.replace(/\n/g, '\r\n'), '﻿' + CURRENT]) {
      write(WF, copy);
      out = [];
      expect(await bootstrapCommand(YES, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
      expect(read(WF)).toBe(CURRENT);
      expect(out).toContain(`  Updated ${P(WF)}`);
    }
    expect(fs.existsSync('.charter/.backup')).toBe(false);
  });

  for (const h of HISTORY.filter(e => e.safe)) {
    it(`refreshes the ${h.commit} ${h.packageManager} template under --yes, silently (same permissions, #380)`, async () => {
      write(WF, h.text);
      if (h.packageManager === 'pnpm') write('pnpm-lock.yaml', '');
      expect(await bootstrapCommand(YES, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
      expect(read(WF)).toBe(getGithubWorkflow(h.packageManager));
      expect(out).toContain(`  Updated ${P(WF)}`);
      expect(out.some(l => l.includes('Warning: Kept'))).toBe(false);
      expect(fs.existsSync('.charter/.backup')).toBe(false);
    });
  }

  for (const h of HISTORY.filter(e => !e.safe)) {
    it(`keeps the ${h.commit} ${h.packageManager} template under --yes with the static message`, async () => {
      write(WF, h.text);
      if (h.packageManager === 'pnpm') write('pnpm-lock.yaml', '');
      expect(await bootstrapCommand(YES, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
      expect(read(WF)).toBe(h.text);
      expect(fs.existsSync('.charter/.backup')).toBe(false);
      expect(out).toContain(
        `  Warning: Kept ${WF}: it is an older Charter template, and refreshing it to the current one changes what CI may do: ${PRE_BADGE}. ` +
        "It was not overwritten. 'charter bootstrap --ci github --force' upgrades it, backing it up to .charter/.backup/ first " +
        "(--force also rewrites every Charter-managed pointer, replaces .mcp.json's mcpServers.charter entry (backing .mcp.json up first) " +
        'and merges the preset template into .ai/*.adf without rewriting existing content). To replace only the workflow, delete it and re-run without --force.',
      );
    });
  }

  it('plain bootstrap (no --yes) also keeps a historical template', async () => {
    write(WF, PINNED_HISTORICAL);
    expect(await bootstrapCommand(TEXT, ['--ci', 'github', ...BOOT])).toBe(0);
    expect(read(WF)).toBe(PINNED_HISTORICAL);
  });

  it('JSON: a historical template is kept with reason would-widen-permissions and the static texts', async () => {
    write(WF, PINNED_HISTORICAL);
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
    const step = setupStep();
    expect(step.details.kept).toContain(P(WF));
    expect(step.details.workflow).toEqual({
      file: WF, action: 'kept', reason: 'would-widen-permissions', changes: PRE_BADGE, templatePermissions: TEMPLATE_LINE,
    });
    expect(JSON.stringify(step)).not.toContain('widens');
  });

  it('--force backs a historical template up, then replaces it, naming the changes', async () => {
    write(WF, PINNED_HISTORICAL);
    expect(await bootstrapCommand(TEXT, ['--force', '--ci', 'github', ...BOOT])).toBe(0);
    expect(read(WF)).toBe(CURRENT);
    const files = backups('github-workflows-charter-governance.yml.');
    expect(files).toHaveLength(1);
    expect(read(`.charter/.backup/${files[0]}`)).toBe(PINNED_HISTORICAL);
    expect(out).toContain(`  Replaced ${WF} (backup: .charter/.backup/${files[0]}; changes: ${PRE_BADGE})`);
  });

  for (const [name, text] of Object.entries({ 'hand-edited': HAND_EDITED, ...HAND_VARIANTS })) {
    it(`keeps a ${name} workflow with the template-permissions warning and no claim of what changed`, async () => {
      write(WF, text);
      expect(await bootstrapCommand(YES, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
      expect(read(WF)).toBe(text);
      expect(fs.existsSync('.charter/.backup')).toBe(false);
      const warning = out.find(l => l.startsWith(`  Warning: Kept ${WF}: it differs from every workflow Charter generated`));
      expect(warning).toContain(`The current Charter template grants contents: write and pull-requests: write, runs on push, pull_request and workflow_dispatch, and has a step that commits and pushes to the repo; review it before using --force.`);
      expect(warning).toContain("'charter bootstrap --ci github --force' replaces it with the current template, backing it up to .charter/.backup/ first");
      expect(warning).toContain('rewrites every Charter-managed pointer');
      expect(warning).toContain('To replace only the workflow, delete it and re-run');
      expect(out.join('\n')).not.toMatch(/widen|[a-z-]+: [a-z-]+ →/);
      expect(out.some(l => l.startsWith('  Kept existing') && l.includes('charter-governance'))).toBe(false);
    });
  }

  for (const [name, text] of Object.entries(HAND_VARIANTS)) {
    it(`--force replaces a ${name} workflow, stating the template's permissions, not a diff`, async () => {
      write(WF, text);
      expect(await bootstrapCommand(TEXT, ['--force', '--ci', 'github', ...BOOT])).toBe(0);
      expect(read(WF)).toBe(CURRENT);
      const files = backups('github-workflows-charter-governance.yml.');
      expect(out).toContain(`  Replaced ${WF} (backup: .charter/.backup/${files[0]}; ${TEMPLATE_LINE})`);
      expect(out.join('\n')).not.toMatch(/widen|[a-z-]+: [a-z-]+ →/);
    });
  }

  it('JSON: a kept hand-edited workflow (platform separator in kept, / elsewhere)', async () => {
    write(WF, HAND_EDITED);
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
    const step = setupStep();
    expect(step.details.kept).toContain(P(WF));
    expect(step.details.workflow).toEqual({ file: WF, action: 'kept', reason: 'hand-edited', templatePermissions: TEMPLATE_LINE });
    expect(step.warnings.some((w: string) => w.startsWith(`Kept ${WF}`))).toBe(true);
  });

  it('--force JSON lists the replaced workflow with its backup', async () => {
    write(WF, HAND_EDITED);
    expect(await bootstrapCommand(JSON_OPTS, ['--force', '--ci', 'github', ...BOOT])).toBe(0);
    const step = setupStep();
    expect(step.details.replaced).toEqual([{ file: WF, reason: 'hand-edited', note: TEMPLATE_LINE, backup: expect.stringMatching(/^\.charter\/\.backup\/github-workflows-charter-governance\.yml\./) }]);
    expect(step.details.kept).not.toContain(P(WF));
    expect(read('.charter/.backup/.gitignore')).toBe('*\n');
  });

  it('--force with a failed backup: not replaced, a failed step, no "Bootstrap complete", exit 1', async () => {
    write(WF, HAND_EDITED);
    write('.charter/.backup', 'a file where the backup directory should be\n');
    expect(await bootstrapCommand(TEXT, ['--force', '--ci', 'github', ...BOOT])).toBe(1);
    expect(read(WF)).toBe(HAND_EDITED);
    expect(out.some(l => l.includes(`Could not back up ${WF} to .charter/.backup/`) && l.includes('not replaced (backup failed)'))).toBe(true);
    expect(out).toContain(`  Not replaced ${WF} (backup failed; see warning)`);
    expect(out.some(l => l.startsWith('Bootstrap complete'))).toBe(false);
    expect(out.some(l => l.startsWith('Bootstrap finished with failures.'))).toBe(true);
    expect(out.some(l => l.includes('Bootstrap partially complete') )).toBe(true);
  });

  it('--force JSON with a failed backup: status partial, setup step fail, notReplaced, exit 1', async () => {
    write(WF, HAND_EDITED);
    write('.charter/.backup', 'a file where the backup directory should be\n');
    expect(await bootstrapCommand(JSON_OPTS, ['--force', '--ci', 'github', ...BOOT])).toBe(1);
    const json = JSON.parse(out.join('\n'));
    expect(json.status).toBe('partial');
    const step = setupStep();
    expect(step.status).toBe('fail');
    expect(step.details.notReplaced).toEqual([{ file: WF, reason: 'hand-edited', detail: expect.stringContaining('not replaced (backup failed)') }]);
    expect(step.details.workflow).toMatchObject({ file: WF, action: 'not-replaced' });
  });
});

describe('#374 bootstrap --force: .mcp.json backup failure', () => {
  it('a mcpServers.charter entry --force could not replace: notReplaced, failed step, exit 1', async () => {
    const MCP = JSON.stringify({ mcpServers: { charter: { command: 'charter' } } }, null, 2) + '\n';
    write('.mcp.json', MCP);
    write('.charter/.backup', 'a file where the backup directory should be\n');
    expect(await bootstrapCommand(JSON_OPTS, ['--force', ...BOOT])).toBe(1);
    expect(read('.mcp.json')).toBe(MCP);
    const json = JSON.parse(out.join('\n'));
    expect(json.status).toBe('partial');
    const step = setupStep();
    expect(step.status).toBe('fail');
    expect(step.details.notReplaced).toEqual([{ file: '.mcp.json', detail: expect.stringContaining('mcpServers.charter was not replaced') }]);
  });
});

describe('#374 governance gaps: the CI workflow check', () => {
  const DRIFT_CONFIG = JSON.stringify({ project: 'x', drift: { enabled: true } }, null, 2) + '\n';
  const gapListed = () => (JSON.parse(out.join('\n')).governanceGaps as Array<{ gap: string }>)
    .some(g => g.gap === 'drift detection enabled but no CI workflow');

  it('finds the generated charter-governance.yml', async () => {
    write('.charter/config.json', DRIFT_CONFIG);
    write(WF, CURRENT);
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--yes', ...BOOT])).toBe(0);
    expect(gapListed()).toBe(false);
  });

  it('also accepts charter.yml', async () => {
    write('.charter/config.json', DRIFT_CONFIG);
    write('.github/workflows/charter.yml', 'name: x\n');
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--yes', ...BOOT])).toBe(0);
    expect(gapListed()).toBe(false);
  });

  it('reports the gap when neither exists', async () => {
    write('.charter/config.json', DRIFT_CONFIG);
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--yes', ...BOOT])).toBe(0);
    expect(gapListed()).toBe(true);
  });
});

const SETUP = ['--ci', 'github', '--preset', 'worker', '--no-dependency-sync'];

describe('#374 setup --ci github: the workflow', () => {
  it('keeps a hand-edited workflow without --force, with the template-permissions warning', async () => {
    write(WF, HAND_EDITED);
    expect(await setupCommand(YES, SETUP)).toBe(0);
    expect(read(WF)).toBe(HAND_EDITED);
    expect(out).toContain(`  CI policy gate: kept (not the Charter template) (${P(WF)})`);
    const warning = out.find(l => l.includes("'charter setup --ci github --force' replaces it"));
    expect(warning).toContain(`${TEMPLATE_LINE.charAt(0).toUpperCase()}${TEMPLATE_LINE.slice(1)}; review it before using --force.`);
    expect(warning).toContain('--force also replaces every .charter/ template that differs');
    expect(warning).toContain('To replace only the workflow, delete it and re-run');
  });

  for (const h of HISTORY.filter(e => e.safe)) {
    it(`setup refreshes the ${h.commit} ${h.packageManager} template without --force (#380)`, async () => {
      write(WF, h.text);
      if (h.packageManager === 'pnpm') write('pnpm-lock.yaml', '');
      expect(await setupCommand(YES, SETUP)).toBe(0);
      expect(read(WF)).toBe(getGithubWorkflow(h.packageManager));
      expect(out.some(l => l.includes('Warning: Kept'))).toBe(false);
      expect(fs.existsSync('.charter/.backup')).toBe(false);
    });
  }

  for (const h of HISTORY.filter(e => !e.safe)) {
    it(`keeps the ${h.commit} ${h.packageManager} template with the static message`, async () => {
      write(WF, h.text);
      if (h.packageManager === 'pnpm') write('pnpm-lock.yaml', '');
      expect(await setupCommand(YES, SETUP)).toBe(0);
      expect(read(WF)).toBe(h.text);
      expect(out).toContain(`  CI policy gate: kept (older Charter template; upgrading it changes CI permissions, see warning) (${P(WF)})`);
      const warning = out.find(l => l.startsWith(`  Warning: Kept ${WF}: it is an older Charter template`));
      expect(warning).toContain(`changes what CI may do: ${PRE_BADGE}. It was not overwritten.`);
      expect(warning).toContain("'charter setup --ci github --force' upgrades it");
    });
  }

  it('JSON: a historical template is kept, planned and applied as noop', async () => {
    write(WF, PINNED_HISTORICAL);
    expect(await setupCommand(JSON_OPTS, SETUP)).toBe(0);
    const result = JSON.parse(out.join('\n'));
    expect(result.workflow).toMatchObject({ kept: true, reason: 'would-widen-permissions', changes: PRE_BADGE, templatePermissions: TEMPLATE_LINE, updated: false });
    expect(result.workflow.widens).toBeUndefined();
    expect(result.mutationPlan.workflow.action).toBe('noop');
    expect(result.appliedMutations.workflow.action).toBe('noop');
  });

  it('--force backs a historical template up and replaces it, naming the changes', async () => {
    write(WF, PINNED_HISTORICAL);
    expect(await setupCommand(TEXT, [...SETUP, '--force'])).toBe(0);
    expect(read(WF)).toBe(CURRENT);
    const files = backups('github-workflows-charter-governance.yml.');
    expect(files).toHaveLength(1);
    expect(read(`.charter/.backup/${files[0]}`)).toBe(PINNED_HISTORICAL);
    expect(out).toContain(`  CI policy gate: replaced, backup: .charter/.backup/${files[0]}; changes: ${PRE_BADGE} (${P(WF)})`);
  });

  it('names a package-manager switch', async () => {
    write(WF, getGithubWorkflow('pnpm'));
    expect(await setupCommand(YES, SETUP)).toBe(0);
    expect(read(WF)).toBe(CURRENT);
    expect(out).toContain(`  CI policy gate: updated (package manager pnpm → npm; removes pnpm/action-setup@v4) (${P(WF)})`);
  });

  it('--force replaces a hand-edited workflow; JSON lists it in top-level replaced with reason', async () => {
    write(WF, HAND_EDITED);
    expect(await setupCommand(JSON_OPTS, [...SETUP, '--force'])).toBe(0);
    expect(read(WF)).toBe(CURRENT);
    const result = JSON.parse(out.join('\n'));
    const files = backups('github-workflows-charter-governance.yml.');
    expect(files).toHaveLength(1);
    expect(read(`.charter/.backup/${files[0]}`)).toBe(HAND_EDITED);
    expect(result.workflow).toMatchObject({ updated: true, reason: 'hand-edited', backup: `.charter/.backup/${files[0]}`, templatePermissions: TEMPLATE_LINE });
    expect(result.replaced).toEqual(expect.arrayContaining([{ file: WF, backup: `.charter/.backup/${files[0]}`, reason: 'hand-edited' }]));
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

  it('--force with a failed backup: not replaced (backup failed), exit 1', async () => {
    write(WF, HAND_EDITED);
    write('.charter/.backup', 'a file where the backup directory should be\n');
    expect(await setupCommand(TEXT, [...SETUP, '--force'])).toBe(1);
    expect(read(WF)).toBe(HAND_EDITED);
    expect(out).toContain(`  CI policy gate: not replaced (backup failed) (${P(WF)})`);
    expect(out.some(l => l.includes('kept (not the Charter template)'))).toBe(false);
  });

  it('--force JSON with a failed backup: notReplaced lists the workflow with its reason, exit 1', async () => {
    write(WF, PINNED_HISTORICAL);
    write('.charter/.backup', 'a file where the backup directory should be\n');
    expect(await setupCommand(JSON_OPTS, [...SETUP, '--force'])).toBe(1);
    const result = JSON.parse(out.join('\n'));
    expect(result.notReplaced).toEqual(expect.arrayContaining([
      { file: WF, reason: 'would-widen-permissions', detail: expect.stringContaining('not replaced (backup failed)') },
    ]));
    expect(result.workflow).toMatchObject({ notReplaced: true, updated: false });
    expect(result.workflow.kept).toBeUndefined();
  });
});

describe('#374 an upgrade that also switches package manager', () => {
  const SWITCH = 'package manager npm → pnpm (adds pnpm/action-setup@v4)';

  it('the kept warning and JSON name the switch', async () => {
    write(WF, PINNED_HISTORICAL);
    write('pnpm-lock.yaml', '');
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--yes', '--ci', 'github', ...BOOT])).toBe(0);
    const step = setupStep();
    expect(step.details.workflow).toMatchObject({
      action: 'kept', reason: 'would-widen-permissions', packageManagerChange: { from: 'npm', to: 'pnpm', detail: 'adds pnpm/action-setup@v4' },
    });
    expect(step.warnings.some((w: string) => w.includes(`changes what CI may do: ${PRE_BADGE}; ${SWITCH}. It was not overwritten.`))).toBe(true);
  });

  it('bootstrap --force: the Replaced line names the switch', async () => {
    write(WF, PINNED_HISTORICAL);
    write('pnpm-lock.yaml', '');
    expect(await bootstrapCommand(TEXT, ['--force', '--ci', 'github', ...BOOT])).toBe(0);
    expect(read(WF)).toBe(getGithubWorkflow('pnpm'));
    const files = backups('github-workflows-charter-governance.yml.');
    expect(out).toContain(`  Replaced ${WF} (backup: .charter/.backup/${files[0]}; changes: ${PRE_BADGE}; ${SWITCH})`);
  });

  it('setup --force JSON records packageManagerChange', async () => {
    write(WF, PINNED_HISTORICAL);
    write('pnpm-lock.yaml', '');
    expect(await setupCommand(JSON_OPTS, [...SETUP, '--force'])).toBe(0);
    const result = JSON.parse(out.join('\n'));
    expect(result.workflow).toMatchObject({ updated: true, packageManagerChange: { from: 'npm', to: 'pnpm' } });
  });
});

describe('#374 bootstrap summary and failure banner', () => {
  it('a failed backup: the banner names the cause and the fix', async () => {
    write(WF, HAND_EDITED);
    write('.charter/.backup', 'a file where the backup directory should be\n');
    expect(await bootstrapCommand(TEXT, ['--force', '--ci', 'github', ...BOOT])).toBe(1);
    expect(out).toContain(`   • setup: .charter/.backup not writable: ${WF} not replaced`);
    expect(out).toContain('   1. Make .charter/.backup a writable directory (fix its permissions, or move aside a file of that name), then re-run charter bootstrap --force');
  });

  it('a failed doctor step that exits 0 keeps "Bootstrap complete."', async () => {
    // A kept, empty blessed stack makes doctor's "Patterns loaded" check WARN.
    write('.charter/patterns/blessed-stack.json', '{ "patterns": [] }\n');
    const code = await bootstrapCommand(YES, ['--yes', '--preset', 'worker', '--skip-install']);
    const doctorFailed = out.some(l => /^ {3}• doctor/.test(l));
    expect(doctorFailed).toBe(true);
    expect(code).toBe(0);
    expect(out.some(l => l.startsWith('Bootstrap complete.'))).toBe(true);
    expect(out.some(l => l.startsWith('Bootstrap finished with failures.'))).toBe(false);
  });
});

describe('#374 .mcp.json: adding the entry under --force with a failed backup', () => {
  it('stays a warning with exit 0 and leaves the file untouched', async () => {
    const original = '{ "mcpServers": { "github": { "command": "npx" } } }\n';
    write('.mcp.json', original);
    write('.charter/.backup', 'a file where the backup directory should be\n');
    expect(await bootstrapCommand(TEXT, ['--force', ...BOOT])).toBe(0);
    expect(read('.mcp.json')).toBe(original);
    expect(out.some(l => l.includes('mcpServers.charter was not added'))).toBe(true);
    expect(out.some(l => l.startsWith('  Not replaced .mcp.json'))).toBe(false);
  });
});

describe('bootstrap --preset validation', () => {
  it('names all six presets in the invalid-preset error', async () => {
    await expect(bootstrapCommand(YES, ['--yes', '--preset', 'nope', '--skip-install', '--skip-doctor']))
      .rejects.toThrow('Use worker|frontend|backend|fullstack|docs|rust-wasm.');
  });
});

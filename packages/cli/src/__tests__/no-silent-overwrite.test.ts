/**
 * No silent overwrite (#369, #370).
 *
 * #369: `bootstrap` never overwrites an existing .charter/ file (it creates each
 * missing one); `.mcp.json`'s mcpServers.charter is replaced only under
 * `bootstrap --force`, after a backup; `charter init --force` is the explicit
 * replace path, backing each replaced file up to .charter/.backup/.
 *
 * #370: `adf init --force` merges the template in exactly as `bootstrap --force`
 * does; `adf init --reset-adf` replaces, with confirmation, backups and a loss report.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';

// A switch that makes the re-parse guard see a different document (guard test).
let tamper: ((text: string) => boolean) | null = null;
vi.mock('@stackbilt/adf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stackbilt/adf')>();
  return {
    ...actual,
    parseAdf: (text: string) => {
      const doc = actual.parseAdf(text);
      if (tamper && tamper(text)) doc.sections.push({ key: 'TAMPERED', decoration: null, content: { type: 'text', value: 'x' } });
      return doc;
    },
  };
});

// Interactive prompt: answer injected per test; the real readline never runs.
let promptAnswer = 'n';
vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:readline')>();
  return {
    ...actual,
    createInterface: () => ({
      question: (_q: string, cb: (a: string) => void) => { cb(promptAnswer); },
      close: () => undefined,
    }),
  };
});

vi.mock('../git-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-helpers')>();
  return { ...actual, isGitRepo: () => true };
});

import {
  adfCommand,
  BACKEND_SCAFFOLD,
  CORE_SCAFFOLD,
  FRONTEND_SCAFFOLD,
  MANIFEST_SCAFFOLD,
  STATE_SCAFFOLD,
} from '../commands/adf';
import { bootstrapCommand } from '../commands/bootstrap';
import { initCommand } from '../commands/init';
import { setupCommand } from '../commands/setup';

const TEXT: CLIOptions = { configPath: '.charter', format: 'text', ciMode: false, yes: false };
const JSON_OPTS: CLIOptions = { ...TEXT, format: 'json' };
const YES: CLIOptions = { ...TEXT, yes: true };
const BOOT = ['--preset', 'worker', '--skip-install', '--skip-doctor'];

let out: string[] = [];
let errOut: string[] = [];
let tempDir = '';
const originalCwd = process.cwd();

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'charter-369-370-')));
  process.chdir(tempDir);
  out = [];
  errOut = [];
  tamper = null;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errOut.push(a.map(String).join(' ')); });
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
});

function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(rel), { recursive: true });
  fs.writeFileSync(rel, text);
}

const read = (rel: string): string => fs.readFileSync(rel, 'utf-8');

/** Every file under the temp dir (telemetry excluded), relative path -> bytes. */
function tree(dir = '.'): Map<string, string> {
  const outMap = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else outMap.set(p.split(path.sep).join('/'), read(p));
    }
  };
  walk(dir);
  for (const k of [...outMap.keys()]) if (k.includes('telemetry/')) outMap.delete(k);
  return outMap;
}

const HAND = {
  '.charter/config.json': '{\n  "project": "hand-edited",\n  "git": { "requireTrailers": false }\n}\n',
  '.charter/patterns/blessed-stack.json': '{ "customized": true, "patterns": [] }\n',
  '.charter/policies/governance.md': '# Our governance\n\nHand written.\n',
  '.charter/.gitignore': '# ours\nsecrets/\n',
};

function writeHandCharter(): void {
  for (const [f, t] of Object.entries(HAND)) write(f, t);
}

// ============================================================================
// #369 — bootstrap never overwrites .charter/
// ============================================================================

describe('#369 bootstrap keeps .charter/ files', () => {
  for (const flags of [['--yes'], ['--force'], ['--yes', '--force']]) {
    it(`keeps hand-edited .charter/ files byte-for-byte under ${flags.join(' ')}`, async () => {
      writeHandCharter();
      const code = await bootstrapCommand(flags.includes('--yes') ? YES : TEXT, [...flags, ...BOOT]);
      expect(code).toBe(0);
      for (const [f, t] of Object.entries(HAND)) expect(read(f)).toBe(t);
      expect(fs.existsSync('.charter/.backup')).toBe(false);
      // No claim of having created a file it kept; the kept files are named.
      expect(out.some(l => /Created \.charter/.test(l))).toBe(false);
      const kept = out.find(l => l.startsWith('  Kept existing '));
      expect(kept).toContain('.charter/config.json');
      expect(kept).toContain("'charter init --force' replaces them");
    });
  }

  it('creates a missing blessed-stack.json even though config.json exists', async () => {
    writeHandCharter();
    fs.rmSync('.charter/patterns/blessed-stack.json');
    expect(await bootstrapCommand(YES, ['--yes', ...BOOT])).toBe(0);
    expect(JSON.parse(read('.charter/patterns/blessed-stack.json')).patterns.length).toBeGreaterThan(0);
    expect(read('.charter/config.json')).toBe(HAND['.charter/config.json']);
    expect(out).toContain('  Created .charter/patterns/blessed-stack.json');
    expect(out.some(l => l.includes('Created .charter/config.json'))).toBe(false);
  });

  it('reports created and kept files in the JSON setup step', async () => {
    writeHandCharter();
    fs.rmSync('.charter/policies/governance.md');
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--yes', ...BOOT])).toBe(0);
    const setup = JSON.parse(out.join('\n')).steps.find((s: { name: string }) => s.name === 'setup');
    expect(setup.details.created).toContain('.charter/policies/governance.md');
    expect(setup.details.created).not.toContain('.charter/config.json');
    expect(setup.details.kept).toEqual(expect.arrayContaining(['.charter/config.json', '.charter/.gitignore']));
  });

  it('keeps a hand-edited SECURITY.md and security-deny.json under --security-sensitive --yes', async () => {
    write('SECURITY.md', '# Our security policy\n');
    write('.charter/patterns/security-deny.json', '{ "patterns": [] }\n');
    expect(await bootstrapCommand(YES, ['--yes', '--security-sensitive', ...BOOT])).toBe(0);
    expect(read('SECURITY.md')).toBe('# Our security policy\n');
    expect(read('.charter/patterns/security-deny.json')).toBe('{ "patterns": [] }\n');
  });
});

// ============================================================================
// #369 — .mcp.json mcpServers.charter
// ============================================================================

describe('#369 .mcp.json mcpServers.charter', () => {
  const MCP = JSON.stringify({
    mcpServers: {
      charter: { command: 'charter', args: ['serve', '--name', 'mine'] },
      github: { command: 'npx', args: ['@modelcontextprotocol/server-github'] },
    },
    other: { keep: true },
  }, null, 2) + '\n';

  it('--yes leaves a differing entry unchanged and warns', async () => {
    write('.mcp.json', MCP);
    expect(await bootstrapCommand(YES, ['--yes', ...BOOT])).toBe(0);
    expect(read('.mcp.json')).toBe(MCP);
    const warning = out.find(l => l.includes('already defines mcpServers.charter'));
    expect(warning).toContain('--yes alone never does');
    expect(warning).toContain('backs .mcp.json up to .charter/.backup/');
    expect(fs.existsSync('.charter/.backup')).toBe(false);
  });

  it('--force replaces it after backing .mcp.json up to a gitignored .charter/.backup/', async () => {
    write('.mcp.json', MCP);
    expect(await bootstrapCommand(TEXT, ['--force', ...BOOT])).toBe(0);
    const parsed = JSON.parse(read('.mcp.json'));
    expect(parsed.mcpServers.charter).toEqual({ command: 'npx', args: ['@stackbilt/cli', 'serve', '--ai-dir', '.ai'] });
    expect(parsed.mcpServers.github).toEqual({ command: 'npx', args: ['@modelcontextprotocol/server-github'] });
    expect(parsed.other).toEqual({ keep: true });
    const backups = fs.readdirSync('.charter/.backup').filter(f => f.startsWith('mcp.json.'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^mcp\.json\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    expect(read(`.charter/.backup/${backups[0]}`)).toBe(MCP);
    expect(read('.charter/.backup/.gitignore')).toBe('*\n');
    expect(out).toContain(`  Updated .mcp.json (backup: .charter/.backup/${backups[0]})`);
  });

  it('--force does not replace it when the backup fails, and warns', async () => {
    write('.mcp.json', MCP);
    write('.charter/.backup', 'a file where the backup directory should be\n');
    expect(await bootstrapCommand(TEXT, ['--force', ...BOOT])).toBe(0);
    expect(read('.mcp.json')).toBe(MCP);
    expect(out.some(l => l.includes('could not back up .mcp.json to .charter/.backup/') && l.includes('was not replaced'))).toBe(true);
  });

  it('--reset-adf --yes alone does not replace it', async () => {
    write('.mcp.json', MCP);
    expect(await bootstrapCommand(YES, ['--reset-adf', '--yes', ...BOOT])).toBe(0);
    expect(read('.mcp.json')).toBe(MCP);
  });
});

// ============================================================================
// #369 — charter init
// ============================================================================

describe('#369 charter init', () => {
  it('--yes no longer overwrites existing files', async () => {
    writeHandCharter();
    expect(await initCommand(YES, ['--yes'])).toBe(0);
    for (const [f, t] of Object.entries(HAND)) expect(read(f)).toBe(t);
    expect(fs.existsSync('.charter/.backup')).toBe(false);
  });

  it('without --force creates a missing file and keeps the rest', async () => {
    writeHandCharter();
    fs.rmSync('.charter/policies/governance.md');
    expect(await initCommand(TEXT, [])).toBe(0);
    expect(read('.charter/policies/governance.md')).toContain('# Governance Policy');
    expect(read('.charter/config.json')).toBe(HAND['.charter/config.json']);
    expect(out).toContain('  Created .charter/policies/governance.md');
  });

  it('--force replaces differing files, backing each up first', async () => {
    writeHandCharter();
    expect(await initCommand(TEXT, ['--force'])).toBe(0);
    expect(read('.charter/config.json')).not.toBe(HAND['.charter/config.json']);
    const backups = fs.readdirSync('.charter/.backup');
    expect(backups).toContain('.gitignore');
    expect(read('.charter/.backup/.gitignore')).toBe('*\n');
    const pairs: Array<[string, string]> = [
      ['.charter/config.json', 'config.json.'],
      ['.charter/patterns/blessed-stack.json', 'patterns-blessed-stack.json.'],
      ['.charter/policies/governance.md', 'policies-governance.md.'],
      ['.charter/.gitignore', '.gitignore.'],
    ];
    for (const [file, prefix] of pairs) {
      const backup = backups.find(b => b.startsWith(prefix));
      expect(backup, file).toBeDefined();
      expect(read(`.charter/.backup/${backup}`)).toBe(HAND[file as keyof typeof HAND]);
      expect(out).toContain(`  Replaced ${file} (backup: .charter/.backup/${backup})`);
    }
  });

  it('--force JSON lists replaced files with their backups', async () => {
    writeHandCharter();
    expect(await initCommand(JSON_OPTS, ['--force'])).toBe(0);
    const result = JSON.parse(out.join('\n'));
    expect(result.replaced.map((r: { file: string }) => r.file)).toEqual(expect.arrayContaining(Object.keys(HAND)));
    for (const r of result.replaced as Array<{ file: string; backup: string }>) {
      expect(r.backup.startsWith('.charter/.backup/')).toBe(true);
      expect(read(r.backup)).toBe(HAND[r.file as keyof typeof HAND]);
    }
    expect(result.notReplaced).toEqual([]);
  });

  it('--force leaves a file whose backup fails as is, and exits 1 when nothing could be replaced', async () => {
    writeHandCharter();
    write('.charter/.backup', 'not a directory\n');
    expect(await initCommand(JSON_OPTS, ['--force'])).toBe(1);
    for (const [f, t] of Object.entries(HAND)) expect(read(f)).toBe(t);
    const result = JSON.parse(out.join('\n'));
    expect(result.replaced).toEqual([]);
    expect(result.notReplaced.map((n: { file: string }) => n.file)).toEqual(expect.arrayContaining(Object.keys(HAND)));
  });

  it('charter setup --force backs up before replacing; setup without --force keeps files', async () => {
    writeHandCharter();
    expect(await setupCommand(TEXT, ['--preset', 'worker', '--no-dependency-sync'])).toBe(0);
    expect(read('.charter/config.json')).toBe(HAND['.charter/config.json']);
    out = [];
    expect(await setupCommand(JSON_OPTS, ['--preset', 'worker', '--no-dependency-sync', '--force'])).toBe(0);
    const result = JSON.parse(out.join('\n'));
    const config = result.replaced.find((r: { file: string }) => r.file === '.charter/config.json');
    expect(read(config.backup)).toBe(HAND['.charter/config.json']);
  });
});

// ============================================================================
// #370 — adf init --force merges
// ============================================================================

const HAND_MANIFEST = MANIFEST_SCAFFOLD
  .replace('frontend.adf (Triggers on: React, CSS, UI)', 'frontend.adf (Triggers on: React, CSS, UI, tailwind)')
  .replace('  - backend.adf (Triggers on: API, Node, DB)\n', '  - billing.adf (Triggers on: payments, stripe)\n')
  .replace('  - Never assume unseen modules were loaded.\n', '  - Never assume unseen modules were loaded.\n  - CUSTOM RULE: load billing.adf for payments.\n')
  + '\n\u{1F4CA} METRICS:\n  ENTRY_LOC: src/index.ts\n';
const HAND_CORE = 'ADF: 0.1\n\n\u{1F4CB} CONTEXT:\n  - Billing service for Acme\n\n\u{1F4CA} METRICS:\n  entry_loc: 120 / 150 [lines]\n';
const HAND_STATE = 'ADF: 0.1\n\u{1F9E0} STATE:\n  CURRENT: Shipping invoices v2\n';

describe('#370 adf init --force merges', () => {
  function writeHandAi(): void {
    write('.ai/manifest.adf', HAND_MANIFEST);
    write('.ai/core.adf', HAND_CORE);
    write('.ai/state.adf', HAND_STATE);
    write('.ai/frontend.adf', 'ADF: 0.1\n\u{1F4CB} CONTEXT:\n  - Our frontend rules\n');
    write('.ai/billing.adf', 'ADF: 0.1\n\u{1F4CB} CONTEXT:\n  - Stripe\n');
  }

  it('appends only missing sections and modules, never rewriting existing bytes', async () => {
    writeHandAi();
    const before = tree();
    expect(await adfCommand(TEXT, ['init', '--force'])).toBe(0);

    // Every existing file keeps its bytes as a prefix; custom triggers, RULES and METRICS survive.
    for (const [f, t] of before) if (f !== '.ai/manifest.adf') expect(read(f).startsWith(t), f).toBe(true);
    // manifest.adf: exactly one line inserted (the module entry); no other byte changed.
    const manifest = read('.ai/manifest.adf');
    expect(manifest.replace('  - backend.adf (Triggers on: API, Node, DB)\n', '')).toBe(HAND_MANIFEST);
    expect(manifest).toContain('frontend.adf (Triggers on: React, CSS, UI, tailwind)');
    expect(manifest).toContain('CUSTOM RULE: load billing.adf for payments.');
    expect(manifest).toContain('ENTRY_LOC: src/index.ts');
    // The missing template module file is created and registered with the template's triggers.
    expect(read('.ai/backend.adf')).toBe(BACKEND_SCAFFOLD);
    expect(manifest).toContain('backend.adf (Triggers on: API, Node, DB)');
    // core.adf gains the template sections it lacked, METRICS untouched.
    const core = read('.ai/core.adf');
    expect(core.startsWith(HAND_CORE)).toBe(true);
    expect(core).toContain('CONSTRAINTS [load-bearing]');
    expect(core).toContain('entry_loc: 120 / 150 [lines]');
    expect(core).not.toContain('entry_loc: 0 / 500');
    // No backups, and the lock (absent before) is created.
    expect(fs.existsSync('.ai/.backup')).toBe(false);
    expect(read('.ai/.adf.lock')).toBe('{}\n');
    expect(out).toContain('  Created .ai/backend.adf');
    expect(out.some(l => l.startsWith('  Merged .ai/core.adf: added sections'))).toBe(true);
    expect(out.some(l => l.startsWith('  Merged .ai/manifest.adf') && l.includes('backend.adf (ON_DEMAND)'))).toBe(true);
  });

  it('is idempotent: a second run changes nothing', async () => {
    writeHandAi();
    expect(await adfCommand(TEXT, ['init', '--force'])).toBe(0);
    const first = tree();
    out = [];
    expect(await adfCommand(TEXT, ['init', '--force'])).toBe(0);
    expect(tree()).toEqual(first);
    expect(out.some(l => l.startsWith('  Merged .ai/') || l.startsWith('  Created '))).toBe(false);
  });

  it('keeps CRLF line endings', async () => {
    writeHandAi();
    const crlf = HAND_CORE.replace(/\n/g, '\r\n');
    write('.ai/core.adf', crlf);
    expect(await adfCommand(TEXT, ['init', '--force'])).toBe(0);
    const core = read('.ai/core.adf');
    expect(core.startsWith(crlf)).toBe(true);
    expect(core.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('JSON carries mode and per-file outcomes', async () => {
    writeHandAi();
    expect(await adfCommand(JSON_OPTS, ['init', '--force'])).toBe(0);
    const r = JSON.parse(out.join('\n'));
    expect(r.mode).toBe('merge');
    expect(r.created).toBe(false);
    expect(r.files).toEqual(expect.arrayContaining(['manifest.adf', 'core.adf', 'backend.adf', '.adf.lock']));
    expect(r.scaffolds.find((o: { file: string }) => o.file === '.ai/backend.adf').kind).toBe('created');
    expect(r.replaced).toEqual([]);
  });

  it('leaves a file the re-parse guard refuses as is, naming adf init --reset-adf --yes', async () => {
    writeHandAi();
    tamper = t => t.includes('Billing service for Acme') && t.includes('CONSTRAINTS');
    expect(await adfCommand(TEXT, ['init', '--force'])).toBe(0);
    expect(read('.ai/core.adf')).toBe(HAND_CORE);
    const warning = out.find(l => l.includes('.ai/core.adf could not be merged'));
    expect(warning).toContain("'charter adf init --reset-adf --yes'");
  });

  it('without a flag on an existing manifest is a no-op whose hint names --force and --reset-adf', async () => {
    writeHandAi();
    const before = tree();
    expect(await adfCommand(TEXT, ['init'])).toBe(0);
    expect(tree()).toEqual(before);
    expect(out.some(l => l.includes('--force to merge the preset template in'))).toBe(true);
    expect(out.some(l => l.includes('--reset-adf to replace the files with the template'))).toBe(true);
  });
});

// ============================================================================
// #370 — adf init --reset-adf replaces
// ============================================================================

describe('#370 adf init --reset-adf', () => {
  function writeHandAi(): void {
    write('.ai/manifest.adf', HAND_MANIFEST);
    write('.ai/core.adf', HAND_CORE);
    write('.ai/state.adf', HAND_STATE);
  }

  it('refuses without --yes in a non-interactive run: exit 1, nothing written', async () => {
    writeHandAi();
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const before = tree();
    expect(await adfCommand(TEXT, ['init', '--reset-adf'])).toBe(1);
    expect(tree()).toEqual(before);
    expect(errOut.join('\n')).toContain('Re-run with --reset-adf --yes to confirm');
    expect(errOut.join('\n')).toContain('.ai/core.adf');
  });

  it('refuses under --format json without --yes, with the reason in the payload', async () => {
    writeHandAi();
    const before = tree();
    expect(await adfCommand(JSON_OPTS, ['init', '--reset-adf'])).toBe(1);
    expect(tree()).toEqual(before);
    const r = JSON.parse(out.join('\n'));
    expect(r.resetAdf.kind).toBe('refused-non-interactive');
    expect(r.message).toContain('Nothing was written');
  });

  it('--yes replaces with the template after backing each file up, and prints the loss report', async () => {
    writeHandAi();
    expect(await adfCommand(YES, ['init', '--reset-adf', '--yes'])).toBe(0);
    expect(read('.ai/core.adf')).toBe(CORE_SCAFFOLD);
    expect(read('.ai/state.adf')).toBe(STATE_SCAFFOLD);
    expect(read('.ai/manifest.adf')).toBe(MANIFEST_SCAFFOLD);
    expect(read('.ai/frontend.adf')).toBe(FRONTEND_SCAFFOLD);
    const backups = fs.readdirSync('.ai/.backup');
    expect(read('.ai/.backup/.gitignore')).toBe('*\n');
    for (const [name, text] of [['core.adf', HAND_CORE], ['state.adf', HAND_STATE], ['manifest.adf', HAND_MANIFEST]]) {
      const b = backups.find(f => f.startsWith(`${name}.`));
      expect(b).toBeDefined();
      expect(read(`.ai/.backup/${b}`)).toBe(text);
      expect(out.some(l => l.startsWith(`  Replaced .ai/${name} (backup: .ai/.backup/${b})`))).toBe(true);
    }
    expect(out).toContain('    changed METRICS entry_loc: 120 / 150 [lines] -> 0 / 500 [lines]');
    expect(out).toContain('    lost CONTEXT item: Billing service for Acme');
    expect(out).toContain('    lost RULES item: CUSTOM RULE: load billing.adf for payments.');
  });

  it('--yes JSON lists replaced files, backups and the confirmation', async () => {
    writeHandAi();
    expect(await adfCommand({ ...JSON_OPTS, yes: true }, ['init', '--reset-adf', '--yes'])).toBe(0);
    const r = JSON.parse(out.join('\n'));
    expect(r.mode).toBe('reset');
    expect(r.resetAdf).toEqual({ kind: 'confirmed-by-yes' });
    expect(r.notReset).toEqual([]);
    expect(r.backupGitignore).toBe('created');
    const core = r.replaced.find((x: { file: string }) => x.file === '.ai/core.adf');
    expect(read(core.backup)).toBe(HAND_CORE);
    const coreOutcome = r.scaffolds.find((o: { file: string }) => o.file === '.ai/core.adf');
    expect(coreOutcome.kind).toBe('replaced');
    expect(coreOutcome.lost.itemsLost).toContainEqual({ section: 'CONTEXT', item: 'Billing service for Acme' });
  });

  it('a file whose backup fails is not replaced; exit 1 when none could be', async () => {
    writeHandAi();
    write('.ai/.backup', 'not a directory\n');
    expect(await adfCommand(YES, ['init', '--reset-adf', '--yes'])).toBe(1);
    expect(read('.ai/core.adf')).toBe(HAND_CORE);
    expect(read('.ai/manifest.adf')).toBe(HAND_MANIFEST);
    expect(out.some(l => l.includes('Could not back up .ai/core.adf to .ai/.backup/') && l.includes('not replaced'))).toBe(true);
  });

  it('confirms at an interactive prompt only when the answer is y', async () => {
    writeHandAi();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const before = tree();
    promptAnswer = 'n';
    expect(await adfCommand(TEXT, ['init', '--reset-adf'])).toBe(1);
    expect(tree()).toEqual(before);
    expect(errOut.join('\n')).toContain('Aborted; nothing was written');
    expect(out).toContain('  .ai/core.adf');
    promptAnswer = 'y';
    expect(await adfCommand(TEXT, ['init', '--reset-adf'])).toBe(0);
    expect(read('.ai/core.adf')).toBe(CORE_SCAFFOLD);
  });
});

// ============================================================================
// #370 — adf init on a fresh directory is unchanged
// ============================================================================

describe('#370 adf init on a fresh directory', () => {
  it('writes exactly the files and text it did before', async () => {
    expect(await adfCommand(TEXT, ['init'])).toBe(0);
    expect(tree()).toEqual(new Map([
      ['.ai/.adf.lock', '{}\n'],
      ['.ai/backend.adf', BACKEND_SCAFFOLD],
      ['.ai/core.adf', CORE_SCAFFOLD],
      ['.ai/frontend.adf', FRONTEND_SCAFFOLD],
      ['.ai/manifest.adf', MANIFEST_SCAFFOLD],
      ['.ai/state.adf', STATE_SCAFFOLD],
    ]));
    expect(out.join('\n') + '\n').toBe([
      '',
      '  ✓ Created .ai/ directory',
      '',
      '  Your AI governance is ready. Here\'s what was created:',
      '',
      '    .ai/manifest.adf    — Module router (controls what loads when)',
      '    .ai/core.adf        — Universal rules (always loaded)',
      '    .ai/state.adf       — Project state tracking',
      '    .ai/frontend.adf       — Domain-specific rules (on-demand)',
      '    .ai/backend.adf        — Domain-specific rules (on-demand)',
      '',
      '  Next steps:',
      '    1. Edit .ai/core.adf to add your project\'s constraints',
      '    2. Run \'charter doctor\' to validate your setup',
      '    3. Run \'charter adf bundle --task "<prompt>"\' to see the assembled context',
      '',
      '  Docs: https://github.com/Stackbilt-dev/charter',
      '',
    ].join('\n'));
  });

  it('keeps the rust-wasm JSON output (frontend + backend modules, empty lock)', async () => {
    expect(await adfCommand(JSON_OPTS, ['init', '--preset', 'rust-wasm'])).toBe(0);
    expect(out.join('\n') + '\n').toBe(JSON.stringify({
      created: true,
      aiDir: '.ai',
      files: ['manifest.adf', 'core.adf', 'state.adf', 'frontend.adf', 'backend.adf', '.adf.lock'],
      nextActions: [
        'charter adf populate  # auto-fill ADF files from codebase signals',
        'Edit core.adf to add project-specific constraints and rules',
        'charter adf fmt .ai/core.adf --check',
        'charter adf bundle --task "<prompt>"',
      ],
    }, null, 2) + '\n');
    expect(read('.ai/.adf.lock')).toBe('{}\n');
  });
});

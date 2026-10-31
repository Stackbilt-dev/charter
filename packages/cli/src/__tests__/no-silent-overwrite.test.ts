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

// Per-test write failure for chosen targets (a .backup/.gitignore that cannot be written).
let failWrite: ((target: string) => boolean) | null = null;
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const writeFileSync = ((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (failWrite && failWrite(String(target))) throw new Error('simulated write failure');
    return (actual.writeFileSync as (...a: unknown[]) => void)(target, ...rest);
  }) as typeof actual.writeFileSync;
  return { ...actual, writeFileSync, default: { ...actual, writeFileSync } };
});
const isBackupGitignore = (t: string): boolean => t.split(path.sep).join('/').endsWith('.backup/.gitignore');

// Makes the shared manifest writer report a warning (engine-warning tests).
let registerWarning: string | null = null;
vi.mock('../commands/adf-manifest-register', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commands/adf-manifest-register')>();
  return {
    ...actual,
    registerManifestModules: (...a: Parameters<typeof actual.registerManifestModules>) => {
      if (registerWarning) a[2]?.onWarning?.(registerWarning);
      return actual.registerManifestModules(...a);
    },
  };
});

// Interactive prompt: answer injected per test; the real readline never runs.
let promptAnswer = 'n';
vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:readline')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    // promptYesNo uses question(); init --guided reads 'line' events after prompt().
    createInterface: () => {
      const rl = Object.assign(new EventEmitter(), {
        terminal: true,
        question: (_q: string, cb: (a: string) => void) => { cb(promptAnswer); },
        setPrompt: () => undefined,
        prompt: () => { queueMicrotask(() => rl.emit('line', promptAnswer)); },
        close: () => undefined,
      });
      return rl;
    },
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
  failWrite = null;
  registerWarning = null;
  promptAnswer = 'n';
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
/** A path as bootstrap phase 2 prints it: platform separators. */
const P = (rel: string): string => path.normalize(rel);

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
      expect(out.some(l => l.startsWith(`  Created ${P('.charter/')}`))).toBe(false);
      const kept = out.find(l => l.startsWith('  Kept existing '));
      expect(kept).toContain(P('.charter/config.json'));
      expect(kept).toContain("'charter init --force' replaces them");
    });
  }

  it('creates a missing blessed-stack.json even though config.json exists', async () => {
    writeHandCharter();
    fs.rmSync('.charter/patterns/blessed-stack.json');
    expect(await bootstrapCommand(YES, ['--yes', ...BOOT])).toBe(0);
    expect(JSON.parse(read('.charter/patterns/blessed-stack.json')).patterns.length).toBeGreaterThan(0);
    expect(read('.charter/config.json')).toBe(HAND['.charter/config.json']);
    // Phase 2 keeps the platform separator it printed before #369 (path.join).
    expect(out).toContain(`  Created ${P('.charter/patterns/blessed-stack.json')}`);
    expect(out.some(l => l.includes(`Created ${P('.charter/config.json')}`))).toBe(false);
  });

  it('reports created and kept files in the JSON setup step', async () => {
    writeHandCharter();
    fs.rmSync('.charter/policies/governance.md');
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--yes', ...BOOT])).toBe(0);
    const setup = JSON.parse(out.join('\n')).steps.find((s: { name: string }) => s.name === 'setup');
    expect(setup.details.created).toContain(P('.charter/policies/governance.md'));
    expect(setup.details.created).not.toContain(P('.charter/config.json'));
    expect(setup.details.kept).toEqual(expect.arrayContaining([P('.charter/config.json'), P('.charter/.gitignore')]));
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
    expect(parsed.mcpServers.charter).toEqual({ command: 'npm', args: ['exec', '--no', '--package=@stackbilt/cli', '--', 'charter', 'serve', '--ai-dir', '.ai'] });
    expect(parsed.mcpServers.github).toEqual({ command: 'npx', args: ['@modelcontextprotocol/server-github'] });
    expect(parsed.other).toEqual({ keep: true });
    const backups = fs.readdirSync('.charter/.backup').filter(f => f.startsWith('mcp.json.'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^mcp\.json\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    expect(read(`.charter/.backup/${backups[0]}`)).toBe(MCP);
    expect(read('.charter/.backup/.gitignore')).toBe('*\n');
    expect(out).toContain(`  Updated .mcp.json (backup: .charter/.backup/${backups[0]})`);
  });

  it('--force does not replace it when the backup fails, warns, and exits 1 (#374)', async () => {
    write('.mcp.json', MCP);
    write('.charter/.backup', 'a file where the backup directory should be\n');
    expect(await bootstrapCommand(TEXT, ['--force', ...BOOT])).toBe(1);
    expect(out).toContain('  Not replaced .mcp.json (backup failed; see warning)');
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

// ============================================================================
// PR #373 review follow-ups
// ============================================================================

const FRESH_TEXT = [
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
].join('\n');

const FRESH_JSON = JSON.stringify({
  created: true,
  aiDir: '.ai',
  files: ['manifest.adf', 'core.adf', 'state.adf', 'frontend.adf', 'backend.adf', '.adf.lock'],
  nextActions: [
    'charter adf populate  # auto-fill ADF files from codebase signals',
    'Edit core.adf to add project-specific constraints and rules',
    'charter adf fmt .ai/core.adf --check',
    'charter adf bundle --task "<prompt>"',
  ],
}, null, 2) + '\n';

describe('adf init --force / --reset-adf --yes on an empty directory', () => {
  for (const [label, opts, args] of [
    ['--force', TEXT, ['init', '--force']],
    ['--reset-adf --yes', YES, ['init', '--reset-adf', '--yes']],
  ] as Array<[string, CLIOptions, string[]]>) {
    it(`${label}: the same text and files as plain adf init`, async () => {
      expect(await adfCommand(opts, args)).toBe(0);
      expect(out.join('\n') + '\n').toBe(FRESH_TEXT);
      expect([...tree().keys()].sort()).toEqual(['.ai/.adf.lock', '.ai/backend.adf', '.ai/core.adf', '.ai/frontend.adf', '.ai/manifest.adf', '.ai/state.adf']);
    });

    it(`${label}: the same JSON as plain adf init, nextActions included`, async () => {
      expect(await adfCommand({ ...opts, format: 'json' }, args)).toBe(0);
      expect(out.join('\n') + '\n').toBe(FRESH_JSON);
    });
  }
});

describe('adf init --emit-pointers with --force / --reset-adf', () => {
  it('prints the pointer lines after the merge header', async () => {
    write('.ai/manifest.adf', HAND_MANIFEST);
    expect(await adfCommand(TEXT, ['init', '--force', '--emit-pointers'])).toBe(0);
    const header = out.findIndex(l => l.startsWith('  Merged the preset template into .ai/'));
    const pointer = out.findIndex(l => l.startsWith('  Generated CLAUDE.md'));
    expect(header).toBeGreaterThanOrEqual(0);
    expect(pointer).toBeGreaterThan(header);
  });

  it('prints the pointer lines after the reset header', async () => {
    write('.ai/manifest.adf', HAND_MANIFEST);
    write('AGENTS.md', '# mine\n');
    expect(await adfCommand(YES, ['init', '--reset-adf', '--yes', '--emit-pointers'])).toBe(0);
    const header = out.findIndex(l => l.startsWith('  Reset .ai/ to the preset template'));
    expect(header).toBeGreaterThanOrEqual(0);
    expect(out.findIndex(l => l.startsWith('  Generated CLAUDE.md'))).toBeGreaterThan(header);
    expect(out.findIndex(l => l === '  Skipped AGENTS.md (already exists)')).toBeGreaterThan(header);
  });
});

describe('setup --force and init --guided honour failed backups', () => {
  it('setup --force exits 1 when every backup failed, and names the files in text', async () => {
    writeHandCharter();
    write('.charter/.backup', 'not a directory\n');
    expect(await setupCommand(TEXT, ['--preset', 'worker', '--no-dependency-sync', '--force'])).toBe(1);
    for (const [f, t] of Object.entries(HAND)) expect(read(f)).toBe(t);
    expect(out.some(l => l.includes('Could not back up .charter/config.json to .charter/.backup/'))).toBe(true);
  });

  it('setup --force JSON also exits 1 when every backup failed', async () => {
    writeHandCharter();
    write('.charter/.backup', 'not a directory\n');
    expect(await setupCommand(JSON_OPTS, ['--preset', 'worker', '--no-dependency-sync', '--force'])).toBe(1);
    expect(JSON.parse(out.join('\n')).notReplaced.length).toBeGreaterThan(0);
  });

  it('setup without --force names created and kept files like init', async () => {
    writeHandCharter();
    fs.rmSync('.charter/policies/governance.md');
    expect(await setupCommand(TEXT, ['--preset', 'worker', '--no-dependency-sync'])).toBe(0);
    expect(out).toContain('  Created .charter/policies/governance.md');
    expect(out.some(l => l.startsWith('  Kept existing ') && l.includes('.charter/config.json'))).toBe(true);
  });

  it('init --guided --force warns and exits 1 when nothing could be replaced', async () => {
    writeHandCharter();
    write('.charter/.backup', 'not a directory\n');
    expect(await initCommand(TEXT, ['--guided', '--force'])).toBe(1);
    for (const [f, t] of Object.entries(HAND)) expect(read(f)).toBe(t);
    expect(out.some(l => l.startsWith('  Warning: Could not back up .charter/config.json'))).toBe(true);
  });

  it('init --guided --force JSON is refused up front (#375): exit 1, one JSON document, nothing written', async () => {
    writeHandCharter();
    const before = tree();
    expect(await initCommand(JSON_OPTS, ['--guided', '--force'])).toBe(1);
    const r = JSON.parse(out.join('\n'));
    expect(r.guided).toBe(true);
    expect(r.errorCode).toBe('GUIDED_REQUIRES_TEXT');
    expect(tree()).toEqual(before);
  });

  it('init --guided --force replaces with backups and exits 0 when backups work', async () => {
    writeHandCharter();
    expect(await initCommand(TEXT, ['--guided', '--force'])).toBe(0);
    expect(out.some(l => l.startsWith('  Replaced .charter/config.json (backup: .charter/.backup/config.json.'))).toBe(true);
  });
});

describe('a .backup/.gitignore that cannot be written is a warning', () => {
  it('bootstrap --force still replaces mcpServers.charter, and setup passes with a warning', async () => {
    write('.mcp.json', JSON.stringify({ mcpServers: { charter: { command: 'charter' } } }, null, 2) + '\n');
    failWrite = t => isBackupGitignore(t) && t.includes('.charter');
    expect(await bootstrapCommand({ ...JSON_OPTS }, ['--force', ...BOOT])).toBe(0);
    const setup = JSON.parse(out.join('\n')).steps.find((s: { name: string }) => s.name === 'setup');
    expect(setup.status).toBe('pass');
    expect(setup.details.mcpBackup).toMatch(/^\.charter\/\.backup\/mcp\.json\./);
    expect(setup.warnings.some((w: string) => w.includes('Could not write .charter/.backup/.gitignore'))).toBe(true);
    expect(JSON.parse(read('.mcp.json')).mcpServers.charter.command).toBe('npm');
  });

  it('init --force still replaces, and warns', async () => {
    writeHandCharter();
    failWrite = isBackupGitignore;
    expect(await initCommand(TEXT, ['--force'])).toBe(0);
    expect(read('.charter/config.json')).not.toBe(HAND['.charter/config.json']);
    expect(out.some(l => l.startsWith('  Warning: Could not write .charter/.backup/.gitignore'))).toBe(true);
  });

  it('adf init --reset-adf --yes still replaces, and warns', async () => {
    write('.ai/manifest.adf', HAND_MANIFEST);
    write('.ai/core.adf', HAND_CORE);
    failWrite = isBackupGitignore;
    expect(await adfCommand({ ...JSON_OPTS, yes: true }, ['init', '--reset-adf', '--yes'])).toBe(0);
    const r = JSON.parse(out.join('\n'));
    expect(r.backupGitignore).toBe('failed');
    expect(r.warnings.some((w: string) => w.includes('Could not write .ai/.backup/.gitignore'))).toBe(true);
    expect(read('.ai/core.adf')).toBe(CORE_SCAFFOLD);
  });
});

describe('init JSON keeps files and writesPerformed meaning what they did', () => {
  it('existing .charter/ without --force: files is [], new information only in new fields', async () => {
    writeHandCharter();
    fs.rmSync('.charter/.gitignore');
    expect(await initCommand(JSON_OPTS, [])).toBe(0);
    const r = JSON.parse(out.join('\n'));
    expect(r.created).toBe(false);
    expect(r.files).toEqual([]);
    expect(r.writesPerformed).toBe(1);
    expect(r.createdFiles).toEqual(['.charter/.gitignore']);
  });

  it('existing .charter/ with nothing missing: files [] and writesPerformed 0, as before', async () => {
    writeHandCharter();
    expect(await initCommand(JSON_OPTS, [])).toBe(0);
    const r = JSON.parse(out.join('\n'));
    expect(r.files).toEqual([]);
    expect(r.writesPerformed).toBe(0);
  });
});

// ============================================================================
// PR #373 round 3
// ============================================================================

const keptOf = (): string[] => JSON.parse(out.join('\n')).kept;

describe('blessed-stack.json: generatedAt does not count as an edit', () => {
  it('an untouched .charter/ reports kept: [] on an init re-run', async () => {
    expect(await initCommand(TEXT, [])).toBe(0);
    out = [];
    expect(await initCommand(JSON_OPTS, [])).toBe(0);
    expect(keptOf()).toEqual([]);
  });

  it('an untouched .charter/ reports nothing kept on a bootstrap re-run', async () => {
    expect(await bootstrapCommand(YES, ['--yes', ...BOOT])).toBe(0);
    out = [];
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--yes', ...BOOT])).toBe(0);
    const setup = JSON.parse(out.join('\n')).steps.find((s: { name: string }) => s.name === 'setup');
    expect(setup.details.kept).toEqual([]);
    out = [];
    expect(await bootstrapCommand(YES, ['--yes', ...BOOT])).toBe(0);
    expect(out.some(l => l.startsWith('  Kept existing '))).toBe(false);
  });

  it('an untouched .charter/ reports nothing kept on a setup re-run', async () => {
    expect(await setupCommand(TEXT, ['--preset', 'worker', '--no-dependency-sync'])).toBe(0);
    out = [];
    expect(await setupCommand(TEXT, ['--preset', 'worker', '--no-dependency-sync'])).toBe(0);
    expect(out.some(l => l.startsWith('  Kept existing '))).toBe(false);
  });

  it('init --force and setup --force on an untouched .charter/ replace nothing and write no backup', async () => {
    expect(await initCommand(TEXT, [])).toBe(0);
    const before = read('.charter/patterns/blessed-stack.json');
    out = [];
    expect(await initCommand(JSON_OPTS, ['--force'])).toBe(0);
    expect(JSON.parse(out.join('\n')).replaced).toEqual([]);
    expect(fs.existsSync('.charter/.backup')).toBe(false);
    expect(read('.charter/patterns/blessed-stack.json')).toBe(before);

    // setup writes its own template (inferred project name), so compare it with itself.
    fs.rmSync('.charter', { recursive: true, force: true });
    expect(await setupCommand(TEXT, ['--preset', 'worker', '--no-dependency-sync'])).toBe(0);
    const setupBefore = tree('.charter');
    out = [];
    expect(await setupCommand(JSON_OPTS, ['--preset', 'worker', '--no-dependency-sync', '--force'])).toBe(0);
    expect(JSON.parse(out.join('\n')).replaced).toBeUndefined();
    expect(fs.existsSync('.charter/.backup')).toBe(false);
    expect(tree('.charter')).toEqual(setupBefore);
  });

  it('a real edit is still detected: kept without --force, backed up and replaced with it', async () => {
    expect(await initCommand(TEXT, [])).toBe(0);
    const edited = JSON.parse(read('.charter/patterns/blessed-stack.json'));
    edited.patterns[0].blessed_solution = 'Our own choice';
    write('.charter/patterns/blessed-stack.json', JSON.stringify(edited, null, 2) + '\n');
    out = [];
    expect(await initCommand(JSON_OPTS, [])).toBe(0);
    expect(keptOf()).toEqual(['.charter/patterns/blessed-stack.json']);
    out = [];
    expect(await initCommand(JSON_OPTS, ['--force'])).toBe(0);
    const r = JSON.parse(out.join('\n'));
    expect(r.replaced.map((x: { file: string }) => x.file)).toEqual(['.charter/patterns/blessed-stack.json']);
    expect(read(r.replaced[0].backup)).toContain('Our own choice');
  });

  it('a blessed-stack.json that does not parse counts as differing', async () => {
    expect(await initCommand(TEXT, [])).toBe(0);
    write('.charter/patterns/blessed-stack.json', '{ not json\n');
    out = [];
    expect(await initCommand(JSON_OPTS, [])).toBe(0);
    expect(keptOf()).toEqual(['.charter/patterns/blessed-stack.json']);
  });
});

describe('warnings always reach the output', () => {
  it('setup --force --format json includes a .charter/.backup/.gitignore warning', async () => {
    writeHandCharter();
    failWrite = isBackupGitignore;
    expect(await setupCommand(JSON_OPTS, ['--preset', 'worker', '--no-dependency-sync', '--force'])).toBe(0);
    const r = JSON.parse(out.join('\n'));
    expect(r.warnings.some((w: string) => w.includes('Could not write .charter/.backup/.gitignore'))).toBe(true);
  });

  it('init --force text prints a gitignore warning even when nothing was created or replaced', async () => {
    expect(await initCommand(TEXT, [])).toBe(0);
    fs.mkdirSync('.charter/.backup');
    failWrite = isBackupGitignore;
    out = [];
    expect(await initCommand(TEXT, ['--force'])).toBe(0);
    expect(out.some(l => l.startsWith('  Warning: Could not write .charter/.backup/.gitignore'))).toBe(true);
    expect(out.some(l => l.includes('.charter/ directory already exists'))).toBe(true);
  });

  it('a fresh adf init --force prints engine warnings (stdout text, stderr under JSON)', async () => {
    registerWarning = 'simulated registration warning';
    expect(await adfCommand(TEXT, ['init', '--force'])).toBe(0);
    expect(out).toContain('  Warning: simulated registration warning');
    expect(out.some(l => l.includes('Created .ai/ directory'))).toBe(true);
    fs.rmSync('.ai', { recursive: true, force: true });
    out = [];
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
    expect(await adfCommand(JSON_OPTS, ['init', '--force'])).toBe(0);
    expect(out.join('\n') + '\n').toBe(FRESH_JSON);
    expect(warned).toContain('Warning: simulated registration warning');
  });

  it('bootstrap phase 3: a .ai/.backup/.gitignore that cannot be written is a warning, not a failed step', async () => {
    write('.ai/core.adf', HAND_CORE);
    failWrite = t => isBackupGitignore(t) && t.split(path.sep).join('/').includes('.ai/');
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--reset-adf', '--yes', ...BOOT])).toBe(0);
    const step = JSON.parse(out.join('\n')).steps.find((s: { name: string }) => s.name === 'adf-init');
    expect(step.status).toBe('pass');
    expect(step.details.backupGitignore).toBe('failed');
    expect(step.warnings.some((w: string) => w.includes('Could not write .ai/.backup/.gitignore'))).toBe(true);
    expect(read('.ai/core.adf')).toBe(CORE_SCAFFOLD);
  });
});

describe('--reset-adf with nothing to replace needs no confirmation', () => {
  it('adf init --reset-adf without --yes on an empty dir creates the files, as plain adf init', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    expect(await adfCommand(TEXT, ['init', '--reset-adf'])).toBe(0);
    expect(out.join('\n') + '\n').toBe(FRESH_TEXT);
    expect(errOut).toEqual([]);
  });

  it('adf init --reset-adf --format json without --yes on an empty dir: plain adf init JSON', async () => {
    expect(await adfCommand(JSON_OPTS, ['init', '--reset-adf'])).toBe(0);
    expect(out.join('\n') + '\n').toBe(FRESH_JSON);
  });

  it('bootstrap --reset-adf without --yes on an empty dir proceeds (resetAdf: nothing-to-replace)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    expect(await bootstrapCommand(JSON_OPTS, ['--reset-adf', ...BOOT])).toBe(0);
    const r = JSON.parse(out.join('\n'));
    expect(r.resetAdf).toEqual({ kind: 'nothing-to-replace' });
    expect(read('.ai/core.adf')).toBe(CORE_SCAFFOLD);
    expect(fs.existsSync('.ai/.backup')).toBe(false);
  });

  it('a .ai/ whose files are all the template also needs no confirmation', async () => {
    expect(await adfCommand(TEXT, ['init'])).toBe(0);
    const before = tree();
    out = [];
    expect(await adfCommand(TEXT, ['init', '--reset-adf'])).toBe(0);
    expect(tree()).toEqual(before);
  });
});

describe('the success banner prints only on success', () => {
  it('init --force with config.json absent: no "Created .charter/ directory" when every backup failed', async () => {
    writeHandCharter();
    fs.rmSync('.charter/config.json');
    write('.charter/.backup', 'not a directory\n');
    expect(await initCommand(TEXT, ['--force'])).toBe(1);
    expect(out.some(l => l.includes('Created .charter/ directory'))).toBe(false);
    expect(out.some(l => l.startsWith('  Warning: Could not back up'))).toBe(true);
  });

  it('init --guided --force with config.json absent: no banner when every backup failed', async () => {
    writeHandCharter();
    fs.rmSync('.charter/config.json');
    write('.charter/.backup', 'not a directory\n');
    expect(await initCommand(TEXT, ['--guided', '--force'])).toBe(1);
    expect(out.some(l => l.includes('Created .charter/ directory'))).toBe(false);
  });

  it('init with config.json absent still prints the banner on success', async () => {
    expect(await initCommand(TEXT, [])).toBe(0);
    expect(out).toContain('  ✓ Created .charter/ directory');
  });
});

describe('bootstrap phase 2 paths use the platform separator, as before #369', () => {
  it('text and JSON', async () => {
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--yes', ...BOOT])).toBe(0);
    const setup = JSON.parse(out.join('\n')).steps.find((s: { name: string }) => s.name === 'setup');
    expect(setup.details.created).toEqual(expect.arrayContaining([
      path.join('.charter', 'config.json'),
      path.join('.charter', 'patterns', 'blessed-stack.json'),
      path.join('.charter', 'policies', 'governance.md'),
      path.join('.charter', '.gitignore'),
    ]));
    fs.rmSync('.charter/policies/governance.md');
    out = [];
    expect(await bootstrapCommand(YES, ['--yes', ...BOOT])).toBe(0);
    expect(out).toContain(`  Created ${path.join('.charter', 'policies', 'governance.md')}`);
  });
});

describe('dirLabel', () => {
  it('normalizes separators and strips trailing slashes without a regex', async () => {
    const { dirLabel } = await import('../commands/adf-scaffold-merge');
    expect(dirLabel('.ai')).toBe('.ai/');
    expect(dirLabel('.ai/')).toBe('.ai/');
    expect(dirLabel('.ai///')).toBe('.ai/');
    expect(dirLabel(['a', 'b'].join(path.sep) + path.sep)).toBe('a/b/');
    expect(dirLabel('./.charter')).toBe('./.charter/');
    expect(dirLabel('')).toBe('');
    expect(dirLabel('/')).toBe('/');
    const started = Date.now();
    expect(dirLabel('x' + '/'.repeat(50_000))).toBe('x/');
    expect(dirLabel('/'.repeat(50_000) + 'x' + '/'.repeat(50_000))).toBe('/'.repeat(50_000) + 'x/');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// ============================================================================
// PR #373 round 4
// ============================================================================

describe('a run that exits 1 still names the files it created', () => {
  it('init --force with config.json absent lists the created config.json', async () => {
    writeHandCharter();
    fs.rmSync('.charter/config.json');
    write('.charter/.backup', 'not a directory\n');
    expect(await initCommand(TEXT, ['--force'])).toBe(1);
    expect(fs.existsSync('.charter/config.json')).toBe(true);
    expect(out).toContain('  Created .charter/config.json');
    expect(out.some(l => l.includes('Created .charter/ directory'))).toBe(false);
  });

  it('init --guided --force with config.json absent lists the created config.json', async () => {
    writeHandCharter();
    fs.rmSync('.charter/config.json');
    write('.charter/.backup', 'not a directory\n');
    expect(await initCommand(TEXT, ['--guided', '--force'])).toBe(1);
    expect(out).toContain('  Created .charter/config.json');
    expect(out.some(l => l.includes('Created .charter/ directory'))).toBe(false);
  });
});

describe('--reset-adf: whitespace-only differences and an absent .ai/', () => {
  it('a scaffold that differs from the template only in surrounding whitespace counts as nothing to replace', async () => {
    expect(await adfCommand(TEXT, ['init'])).toBe(0);
    write('.ai/core.adf', `\n${CORE_SCAFFOLD}\n\n`);
    write('.ai/state.adf', `${STATE_SCAFFOLD}   \n`);
    const before = tree();
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    out = [];
    expect(await adfCommand(TEXT, ['init', '--reset-adf'])).toBe(0);
    expect(tree()).toEqual(before);
    expect(errOut).toEqual([]);
    expect(fs.existsSync('.ai/.backup')).toBe(false);
  });

  it('bootstrap --reset-adf without --yes and no .ai/ leaves a hand-edited .charter/ unchanged', async () => {
    writeHandCharter();
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    expect(await bootstrapCommand(TEXT, ['--reset-adf', ...BOOT])).toBe(0);
    for (const [f, t] of Object.entries(HAND)) expect(read(f)).toBe(t);
    expect(fs.existsSync('.charter/.backup')).toBe(false);
    expect(read('.ai/core.adf')).toBe(CORE_SCAFFOLD);
  });
});

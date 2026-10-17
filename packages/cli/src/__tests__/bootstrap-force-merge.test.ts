/**
 * `bootstrap --force` merges .ai/ instead of replacing it; `--reset-adf`
 * replaces with backup + loss report (#354, closes #347).
 *
 * One test (at least) per contract invariant INV-1..INV-12. Each fails if the
 * invariant breaks.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import {
  BACKEND_SCAFFOLD,
  CORE_SCAFFOLD,
  FRONTEND_SCAFFOLD,
  MANIFEST_BACKEND_SCAFFOLD,
  MANIFEST_SCAFFOLD,
  STATE_SCAFFOLD,
} from '../commands/adf';
import {
  appendMissingSections,
  backupFile,
  computeLoss,
  ensureBackupGitignore,
  formatLossLines,
  LOSS_TEXT_MAX_LINES_PER_FILE,
  MANIFEST_EXCLUDED_KEYS,
} from '../commands/adf-scaffold-merge';
import type { ScaffoldOutcome } from '../commands/adf-scaffold-merge';

// A switch that makes the re-parse guard see a different document (guard tests).
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

vi.mock('../git-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-helpers')>();
  return { ...actual, isGitRepo: () => true };
});

// Interactive prompt: answer injected per test; the real readline never runs.
let promptAnswer = 'n';
let promptCalls = 0;
vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:readline')>();
  return {
    ...actual,
    createInterface: () => ({
      question: (_q: string, cb: (a: string) => void) => { promptCalls++; cb(promptAnswer); },
      close: () => undefined,
    }),
  };
});

import { bootstrapCommand } from '../commands/bootstrap';
import { adfPopulateCommand } from '../commands/adf-populate';
import { doctorCommand } from '../commands/doctor';
import { parseAdf } from '@stackbilt/adf';

const TEXT: CLIOptions = { configPath: '.charter', format: 'text', ciMode: false, yes: false };
const JSON_OPTS: CLIOptions = { ...TEXT, format: 'json' };
const YES: CLIOptions = { ...TEXT, yes: true };
const BASE_ARGS = ['--preset', 'worker', '--skip-install', '--skip-doctor'];

// The blueprint's reproduction: hand-edited triggers, RULES, METRICS, a constraint,
// a tightened entry_loc ceiling, and a migrated billing.adf.
const HAND_MANIFEST = MANIFEST_BACKEND_SCAFFOLD
  .replace('backend.adf (Triggers on: API, Node, DB)', 'billing.adf (Triggers on: payments, stripe, invoice)\n  - backend.adf (Triggers on: API, Node, DB, worker, wrangler)')
  .replace('  - Never assume unseen modules were loaded.\n', '  - Never assume unseen modules were loaded.\n  - CUSTOM RULE: always load billing.adf for payments.\n')
  + '\n\u{1F4CA} METRICS:\n  ENTRY_LOC: src/index.ts\n';

// Bootstrap records each pointer it writes in VENDORS (#318). Fixtures carry the
// record already, so a byte comparison sees only what phase 3's merge does.
const VENDORS_BLOCK = ['CLAUDE.md', '.cursorrules', 'AGENTS.md', 'GEMINI.md', 'copilot-instructions.md'].map(f => `  - ${f}: pointer`).join('\n');
const v = (manifest: string): string => `${manifest.replace(/\n*$/, '')}\n\n\u{1F3F7} VENDORS:\n${VENDORS_BLOCK}\n`;
const HAND_CORE = CORE_SCAFFOLD
  .replace("  - Project context (run 'charter adf populate' to auto-fill from codebase)", '  - Billing service for Acme')
  .replace('  - Never commit secrets or credentials\n', '  - Never commit secrets or credentials\n  - CUSTOM: all money math uses integer cents\n')
  .replace('entry_loc: 0 / 500 [lines]', 'entry_loc: 120 / 150 [lines]');
const HAND_STATE = 'ADF: 0.1\n\u{1F9E0} STATE:\n  CURRENT: Shipping invoices v2\n  NEXT: Refunds\n';
const HAND_BACKEND = 'ADF: 0.1\n\u{1F4CB} CONTEXT:\n  - Hono on Workers\n';
const BILLING = 'ADF: 0.1\n\n\u{1F4CB} CONTEXT:\n  - Billing via Stripe; webhooks verified\n';

let out: string[] = [];
let errOut: string[] = [];
let tempDir = '';
const originalCwd = process.cwd();

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'charter-354-')));
  process.chdir(tempDir);
  out = [];
  errOut = [];
  tamper = null;
  promptAnswer = 'n';
  promptCalls = 0;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errOut.push(a.map(String).join(' ')); });
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  setTty(undefined);
});

function setTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(rel), { recursive: true });
  fs.writeFileSync(rel, text);
}

const read = (rel: string): string => fs.readFileSync(rel, 'utf-8');

function handEdited(): void {
  write('.ai/manifest.adf', v(HAND_MANIFEST));
  write('.ai/core.adf', HAND_CORE);
  write('.ai/state.adf', HAND_STATE);
  write('.ai/backend.adf', HAND_BACKEND);
  write('.ai/billing.adf', BILLING);
}

/** Every file under `dir` (relative path → bytes), recursively. */
function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!fs.existsSync(dir)) return files;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.set(path.relative(tempDir, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf-8'));
    }
  };
  walk(dir);
  return files;
}

function snapshotRepo(): Map<string, string> {
  const all = snapshot(tempDir);
  return all;
}

async function runJson(opts: CLIOptions, args: string[]): Promise<{ code: number; payload: Record<string, any> }> {
  out = [];
  const code = await bootstrapCommand({ ...opts, format: 'json' }, [...args, '--format', 'json']);
  return { code, payload: JSON.parse(out.join('\n')) };
}

function adfInit(payload: Record<string, any>): Record<string, any> {
  return payload.steps.find((s: { name: string }) => s.name === 'adf-init');
}

// ============================================================================
// appendMissingSections (unit)
// ============================================================================

describe('appendMissingSections', () => {
  const TEMPLATE = 'ADF: 0.1\n\u{1F3AF} ROLE: Router\n\n\u{1F4D0} RULES:\n  - a\n  - b\n\n\u{1F4CA} METRICS:\n  entry_loc: 0 / 500 [lines]\n';

  it('appends only missing sections, in template order, after the untouched original bytes', () => {
    const text = 'ADF: 0.1\n# a comment line\nROLE:   Custom   router\n';
    const r = appendMissingSections(text, TEMPLATE, []);
    expect(r.status).toBe('appended');
    if (r.status !== 'appended') return;
    expect(r.added).toEqual(['RULES', 'METRICS']);
    expect(r.next.startsWith(text)).toBe(true);
    expect(r.next.slice(text.length)).toBe('\n\u{1F4D0} RULES:\n  - a\n  - b\n\n\u{1F4CA} METRICS:\n  entry_loc: 0 / 500 [lines]\n');
  });

  it('keeps CRLF line endings', () => {
    const text = 'ADF: 0.1\r\nROLE: Custom\r\n';
    const r = appendMissingSections(text, TEMPLATE, []);
    if (r.status !== 'appended') throw new Error(r.status);
    expect(r.next.startsWith(text)).toBe(true);
    expect(r.next.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(r.next.endsWith('\r\n')).toBe(true);
  });

  it('keeps a missing trailing newline missing', () => {
    const text = 'ADF: 0.1\r\nROLE: Custom';
    const r = appendMissingSections(text, TEMPLATE, []);
    if (r.status !== 'appended') throw new Error(r.status);
    expect(r.next.startsWith(`${text}\r\n\r\n`)).toBe(true);
    expect(r.next.endsWith('[lines]')).toBe(true);
  });

  it('never inserts into a section the file has, even a decorated or weighted one (Q3)', () => {
    const text = 'ADF: 0.1\n\u{1F4D0} RULES [advisory]:\n  - only mine\n';
    const r = appendMissingSections(text, TEMPLATE, ['ROLE']);
    if (r.status !== 'appended') throw new Error(r.status);
    expect(r.added).toEqual(['METRICS']);
    expect(parseAdf(r.next).sections.find(s => s.key === 'RULES')?.content).toEqual({ type: 'list', items: ['only mine'] });
  });

  it("reports 'none' when every template section is present, and honours excludeKeys", () => {
    expect(appendMissingSections('ADF: 0.1\nROLE: x\nRULES:\n  - y\n', TEMPLATE, ['METRICS'])).toEqual({ status: 'none' });
  });

  it('refuses an unsupported ADF version as unparseable', () => {
    expect(appendMissingSections('ADF: 0.2\nROLE: x\n', TEMPLATE, [])).toEqual({ status: 'refused', reason: 'unparseable' });
  });

  it('refuses when the re-parse does not equal old + appended (guard)', () => {
    tamper = t => t.includes('MARK') && t.includes('RULES');
    expect(appendMissingSections('ADF: 0.1\nROLE: MARK\n', TEMPLATE, [])).toEqual({ status: 'refused', reason: 'guard' });
  });

  it('manifest exclusions keep module lists and VENDORS out of section appends', () => {
    expect(MANIFEST_EXCLUDED_KEYS).toEqual(['DEFAULT_LOAD', 'ON_DEMAND', 'VENDORS']);
    const r = appendMissingSections('ADF: 0.1\nROLE: x\n', MANIFEST_SCAFFOLD, MANIFEST_EXCLUDED_KEYS);
    if (r.status !== 'appended') throw new Error(r.status);
    expect(r.added).toEqual(['RULES']);
  });
});

// ============================================================================
// INV-1, INV-2, INV-3: --force merges, append-only
// ============================================================================

describe('bootstrap --force merges .ai/ (INV-1..3)', () => {
  it('INV-1/2: the hand-edited reproduction survives --force --yes byte for byte', async () => {
    handEdited();
    const before = snapshot('.ai');
    const { code, payload } = await runJson(YES, ['--force', '--yes', ...BASE_ARGS]);
    expect(code).toBe(0);
    for (const file of ['manifest.adf', 'core.adf', 'state.adf', 'backend.adf', 'billing.adf']) {
      expect(read(`.ai/${file}`), file).toBe(before.get(`.ai/${file}`));
    }
    expect(fs.existsSync('.ai/.backup')).toBe(false);
    const init = adfInit(payload);
    expect(init.details.mode).toBe('merge');
    expect(init.details.replaced).toEqual([]);
    expect(init.details.backupGitignore).toBe('not-needed');
    expect((init.details.scaffolds as ScaffoldOutcome[]).map(o => o.kind)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged']);
  });

  it('INV-1/3: missing sections and template modules are appended; every original byte stays, in place', async () => {
    const manifest = `ADF: 0.1\r\n\u{1F4E6} DEFAULT_LOAD:\r\n  - core.adf\r\n  - state.adf\r\n\r\n\u{1F4C2} ON_DEMAND:\r\n  - billing.adf (Triggers on: payments)\r\n\r\n\u{1F3F7} VENDORS:\r\n${VENDORS_BLOCK.replace(/\n/g, '\r\n')}\r\n\r\n\u{1F4CA} METRICS:\r\n  ENTRY_LOC: src/index.ts`;
    write('.ai/manifest.adf', manifest);
    const core = HAND_CORE.replace(/\u{1F4D6} GUIDE[\s\S]*?\n\n/u, '');
    write('.ai/core.adf', core);
    write('.ai/state.adf', HAND_STATE);
    write('.ai/backend.adf', HAND_BACKEND);
    write('.ai/billing.adf', BILLING);

    const { payload } = await runJson(YES, ['--force', '--yes', ...BASE_ARGS]);
    const scaffolds = adfInit(payload).details.scaffolds as ScaffoldOutcome[];

    const m = read('.ai/manifest.adf');
    // Only insertions: removing the added lines gives back the original bytes.
    const added = ['  - backend.adf (Triggers on: API, Node, DB)\r\n'];
    expect(m.replace(added[0], '').startsWith(manifest)).toBe(true);
    expect(m.includes('billing.adf (Triggers on: payments)')).toBe(true);
    expect(m.endsWith('Never assume unseen modules were loaded.')).toBe(true); // no trailing newline kept
    expect(m.replace(/\r\n/g, '').includes('\n')).toBe(false); // CRLF kept
    expect(m.indexOf('ROLE')).toBeGreaterThan(m.indexOf('ENTRY_LOC'));

    const c = read('.ai/core.adf');
    expect(c.startsWith(core)).toBe(true);
    expect(c).toContain('GUIDE [advisory]');
    expect(c).toContain('entry_loc: 120 / 150 [lines]');

    expect(scaffolds[0]).toEqual({
      kind: 'merged',
      file: '.ai/manifest.adf',
      addedSections: ['ROLE', 'RULES'],
      addedModules: [{ module: 'backend.adf', loadPolicy: 'ON_DEMAND', triggers: ['API', 'Node', 'DB'], fileCreated: false }],
    });
    expect(scaffolds[1]).toEqual({ kind: 'merged', file: '.ai/core.adf', addedSections: ['GUIDE'], addedModules: [] });
    // Text output names the merge, never "Created" for these files.
    out = [];
    await bootstrapCommand(YES, ['--force', '--yes', ...BASE_ARGS]);
    expect(out).toContain('  Unchanged .ai/manifest.adf');
  });

  it('INV-3: a section the user has keeps its bullets even when the template has more (deleted defaults stay deleted)', async () => {
    handEdited();
    const trimmed = v(HAND_MANIFEST.replace('  - Prefer smallest relevant module set.\n', ''));
    write('.ai/manifest.adf', trimmed);
    await bootstrapCommand(YES, ['--force', '--yes', ...BASE_ARGS]);
    expect(read('.ai/manifest.adf')).toBe(trimmed);
  });

  it('skipped{unparseable}: an unsupported ADF version is left as is and names --reset-adf', async () => {
    handEdited();
    const bad = HAND_CORE.replace('ADF: 0.1', 'ADF: 0.2');
    write('.ai/core.adf', bad);
    const { payload } = await runJson(YES, ['--force', '--yes', ...BASE_ARGS]);
    const init = adfInit(payload);
    const core = (init.details.scaffolds as ScaffoldOutcome[]).find(o => o.file === '.ai/core.adf');
    expect(core).toMatchObject({ kind: 'skipped', reason: 'unparseable' });
    expect(read('.ai/core.adf')).toBe(bad);
    expect(init.warnings.some((w: string) => w.includes('.ai/core.adf could not be parsed') && w.includes('--reset-adf'))).toBe(true);
  });

  it('skipped{guard}: when the re-parse guard refuses, nothing is written', async () => {
    handEdited();
    const noRules = v(HAND_MANIFEST.replace(/\u{1F4D0} RULES:[\s\S]*?\n\n/u, '') + '\n\u{1F4CB} NOTES: TRIPWIRE\n');
    write('.ai/manifest.adf', noRules);
    tamper = t => t.includes('TRIPWIRE') && t.includes('Prefer smallest relevant module set.');
    const { payload } = await runJson(YES, ['--force', '--yes', ...BASE_ARGS]);
    const manifest = (adfInit(payload).details.scaffolds as ScaffoldOutcome[])[0];
    expect(manifest).toMatchObject({ kind: 'skipped', reason: 'guard' });
    expect(read('.ai/manifest.adf')).toBe(noRules);
  });

  it('skipped{not-a-list}: a DEFAULT_LOAD that is not a list is reported and not edited', async () => {
    handEdited();
    const inline = v('ADF: 0.1\n\u{1F3AF} ROLE: Repo context router\n\nDEFAULT_LOAD: core.adf and state.adf\n\n\u{1F4C2} ON_DEMAND:\n  - backend.adf (Triggers on: API)\n  - billing.adf (Triggers on: payments)\n\n\u{1F4D0} RULES:\n  - mine\n');
    write('.ai/manifest.adf', inline);
    const { payload } = await runJson(YES, ['--force', '--yes', ...BASE_ARGS]);
    expect((adfInit(payload).details.scaffolds as ScaffoldOutcome[])[0]).toMatchObject({ kind: 'skipped', reason: 'not-a-list' });
    expect(read('.ai/manifest.adf')).toBe(inline);
  });
});

// ============================================================================
// Template modules (CP-3): file-only / entry-only / neither
// ============================================================================

describe('template modules', () => {
  function manifestWithout(entry: string): string {
    return MANIFEST_BACKEND_SCAFFOLD.replace(`  - ${entry}\n`, '');
  }

  for (const flags of [['--force', '--yes'], ['--yes']]) {
    it(`file-only: registers with the template triggers, not the stem (${flags.join(' ')})`, async () => {
      write('.ai/manifest.adf', manifestWithout('backend.adf (Triggers on: API, Node, DB)'));
      write('.ai/backend.adf', HAND_BACKEND);
      await bootstrapCommand(YES, [...flags, ...BASE_ARGS]);
      const m = read('.ai/manifest.adf');
      expect(m).toContain('  - backend.adf (Triggers on: API, Node, DB)\n');
      expect(m).not.toContain('Triggers on: backend');
      expect(read('.ai/backend.adf')).toBe(HAND_BACKEND);
    });
  }

  it('entry-only: writes the scaffold file and leaves the entry untouched', async () => {
    const manifest = v(MANIFEST_BACKEND_SCAFFOLD.replace('backend.adf (Triggers on: API, Node, DB)', 'backend.adf (Triggers on: custom)'));
    write('.ai/manifest.adf', manifest);
    await bootstrapCommand(YES, ['--force', '--yes', ...BASE_ARGS]);
    expect(read('.ai/backend.adf')).toBe(BACKEND_SCAFFOLD);
    expect(read('.ai/manifest.adf')).toBe(manifest);
  });

  it('neither: a preset switch creates the module and registers it with template triggers', async () => {
    handEdited();
    const { payload } = await runJson(YES, ['--force', '--yes', '--preset', 'fullstack', '--skip-install', '--skip-doctor']);
    expect(read('.ai/frontend.adf')).toBe(FRONTEND_SCAFFOLD);
    expect(read('.ai/manifest.adf')).toContain('  - frontend.adf (Triggers on: React, CSS, UI)\n');
    const outcome = (adfInit(payload).details.scaffolds as ScaffoldOutcome[])[0];
    expect(outcome).toMatchObject({ kind: 'merged', addedModules: [{ module: 'frontend.adf', loadPolicy: 'ON_DEMAND', fileCreated: true }] });
  });

  it('a non-template orphan still gets the stem trigger', async () => {
    write('.ai/manifest.adf', MANIFEST_BACKEND_SCAFFOLD);
    write('.ai/billing.adf', BILLING);
    await bootstrapCommand(YES, ['--force', '--yes', ...BASE_ARGS]);
    expect(read('.ai/manifest.adf')).toContain('  - billing.adf (Triggers on: billing)\n');
  });
});

// ============================================================================
// INV-8: doctor required wiring after a merge
// ============================================================================

describe('INV-8: required wiring after a merge', () => {
  it('adds missing core/state to DEFAULT_LOAD, so doctor passes', async () => {
    handEdited();
    write('.ai/manifest.adf', v(HAND_MANIFEST.replace('  - state.adf\n', '')));
    await bootstrapCommand(YES, ['--force', '--yes', ...BASE_ARGS]);
    out = [];
    await doctorCommand(JSON_OPTS, ['--adf-only']);
    const checks = JSON.parse(out.join('\n')).checks as Array<{ name: string; status: string }>;
    expect(checks.find(c => c.name === 'adf required wiring')?.status).toBe('PASS');
  });

  it('a core.adf under ON_DEMAND is not moved; the warning names the fix', async () => {
    handEdited();
    const m = v(HAND_MANIFEST.replace('  - core.adf\n', '').replace('\u{1F4C2} ON_DEMAND:\n', '\u{1F4C2} ON_DEMAND:\n  - core.adf (Triggers on: core)\n'));
    write('.ai/manifest.adf', m);
    const { payload } = await runJson(YES, ['--force', '--yes', ...BASE_ARGS]);
    expect(read('.ai/manifest.adf')).toBe(m);
    expect(adfInit(payload).warnings).toContain(`core.adf is listed under ON_DEMAND in ${path.join('.ai', 'manifest.adf')}; not moved. Move core.adf from ON_DEMAND to DEFAULT_LOAD in .ai/manifest.adf`);
  });
});

// ============================================================================
// INV-9: idempotent
// ============================================================================

describe('INV-9: a second --force run changes nothing', () => {
  it('leaves every byte under .ai/ and every vendor file as the first run left them', async () => {
    handEdited();
    write('.ai/manifest.adf', v(HAND_MANIFEST.replace(/\u{1F4D0} RULES:[\s\S]*?\n\n/u, '')));
    await bootstrapCommand(YES, ['--force', '--yes', ...BASE_ARGS]);
    const first = snapshotRepo();
    first.forEach((_v, k) => { if (k.startsWith('.charter/')) first.delete(k); });
    const { payload } = await runJson(YES, ['--force', '--yes', ...BASE_ARGS]);
    const second = snapshotRepo();
    second.forEach((_v, k) => { if (k.startsWith('.charter/')) second.delete(k); });
    expect([...second.entries()]).toEqual([...first.entries()]);
    expect((adfInit(payload).details.scaffolds as ScaffoldOutcome[]).every(o => o.kind === 'unchanged')).toBe(true);
    expect(adfInit(payload).details.files).toEqual([]);
  });
});

// ============================================================================
// --reset-adf: INV-4, INV-5, INV-6, INV-7, INV-11, loss report
// ============================================================================

describe('--reset-adf', () => {
  it('INV-7: non-interactive without --yes exits 1 and writes nothing, .charter/ included', async () => {
    handEdited();
    const before = snapshotRepo();
    setTty(false);
    const code = await bootstrapCommand(TEXT, ['--reset-adf', ...BASE_ARGS]);
    expect(code).toBe(1);
    expect(snapshotRepo()).toEqual(before);
    expect(fs.existsSync('.charter')).toBe(false);
    expect(errOut.join('\n')).toContain('--reset-adf replaces .ai/manifest.adf, .ai/core.adf, .ai/state.adf, .ai/backend.adf with the preset template. Re-run with --reset-adf --yes to confirm, or use --force to merge instead.');
    expect(promptCalls).toBe(0);
  });

  it('INV-7: --format json without --yes is refused with a valid JSON report', async () => {
    handEdited();
    const before = snapshotRepo();
    setTty(true);
    const { code, payload } = await runJson(TEXT, ['--reset-adf', ...BASE_ARGS]);
    expect(code).toBe(1);
    expect(payload).toMatchObject({ status: 'failure', steps: [], resetAdf: { kind: 'refused-non-interactive', exitCode: 1 } });
    expect(snapshotRepo()).toEqual(before);
    expect(promptCalls).toBe(0);
  });

  it('INV-7: an N at the prompt aborts with exit 1 and nothing written', async () => {
    handEdited();
    const before = snapshotRepo();
    setTty(true);
    promptAnswer = 'n';
    expect(await bootstrapCommand(TEXT, ['--reset-adf', ...BASE_ARGS])).toBe(1);
    expect(promptCalls).toBe(1);
    expect(snapshotRepo()).toEqual(before);
    expect(out).toContain('  .ai/manifest.adf');
  });

  it('a y at the prompt replaces, as --yes does', async () => {
    handEdited();
    setTty(true);
    promptAnswer = 'y';
    expect(await bootstrapCommand(TEXT, ['--reset-adf', ...BASE_ARGS])).toBe(0);
    expect(read('.ai/core.adf')).toBe(CORE_SCAFFOLD);
  });

  it('INV-4/6/11: backs up before replacing, gitignores the backups, and prints Replaced with the loss report', async () => {
    handEdited();
    out = [];
    expect(await bootstrapCommand(YES, ['--reset-adf', '--yes', ...BASE_ARGS])).toBe(0);
    const backups = fs.readdirSync('.ai/.backup');
    for (const [file, text] of [['manifest.adf', v(HAND_MANIFEST)], ['core.adf', HAND_CORE], ['state.adf', HAND_STATE], ['backend.adf', HAND_BACKEND]]) {
      const b = backups.find(n => n.startsWith(`${file}.`));
      expect(b, file).toBeDefined();
      expect(read(`.ai/.backup/${b}`)).toBe(text);
    }
    expect(read('.ai/.backup/.gitignore')).toBe('*\n');
    expect(read('.ai/core.adf')).toBe(CORE_SCAFFOLD);
    expect(read('.ai/billing.adf')).toBe(BILLING);

    expect(out.some(l => /^ {2}Replaced \.ai\/manifest\.adf \(backup: \.ai\/\.backup\/manifest\.adf\.\S+\)$/.test(l))).toBe(true);
    expect(out).toContain('    lost section METRICS (1 row)');
    expect(out).toContain('    lost RULES item: CUSTOM RULE: always load billing.adf for payments.');
    expect(out).toContain('    reset entry: backend.adf (Triggers on: API, Node, DB, worker, wrangler) -> (Triggers on: API, Node, DB)');
    expect(out.some(l => l.startsWith('    dropped entry: billing.adf (Triggers on: payments, stripe, invoice)'))).toBe(true);
    expect(out).toContain('    changed METRICS entry_loc: 120 / 150 [lines] -> 0 / 500 [lines]');
    expect(out).toContain('    lost CONSTRAINTS item: CUSTOM: all money math uses integer cents');
    for (const f of ['manifest.adf', 'core.adf', 'state.adf', 'backend.adf']) expect(out).not.toContain(`  Created .ai/${f}`);
    // The dropped billing entry comes back by orphan registration, with its stem.
    expect(read('.ai/manifest.adf')).toContain('  - billing.adf (Triggers on: billing)');
  });

  it('JSON: replaced[], resetAdf, and the full loss report', async () => {
    handEdited();
    const { payload } = await runJson(YES, ['--reset-adf', '--yes', ...BASE_ARGS]);
    expect(payload.resetAdf).toEqual({ kind: 'confirmed-by-yes' });
    const init = adfInit(payload);
    expect(init.details.mode).toBe('reset');
    expect(init.details.replaced).toEqual(['.ai/manifest.adf', '.ai/core.adf', '.ai/state.adf', '.ai/backend.adf']);
    expect(init.details.backupGitignore).toBe('created');
    expect(init.details.backedUp).toBe(4);
    const manifest = (init.details.scaffolds as ScaffoldOutcome[])[0];
    if (manifest.kind !== 'replaced') throw new Error(manifest.kind);
    expect(manifest.lost).toEqual({
      sectionsLost: ['METRICS'],
      itemsLost: [{ section: 'RULES', item: 'CUSTOM RULE: always load billing.adf for payments.' }],
      metricsRows: [{ key: 'ENTRY_LOC', before: 'src/index.ts', after: null }],
      entries: [
        { module: 'billing.adf', before: 'billing.adf (Triggers on: payments, stripe, invoice)', after: null },
        { module: 'backend.adf', before: 'backend.adf (Triggers on: API, Node, DB, worker, wrangler)', after: 'backend.adf (Triggers on: API, Node, DB)' },
      ],
      unparsed: false,
    });
    const core = (init.details.scaffolds as ScaffoldOutcome[])[1];
    if (core.kind !== 'replaced') throw new Error(core.kind);
    expect(core.lost.metricsRows).toEqual([{ key: 'entry_loc', before: '120 / 150 [lines]', after: '0 / 500 [lines]' }]);
  });

  it('INV-4: a file whose backup fails is not replaced (skipped{backup-failed})', async () => {
    handEdited();
    write('.ai/.backup', 'not a directory');
    const { payload } = await runJson(YES, ['--reset-adf', '--yes', ...BASE_ARGS]);
    expect(read('.ai/core.adf')).toBe(HAND_CORE);
    expect(read('.ai/manifest.adf')).toBe(v(HAND_MANIFEST));
    const scaffolds = adfInit(payload).details.scaffolds as ScaffoldOutcome[];
    expect(scaffolds.every(o => o.kind === 'skipped' && o.reason === 'backup-failed')).toBe(true);
    expect(adfInit(payload).details.backupGitignore).toBe('not-needed');
  });

  it('INV-5: backups of later runs never overwrite earlier ones', async () => {
    handEdited();
    await bootstrapCommand(YES, ['--reset-adf', '--yes', ...BASE_ARGS]);
    write('.ai/core.adf', HAND_CORE);
    await bootstrapCommand(YES, ['--reset-adf', '--yes', ...BASE_ARGS]);
    const cores = fs.readdirSync('.ai/.backup').filter(n => n.startsWith('core.adf.'));
    expect(cores.length).toBe(2);
    for (const c of cores) expect(read(`.ai/.backup/${c}`)).toBe(HAND_CORE);
  });

  it('INV-5 (unit): the same stamp twice gets a suffix instead of overwriting', () => {
    write('src.txt', 'one');
    const a = backupFile('src.txt', '.bk', 'f', 'T');
    write('src.txt', 'two');
    const b = backupFile('src.txt', '.bk', 'f', 'T');
    expect([a, b]).toEqual(['f.T', 'f.T-1']);
    expect(read('.bk/f.T')).toBe('one');
    expect(read('.bk/f.T-1')).toBe('two');
  });

  it('--reset-adf alone keeps Charter pointers; it does not imply --force', async () => {
    await bootstrapCommand(YES, ['--yes', ...BASE_ARGS]);
    const edited = read('AGENTS.md') + '\n';
    write('AGENTS.md', edited);
    await bootstrapCommand(YES, ['--reset-adf', '--yes', ...BASE_ARGS]);
    expect(read('AGENTS.md')).toBe(edited);
    await bootstrapCommand(YES, ['--reset-adf', '--force', '--yes', ...BASE_ARGS]);
    expect(read('AGENTS.md')).not.toBe(edited);
  });
});

describe('INV-6: .ai/.backup/.gitignore', () => {
  it('is created for a backup dir left by an earlier version, even under a merge', async () => {
    handEdited();
    write('.ai/.backup/core.adf.2026-01-01T00-00-00-000Z', 'old');
    const { payload } = await runJson(YES, ['--force', '--yes', ...BASE_ARGS]);
    expect(read('.ai/.backup/.gitignore')).toBe('*\n');
    expect(adfInit(payload).details.backupGitignore).toBe('created');
    const again = await runJson(YES, ['--force', '--yes', ...BASE_ARGS]);
    expect(adfInit(again.payload).details.backupGitignore).toBe('present');
  });

  it('is never written over an existing one', () => {
    write('.ai/.backup/.gitignore', '# mine\n*\n');
    expect(ensureBackupGitignore('.ai')).toBe('present');
    expect(read('.ai/.backup/.gitignore')).toBe('# mine\n*\n');
  });
});

// ============================================================================
// Loss report formatting (unit)
// ============================================================================

describe('loss report', () => {
  it('caps text at LOSS_TEXT_MAX_LINES_PER_FILE lines plus a pointer to the backup', () => {
    const old = `ADF: 0.1\nRULES:\n${Array.from({ length: 15 }, (_, i) => `  - rule ${i}`).join('\n')}\n`;
    const lost = computeLoss(old, 'ADF: 0.1\nRULES:\n  - keep\n', false);
    expect(lost.itemsLost.length).toBe(15);
    const lines = formatLossLines(lost, old);
    expect(lines.length).toBe(LOSS_TEXT_MAX_LINES_PER_FILE + 1);
    expect(lines[lines.length - 1]).toBe('... and 5 more (see backup)');
  });

  it('marks an unparseable old file', () => {
    const lost = computeLoss('ADF: 9\nX:\n  - y\n', CORE_SCAFFOLD, false);
    expect(lost.unparsed).toBe(true);
    expect(formatLossLines(lost, '')).toEqual(['could not parse the old file; its content is only in the backup']);
  });

  it('reports a placement change of a manifest entry', () => {
    const old = MANIFEST_SCAFFOLD.replace('  - state.adf\n', '').replace('\u{1F4C2} ON_DEMAND:\n', '\u{1F4C2} ON_DEMAND:\n  - state.adf\n');
    expect(computeLoss(old, MANIFEST_SCAFFOLD, true).entries).toEqual([
      { module: 'state.adf', before: 'state.adf [ON_DEMAND]', after: 'state.adf [DEFAULT_LOAD]' },
    ]);
  });
});

// ============================================================================
// INV-10: populate is scaffold-only from bootstrap
// ============================================================================

describe('INV-10: populate scaffold-only', () => {
  it('keeps hand-written CONTEXT/STATE and fills scaffold CONTEXT, even with --yes', async () => {
    write('package.json', JSON.stringify({ name: 'demo-354' }));
    write('.ai/manifest.adf', MANIFEST_BACKEND_SCAFFOLD);
    write('.ai/core.adf', HAND_CORE);
    write('.ai/state.adf', HAND_STATE);
    write('.ai/backend.adf', BACKEND_SCAFFOLD);
    await adfPopulateCommand(YES, [], { mode: 'scaffold-only', embedded: true });
    expect(read('.ai/core.adf')).toContain('  - Billing service for Acme');
    expect(read('.ai/core.adf')).not.toContain('project: demo-354');
    expect(read('.ai/state.adf')).toBe(HAND_STATE);
    expect(read('.ai/backend.adf')).not.toContain('Backend module scaffold');
  });

  it('a scaffold CONTEXT is filled', async () => {
    write('package.json', JSON.stringify({ name: 'demo-354' }));
    write('.ai/manifest.adf', MANIFEST_BACKEND_SCAFFOLD);
    write('.ai/core.adf', CORE_SCAFFOLD);
    write('.ai/state.adf', STATE_SCAFFOLD);
    await adfPopulateCommand(YES, [], { mode: 'scaffold-only' });
    expect(read('.ai/core.adf')).toContain('project: demo-354');
    expect(read('.ai/state.adf')).not.toContain('Repository initialized with ADF context system');
  });

  it('`adf populate --yes` run directly still forces (unchanged CLI semantics)', async () => {
    write('package.json', JSON.stringify({ name: 'demo-354' }));
    write('.ai/manifest.adf', MANIFEST_BACKEND_SCAFFOLD);
    write('.ai/core.adf', HAND_CORE);
    write('.ai/state.adf', HAND_STATE);
    await adfPopulateCommand(YES, []);
    expect(read('.ai/core.adf')).toContain('project: demo-354');
    expect(read('.ai/state.adf')).not.toBe(HAND_STATE);
  });

  it('embedded populate prints no JSON of its own', async () => {
    write('.ai/manifest.adf', MANIFEST_BACKEND_SCAFFOLD);
    write('.ai/core.adf', CORE_SCAFFOLD);
    write('.ai/state.adf', STATE_SCAFFOLD);
    out = [];
    await adfPopulateCommand(JSON_OPTS, [], { mode: 'scaffold-only', embedded: true });
    expect(out).toEqual([]);
  });
});

// ============================================================================
// #347 hints
// ============================================================================

describe('#347: hints name commands that exist', () => {
  it('the orphan hint names adf create, and only when the orphans were not registered', async () => {
    write('.ai/manifest.adf', MANIFEST_BACKEND_SCAFFOLD);
    write('.ai/billing.adf', BILLING);
    const { payload } = await runJson(TEXT, BASE_ARGS);
    const warnings = adfInit(payload).warnings as string[];
    expect(warnings).toContain('Run `charter adf create <module> --load default|on-demand` for each to add them to the manifest, or re-run with --yes.');
    expect(warnings.some(w => w.includes('adf register'))).toBe(false);

    const yes = await runJson(YES, ['--yes', ...BASE_ARGS.slice(0, 2), '--skip-install', '--skip-doctor']);
    expect((adfInit(yes.payload).warnings as string[]).some(w => w.includes('adf create'))).toBe(false);
  });

  it('the empty-DEFAULT_LOAD self-check names adf create', async () => {
    write('.ai/manifest.adf', 'ADF: 0.1\nDEFAULT_LOAD: core.adf\n\n\u{1F4C2} ON_DEMAND:\n  - backend.adf (Triggers on: API, Node, DB)\n');
    write('.ai/core.adf', HAND_CORE);
    await bootstrapCommand(TEXT, BASE_ARGS);
    expect(out).toContain("  Warning: manifest.adf parsed with 0 DEFAULT_LOAD entries — run 'charter adf create core.adf --load default' to repair.");
    expect(out.join('\n')).not.toContain('adf register');
  });
});

// ============================================================================
// INV-11, INV-12
// ============================================================================

describe('INV-11: never "Created" for a file that existed', () => {
  it('under --force and --reset-adf --yes', async () => {
    for (const args of [['--force', '--yes'], ['--reset-adf', '--yes']]) {
      handEdited();
      await bootstrapCommand(YES, [...args, ...BASE_ARGS]);
      const existed = new Set(snapshotRepo().keys());
      write('.ai/core.adf', HAND_CORE);
      out = [];
      await bootstrapCommand(YES, [...args, ...BASE_ARGS]);
      for (const line of out.filter(l => l.startsWith('  Created '))) {
        expect(existed.has(line.slice('  Created '.length)), line).toBe(false);
      }
    }
  });

  it('a rewritten sync lock prints Updated, not Created', async () => {
    handEdited();
    write('.ai/.adf.lock', '{}\n');
    await bootstrapCommand(YES, ['--force', '--yes', ...BASE_ARGS]);
    expect(out).toContain('  Updated .ai/.adf.lock');
    expect(out).not.toContain('  Created .ai/.adf.lock');
  });
});

describe('INV-12: JSON is a superset of the 2.0.0 shape', () => {
  // The 2.0.0 shape of `bootstrap --format json`, as released.
  const V2_TOP = { status: 'string', steps: 'array', nextSteps: 'array', governanceGaps: 'array' };
  const V2_STEP = { name: 'string', status: 'string', details: 'object', warnings: 'array' };
  const V2_ADF_INIT = { files: 'array', pointers: 'array', backedUp: 'number', orphans: 'array' };
  const kind = (v: unknown): string => (Array.isArray(v) ? 'array' : typeof v);

  for (const args of [['--yes'], ['--force', '--yes'], ['--reset-adf', '--yes']]) {
    it(`keeps every 2.0.0 key and type (${args.join(' ')})`, async () => {
      handEdited();
      const { payload } = await runJson(YES, [...args, ...BASE_ARGS]);
      for (const [k, t] of Object.entries(V2_TOP)) expect(kind(payload[k]), k).toBe(t);
      for (const step of payload.steps) for (const [k, t] of Object.entries(V2_STEP)) expect(kind(step[k]), `${step.name}.${k}`).toBe(t);
      const init = adfInit(payload);
      for (const [k, t] of Object.entries(V2_ADF_INIT)) expect(kind(init.details[k]), k).toBe(t);
      // Only these keys are new.
      expect(Object.keys(init.details).filter(k => !(k in V2_ADF_INIT)).sort()).toEqual(['backupGitignore', 'mode', 'replaced', 'scaffolds']);
      expect(Object.keys(payload).filter(k => !(k in V2_TOP))).toEqual(args[0] === '--reset-adf' ? ['resetAdf'] : []);
      // `files` still lists every written label, replaced ones included.
      for (const f of init.details.replaced) expect(init.details.files).toContain(f);
    });
  }
});

/**
 * `adf compile` and `adf tidy` read the vendor-mode record (#318, PR 2 of 6).
 *
 * Pins the PR2 contract: the effective compile state per target, the --mode
 * flag, the --write decision table, the seven --check statuses, tidy's
 * record-aware skips, the sync no-SYNC hint, and INV-P2-1..INV-P2-12.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPILE_BANNER_MARKER } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError } from '../index';
import {
  adfCommand,
  POINTER_AGENTS_MD,
  POINTER_CLAUDE_MD,
  POINTER_CLAUDE_MD_HYBRID,
  POINTER_COPILOT_MD,
  POINTER_CURSORRULES,
  POINTER_GEMINI_MD,
} from '../commands/adf';

const TEXT: CLIOptions = { configPath: '.charter', format: 'text', ciMode: false, yes: false };
const JSON_OPTS: CLIOptions = { ...TEXT, format: 'json' };

const BASE_MANIFEST = [
  'ADF: 0.1',
  '',
  '\u{1F3AF} ROLE: Test project',
  '',
  '\u{1F4E6} DEFAULT_LOAD:',
  '  - core.adf',
  '  - state.adf',
  '',
  '\u{1F4C2} ON_DEMAND:',
  '  - frontend.adf (Triggers on: React, CSS)',
  '',
].join('\n');

const CORE_ADF = 'ADF: 0.1\n\n\u{1F4CB} CONTEXT:\n  - TypeScript monorepo\n\n⚠️ CONSTRAINTS [load-bearing]:\n  - No secrets in commits\n';

/** A pointer carrying a section tidy would extract into .ai/. */
const BLOATED_CLAUDE = `${POINTER_CLAUDE_MD}\n## Testing\n\n- Always run pnpm test before pushing to main.\n- Never skip the integration suite in CI.\n`;
const HAND_WRITTEN = '# My CLAUDE.md\n\nHouse rules I wrote myself.\n';

const originalCwd = process.cwd();
let tmp = '';
let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-vendor-consumers-'));
  process.chdir(tmp);
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function vendors(...entries: string[]): string {
  return `${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\n${entries.map(e => `  - ${e}\n`).join('')}`;
}

function scaffold(manifest = BASE_MANIFEST): void {
  fs.mkdirSync('.ai', { recursive: true });
  fs.writeFileSync('.ai/manifest.adf', manifest);
  fs.writeFileSync('.ai/core.adf', CORE_ADF);
  fs.writeFileSync('.ai/state.adf', 'ADF: 0.1\n\n\u{1F9E0} STATE:\n  CURRENT: Active development\n');
}

function manifestText(): string {
  return fs.readFileSync('.ai/manifest.adf', 'utf-8');
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf-8');
}

/** Snapshot of every file under .ai/ (to prove a command wrote nothing there). */
function aiSnapshot(): Record<string, string> {
  return Object.fromEntries(fs.readdirSync('.ai').sort().map(f => [f, read(path.join('.ai', f))]));
}

async function run(args: string[], options: CLIOptions = TEXT): Promise<{ code: number; out: string; err: string }> {
  out = [];
  err = [];
  const code = await adfCommand(options, args);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function runJson<T = Record<string, unknown>>(args: string[]): Promise<{ code: number; json: T; err: string }> {
  const r = await run([...args, '--format', 'json'], JSON_OPTS);
  return { code: r.code, json: JSON.parse(r.out) as T, err: r.err };
}

/** Compiled output for a target, written through the CLI into a scratch repo. */
async function compiledOutput(target: string): Promise<string> {
  const r = await run(['compile', '--target', target]);
  return r.out;
}

interface CheckRow { target: string; file: string; mode: string | null; source: string | null; status: string; extractable: number | null; remedy: string | null }
interface CheckJson { stale: string[]; current: string[]; missing: string[]; skipped: string[]; upToDate: boolean; targets: CheckRow[]; nextActions: string[] }
interface WriteRow { target: string; file: string; state: string; source: string | null; status: string; recordedMode: string | null; previousMode: string | null; remedy: string | null }
interface WriteJson { written: string[]; refused: string[]; skipped: string[]; targets: WriteRow[]; nextActions: string[] }
interface TidyJson { files: Array<{ file: string; vendorFile: string | null; mode: string | null; source: string | null; status: string; skipReason: string | null; itemsExtracted: number }>; totalExtracted: number; warnings: string[] }

/** A command that would change a pointer/unmanaged file's mode: compile --write without --mode (INV-P2-1). */
const MODE_CHANGING = /charter adf compile --target \S+ --write(?! --mode compiled)(?!\S)/;

function aliasedAgents(content: string): void {
  fs.writeFileSync('agents.md', content);
  if (!fs.existsSync('AGENTS.md')) fs.linkSync('agents.md', 'AGENTS.md');
}

// ============================================================================
// 1. compile --check: the seven statuses
// ============================================================================

describe('compile --check is mode-aware', () => {
  it('gives each of the seven statuses with its remedy, legacy keys intact', async () => {
    scaffold(vendors('GEMINI.md: compiled', '.cursorrules: compiled'));
    // claude: pointer-bloated (inferred). agents: pointer-ok (inferred).
    fs.writeFileSync('CLAUDE.md', BLOATED_CLAUDE);
    fs.writeFileSync('AGENTS.md', POINTER_AGENTS_MD);
    // gemini: recorded compiled but looks pointer → mode-drift.
    fs.writeFileSync('GEMINI.md', POINTER_GEMINI_MD);
    // cursor: recorded compiled, absent → missing.
    const r = await runJson<CheckJson>(['compile', '--target', 'all', '--check']);
    expect(r.code).toBe(1);
    const byFile = Object.fromEntries(r.json.targets.map(t => [t.file, t]));
    expect(byFile['CLAUDE.md']).toMatchObject({ status: 'pointer-bloated', mode: 'pointer', source: 'inferred', remedy: 'charter adf tidy --source CLAUDE.md' });
    expect(byFile['CLAUDE.md'].extractable).toBeGreaterThan(0);
    expect(byFile['AGENTS.md']).toEqual({ target: 'agents', file: 'AGENTS.md', mode: 'pointer', source: 'inferred', status: 'pointer-ok', extractable: null, remedy: null });
    expect(byFile['GEMINI.md']).toMatchObject({ status: 'mode-drift', mode: 'compiled', source: 'recorded', remedy: 'charter adf vendor set GEMINI.md pointer' });
    expect(byFile['.cursorrules']).toMatchObject({ status: 'missing', mode: 'compiled', remedy: 'charter adf compile --target cursor --write' });
    // Legacy keys keep their names and types (INV-P2-9).
    expect(r.json.stale).toEqual(['CLAUDE.md', 'GEMINI.md']);
    expect(r.json.current).toEqual(['AGENTS.md']);
    expect(r.json.missing).toEqual(['.cursorrules']);
    expect(r.json.skipped).toEqual([]);
    expect(r.json.upToDate).toBe(false);
    expect(r.json.nextActions).toEqual([
      'charter adf tidy --source CLAUDE.md',
      'charter adf compile --target cursor --write',
      'charter adf vendor set GEMINI.md pointer',
      'charter adf compile --target gemini --write',
    ]);
  });

  it('reports fresh, stale and skipped-unmanaged', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', await compiledOutput('claude'));
    fs.writeFileSync('AGENTS.md', `${await compiledOutput('agents')}\n# drift\n`);
    fs.writeFileSync('GEMINI.md', HAND_WRITTEN);
    const r = await runJson<CheckJson>(['compile', '--target', 'all', '--check']);
    const status = Object.fromEntries(r.json.targets.map(t => [t.file, t.status]));
    expect(status).toEqual({ 'CLAUDE.md': 'fresh', 'AGENTS.md': 'stale', '.cursorrules': 'missing', 'GEMINI.md': 'skipped-unmanaged' });
    expect(r.json.skipped).toEqual(['GEMINI.md']);
    expect(r.json.targets.find(t => t.file === 'GEMINI.md')).toMatchObject({ mode: 'unmanaged', source: 'inferred', remedy: null });
  });

  it('prints the literal text lines for each status', async () => {
    scaffold(vendors('GEMINI.md: compiled', 'AGENTS.md: pointer'));
    fs.writeFileSync('CLAUDE.md', BLOATED_CLAUDE);
    fs.writeFileSync('GEMINI.md', POINTER_GEMINI_MD);
    fs.writeFileSync('.cursorrules', 'hand-written rules\n');
    const r = await run(['compile', '--target', 'all', '--check']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ {2}\[bloated\] CLAUDE\.md — thin pointer carries \d+ item\(s\) that belong in \.ai\/\.\n {10}Run: charter adf tidy --source CLAUDE\.md/);
    expect(r.out).toContain('  [missing] AGENTS.md — recorded as a pointer but not found on disk.\n          Restore it (git checkout -- AGENTS.md), or stop tracking it: charter adf vendor set AGENTS.md unmanaged');
    expect(r.out).toContain('  [skip] .cursorrules is unmanaged (inferred); not checked');
    expect(r.out).toContain('  [drift] GEMINI.md — recorded as compiled but looks pointer on disk.\n          Keep the file as it is: charter adf vendor set GEMINI.md pointer\n          Or make it match the record: charter adf compile --target gemini --write');
  });

  it('passes a clean pointer set (exit 0) and names the source', async () => {
    scaffold(vendors('CLAUDE.md: pointer'));
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD_HYBRID);
    fs.writeFileSync('AGENTS.md', POINTER_AGENTS_MD);
    fs.writeFileSync('.cursorrules', POINTER_CURSORRULES);
    fs.writeFileSync('GEMINI.md', POINTER_GEMINI_MD);
    const r = await run(['compile', '--target', 'all', '--check']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('  [ok] CLAUDE.md is a thin pointer to .ai/ (recorded)');
    expect(r.out).toContain('  [ok] AGENTS.md is a thin pointer to .ai/ (inferred)');
    const j = await runJson<CheckJson>(['compile', '--target', 'all', '--check']);
    expect(j.json.upToDate).toBe(true);
    expect(j.json.nextActions).toEqual([]);
  });

  it('a recorded pointer carrying the compile banner is mode-drift, restored by git checkout', async () => {
    scaffold(vendors('CLAUDE.md: pointer'));
    fs.writeFileSync('CLAUDE.md', await compiledOutput('claude'));
    const r = await runJson<CheckJson>(['compile', '--target', 'claude', '--check']);
    expect(r.code).toBe(1);
    expect(r.json.targets[0]).toMatchObject({ status: 'mode-drift', mode: 'pointer', remedy: 'charter adf vendor set CLAUDE.md compiled' });
    expect(r.json.nextActions).toEqual(['charter adf vendor set CLAUDE.md compiled', 'git checkout -- CLAUDE.md']);
  });

  it('recorded compiled that now looks hand-authored: the restore remedy needs --force', async () => {
    scaffold(vendors('CLAUDE.md: compiled'));
    fs.writeFileSync('CLAUDE.md', HAND_WRITTEN);
    const r = await runJson<CheckJson>(['compile', '--target', 'claude', '--check']);
    expect(r.json.nextActions).toEqual(['charter adf vendor set CLAUDE.md unmanaged', 'charter adf compile --target claude --write --force']);
  });

  it('drift on a recorded-compiled pointer with bloat lists the content-preserving fix first', async () => {
    scaffold(vendors('CLAUDE.md: compiled'));
    fs.writeFileSync('CLAUDE.md', BLOATED_CLAUDE);
    const text = await run(['compile', '--target', 'claude', '--check']);
    expect(text.out).toMatch(/Keep the file as it is: charter adf vendor set CLAUDE\.md pointer, then charter adf tidy --source CLAUDE\.md\n {10}Or make it match the record: charter adf compile --target claude --write {2}\(discards \d+ item\(s\) not in \.ai\/\)/);
    const r = await runJson<CheckJson>(['compile', '--target', 'claude', '--check']);
    expect(r.json.nextActions).toEqual([
      'charter adf vendor set CLAUDE.md pointer',
      'charter adf tidy --source CLAUDE.md',
      'charter adf compile --target claude --write',
    ]);
    // Following the first-listed actions loses nothing.
    for (const action of r.json.nextActions.slice(0, 2)) {
      expect((await run(action.replace(/^charter adf /, '').split(' '))).code).toBe(0);
    }
    expect(Object.values(aiSnapshot()).join('\n')).toContain('Never skip the integration suite in CI');
    const after = await runJson<CheckJson>(['compile', '--target', 'claude', '--check']);
    expect(after.json.targets[0].status).toBe('pointer-ok');
  });

  it('collapses nextActions to the legacy line when only compiled targets are stale or missing', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', `${await compiledOutput('claude')}\n# drift\n`);
    fs.writeFileSync('GEMINI.md', POINTER_GEMINI_MD);
    const all = await runJson<CheckJson>(['compile', '--target', 'all', '--check']);
    expect(all.json.nextActions).toEqual(['charter adf compile --target all --write']);
    const one = await runJson<CheckJson>(['compile', '--target', 'claude', '--check']);
    expect(one.json.nextActions).toEqual(['charter adf compile --target claude --write']);
    fs.writeFileSync('GEMINI.md', `${POINTER_GEMINI_MD}\n## Testing\n\n- Always run pnpm test before pushing to main.\n`);
    const mixed = await runJson<CheckJson>(['compile', '--target', 'all', '--check']);
    expect(mixed.json.nextActions).not.toContain('charter adf compile --target all --write');
  });

  it('a recorded unmanaged file never drifts and an absent one is skipped', async () => {
    scaffold(vendors('CLAUDE.md: unmanaged', 'AGENTS.md: unmanaged'));
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    const r = await runJson<CheckJson>(['compile', '--target', 'all', '--check']);
    expect(r.json.targets.slice(0, 2).map(t => t.status)).toEqual(['skipped-unmanaged', 'skipped-unmanaged']);
  });

  it('INV-P2-1: no remedy suggests a mode-changing compile --write for a pointer or unmanaged file', async () => {
    scaffold(vendors('GEMINI.md: pointer', '.cursorrules: unmanaged'));
    fs.writeFileSync('CLAUDE.md', BLOATED_CLAUDE);
    fs.writeFileSync('AGENTS.md', HAND_WRITTEN);
    fs.writeFileSync('GEMINI.md', `<!-- ${COMPILE_BANNER_MARKER} -->\nold\n`);
    const text = await run(['compile', '--target', 'all', '--check']);
    const json = await runJson<CheckJson>(['compile', '--target', 'all', '--check']);
    for (const line of [...text.out.split('\n'), ...json.json.nextActions, ...json.json.targets.map(t => t.remedy ?? '')]) {
      expect(line).not.toMatch(MODE_CHANGING);
    }
    const write = await runJson<WriteJson>(['compile', '--target', 'all', '--write']);
    for (const line of [...write.json.nextActions, ...write.json.targets.map(t => t.remedy ?? '')]) {
      expect(line).not.toMatch(MODE_CHANGING);
    }
  });
});

// ============================================================================
// 2. compile --write: the decision table
// ============================================================================

describe('compile --write decision table', () => {
  it('--target all over pointers skips them (exit 0), leaves them untouched, and says how to convert', async () => {
    scaffold();
    const files = { 'CLAUDE.md': POINTER_CLAUDE_MD_HYBRID, 'AGENTS.md': POINTER_AGENTS_MD, '.cursorrules': POINTER_CURSORRULES, 'GEMINI.md': POINTER_GEMINI_MD };
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(f, c);
    const before = manifestText();
    const r = await run(['compile', '--target', 'all', '--write']);
    expect(r.code).toBe(0);
    for (const [f, c] of Object.entries(files)) expect(read(f)).toBe(c);
    expect(manifestText()).toBe(before);
    expect(r.out).toContain('  [skip] CLAUDE.md is pointer (inferred); not compiled. To switch it to compiled output: charter adf compile --target claude --write --mode compiled');
    expect(r.out).toContain('  [skip] GEMINI.md is pointer (inferred); not compiled. To switch it to compiled output: charter adf compile --target gemini --write --mode compiled');
    expect(r.out).toContain('  No target is in compiled mode, so nothing was written. Pointer files stay pointers.\n  To switch them: charter adf compile --target all --write --mode compiled. To see modes: charter adf vendor status');
  });

  it('--target all over mixed modes writes compiled/absent targets, skips the rest, exit 0', async () => {
    scaffold(vendors('GEMINI.md: unmanaged'));
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    fs.writeFileSync('AGENTS.md', `<!-- ${COMPILE_BANNER_MARKER} -->\nold\n`);
    const r = await runJson<WriteJson>(['compile', '--target', 'all', '--write']);
    expect(r.code).toBe(0);
    expect(r.json.written).toEqual(['AGENTS.md', '.cursorrules']);
    expect(r.json.skipped).toEqual(['CLAUDE.md', 'GEMINI.md']);
    expect(r.json.refused).toEqual([]);
    expect(r.json.targets.map(t => [t.file, t.state, t.status, t.recordedMode, t.previousMode])).toEqual([
      ['CLAUDE.md', 'pointer', 'skipped-mode', null, null],
      ['AGENTS.md', 'compiled', 'written', 'compiled', null],
      ['.cursorrules', 'absent-unrecorded', 'written', 'compiled', null],
      ['GEMINI.md', 'unmanaged', 'skipped-mode', 'unmanaged', null],
    ]);
    expect(r.json.targets[3].source).toBe('recorded');
    expect(r.json.targets[2].source).toBeNull();
    expect(read('CLAUDE.md')).toBe(POINTER_CLAUDE_MD);
    expect(fs.existsSync('GEMINI.md')).toBe(false);
    expect(r.json.nextActions).toEqual([
      'charter adf compile --target claude --write --mode compiled',
      'charter adf compile --target gemini --write --mode compiled',
    ]);
  });

  it('a single pointer target is refused (exit 1) and left untouched', async () => {
    scaffold(vendors('CLAUDE.md: pointer'));
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    const r = await run(['compile', '--target', 'claude', '--write']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('  [warn] Refused to compile CLAUDE.md: it is pointer (recorded), and writing compiled output would change its mode.\n         Run: charter adf compile --target claude --write --mode compiled');
    expect(read('CLAUDE.md')).toBe(POINTER_CLAUDE_MD);
    const j = await runJson<WriteJson>(['compile', '--target', 'claude', '--write']);
    expect(j.json).toMatchObject({ written: [], refused: ['CLAUDE.md'], skipped: [] });
    expect(j.json.targets[0]).toMatchObject({ status: 'refused-mode-change', state: 'pointer', recordedMode: 'pointer' });
  });

  it('INV-P2-2: --force alone never converts a pointer or unmanaged target', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    fs.writeFileSync('GEMINI.md', HAND_WRITTEN);
    const single = await runJson<WriteJson>(['compile', '--target', 'gemini', '--write', '--force']);
    expect(single.code).toBe(1);
    expect(single.json.targets[0].status).toBe('refused-mode-change');
    const all = await runJson<WriteJson>(['compile', '--target', 'all', '--write', '--force']);
    expect(all.code).toBe(0);
    expect(all.json.skipped).toEqual(['CLAUDE.md', 'GEMINI.md']);
    expect(read('CLAUDE.md')).toBe(POINTER_CLAUDE_MD);
    expect(read('GEMINI.md')).toBe(HAND_WRITTEN);
  });

  it('--mode compiled converts a recorded pointer: record upserted, file written, mode switch shown', async () => {
    scaffold(vendors('CLAUDE.md: pointer'));
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD_HYBRID);
    const r = await run(['compile', '--target', 'claude', '--write', '--mode', 'compiled']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('  [ok] Written CLAUDE.md (mode: pointer -> compiled)');
    expect(manifestText()).toBe(vendors('CLAUDE.md: compiled'));
    expect(read('CLAUDE.md')).toContain(COMPILE_BANNER_MARKER);
    const check = await runJson<CheckJson>(['compile', '--target', 'claude', '--check']);
    expect(check.json.targets[0]).toMatchObject({ status: 'fresh', mode: 'compiled', source: 'recorded' });
  });

  it('--mode compiled converts an inferred pointer too (CP-1 strict), adding the entry', async () => {
    scaffold();
    fs.writeFileSync('AGENTS.md', POINTER_AGENTS_MD);
    const r = await runJson<WriteJson>(['compile', '--target', 'agents', '--write', '--mode', 'compiled']);
    expect(r.code).toBe(0);
    expect(r.json.targets[0]).toMatchObject({ state: 'pointer', source: 'inferred', status: 'written', recordedMode: 'compiled', previousMode: 'pointer' });
    expect(manifestText()).toBe(vendors('AGENTS.md: compiled'));
  });

  it('--mode compiled over unmanaged still needs --force for existing content; the refusal leaves the record alone', async () => {
    scaffold(vendors('CLAUDE.md: unmanaged'));
    fs.writeFileSync('CLAUDE.md', HAND_WRITTEN);
    const before = manifestText();
    const refused = await runJson<WriteJson>(['compile', '--target', 'claude', '--write', '--mode', 'compiled']);
    expect(refused.code).toBe(1);
    expect(refused.json.targets[0]).toMatchObject({ status: 'refused-hand-authored', recordedMode: 'unmanaged', previousMode: null });
    expect(refused.json.nextActions).toEqual(['charter adf compile --target claude --write --mode compiled --force']);
    expect(manifestText()).toBe(before);
    expect(read('CLAUDE.md')).toBe(HAND_WRITTEN);

    const forced = await runJson<WriteJson>(['compile', '--target', 'claude', '--write', '--mode', 'compiled', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.json.targets[0]).toMatchObject({ status: 'written', previousMode: 'unmanaged', recordedMode: 'compiled' });
    expect(manifestText()).toBe(vendors('CLAUDE.md: compiled'));
  });

  it('--mode compiled keeps the retained-section guard for pointers (#295) and records nothing on refusal', async () => {
    scaffold();
    const withProtocol = `${POINTER_AGENTS_MD}\n## Release Protocol\n\n- Tag before publishing.\n`;
    fs.writeFileSync('AGENTS.md', withProtocol);
    const r = await runJson<WriteJson>(['compile', '--target', 'agents', '--write', '--mode', 'compiled']);
    expect(r.code).toBe(1);
    expect(r.json.targets[0].status).toBe('refused-retained');
    expect(manifestText()).toBe(BASE_MANIFEST);
    expect(read('AGENTS.md')).toBe(withProtocol);
  });

  it('--mode compiled over a compiled or absent target writes as usual', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', `<!-- ${COMPILE_BANNER_MARKER} -->\nold\n`);
    const r = await runJson<WriteJson>(['compile', '--target', 'all', '--write', '--mode', 'compiled']);
    expect(r.code).toBe(0);
    expect(r.json.written).toEqual(['CLAUDE.md', 'AGENTS.md', '.cursorrules', 'GEMINI.md']);
    expect(r.json.targets.every(t => t.previousMode === null && t.recordedMode === 'compiled')).toBe(true);
  });

  it('INV-P2-3: a skipped record upsert means no file write (refused-record)', async () => {
    scaffold(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS: not a list\n`);
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    const before = manifestText();
    const r = await run(['compile', '--target', 'claude', '--write', '--mode', 'compiled']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('  [warn] Refused to compile CLAUDE.md: its mode could not be recorded as compiled in');
    expect(r.err).toContain('Nothing was written. Fix the manifest or run: charter adf vendor status');
    expect(read('CLAUDE.md')).toBe(POINTER_CLAUDE_MD);
    expect(manifestText()).toBe(before);
    const j = await runJson<WriteJson>(['compile', '--target', 'claude', '--write', '--mode', 'compiled']);
    expect(j.json.targets[0]).toMatchObject({ status: 'refused-record', recordedMode: null });
    expect(j.json.refused).toEqual(['CLAUDE.md']);
  });

  const rootIgnoresReadOnly = typeof process.getuid === 'function' && process.getuid() === 0;

  it('a write failure after the --mode upsert reverts that record and the run goes on', async () => {
    if (rootIgnoresReadOnly) return;
    scaffold(vendors('CLAUDE.md: pointer'));
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    fs.writeFileSync('AGENTS.md', POINTER_AGENTS_MD);
    fs.chmodSync('CLAUDE.md', 0o444);
    try {
      const r = await run(['compile', '--target', 'all', '--write', '--mode', 'compiled']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/ {2}\[warn\] Could not write CLAUDE\.md: .+\. Its mode record was restored to pointer\./);
      expect(read('CLAUDE.md')).toBe(POINTER_CLAUDE_MD);
      // CLAUDE.md is back to pointer; the inferred AGENTS.md was switched; the absent targets were added.
      expect(manifestText()).toBe(vendors('CLAUDE.md: pointer', 'AGENTS.md: compiled', '.cursorrules: compiled', 'GEMINI.md: compiled'));
      expect(read('AGENTS.md')).toContain(COMPILE_BANNER_MARKER);
    } finally {
      fs.chmodSync('CLAUDE.md', 0o644);
    }
  });

  it('a write failure is a refused-record row with writeError; pending add-if-absent entries still land', async () => {
    if (rootIgnoresReadOnly) return;
    scaffold();
    fs.writeFileSync('CLAUDE.md', `<!-- ${COMPILE_BANNER_MARKER} -->\nold\n`);
    fs.chmodSync('CLAUDE.md', 0o444);
    try {
      const r = await runJson<WriteJson>(['compile', '--target', 'all', '--write']);
      expect(r.code).toBe(1);
      const claude = r.json.targets[0] as WriteRow & { writeError: string | null };
      expect(claude).toMatchObject({ status: 'refused-record', recordedMode: null, remedy: 'charter adf compile --target claude --write' });
      expect(claude.writeError).toBeTruthy();
      expect(r.json.refused).toEqual(['CLAUDE.md']);
      expect(r.json.written).toEqual(['AGENTS.md', '.cursorrules', 'GEMINI.md']);
      expect(manifestText()).toBe(vendors('AGENTS.md: compiled', '.cursorrules: compiled', 'GEMINI.md: compiled'));
      expect((r.json.targets[1] as WriteRow & { writeError: string | null }).writeError).toBeNull();
    } finally {
      fs.chmodSync('CLAUDE.md', 0o644);
    }
  });

  it('refuses an existing hand-authored unmanaged file with a one-step remedy that includes --force', async () => {
    scaffold();
    fs.writeFileSync('GEMINI.md', HAND_WRITTEN);
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    const r = await run(['compile', '--target', 'gemini', '--write']);
    expect(r.err).toContain('Run: charter adf compile --target gemini --write --mode compiled --force');
    const all = await runJson<WriteJson>(['compile', '--target', 'all', '--write']);
    expect(all.json.nextActions).toEqual([
      'charter adf compile --target claude --write --mode compiled',
      'charter adf compile --target gemini --write --mode compiled --force',
    ]);
    const step = await run(['compile', '--target', 'gemini', '--write', '--mode', 'compiled', '--force']);
    expect(step.code).toBe(0);
  });

  it('stdout-mode nextActions are mode-aware', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    const pointer = await runJson<{ nextActions: string[] }>(['compile', '--target', 'claude']);
    expect(pointer.json.nextActions).toEqual([
      'charter adf compile --target claude --write --mode compiled',
      'charter adf compile --target claude --check',
    ]);
    const absent = await runJson<{ nextActions: string[] }>(['compile', '--target', 'agents']);
    expect(absent.json.nextActions).toEqual([
      'charter adf compile --target agents --write',
      'charter adf compile --target all --write',
      'charter adf compile --target agents --check',
    ]);
  });

  it('INV-P2-4: no write path prints the "record kept" warning', async () => {
    scaffold(vendors('CLAUDE.md: pointer', 'AGENTS.md: compiled', 'GEMINI.md: unmanaged'));
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    fs.writeFileSync('GEMINI.md', HAND_WRITTEN);
    const runs = [
      await run(['compile', '--target', 'all', '--write']),
      await run(['compile', '--target', 'claude', '--write']),
      await run(['compile', '--target', 'all', '--write', '--mode', 'compiled', '--force']),
      await run(['compile', '--target', 'all', '--write']),
    ];
    for (const r of runs) expect(`${r.out}\n${r.err}`).not.toContain('record kept');
    expect(manifestText()).toBe(vendors('CLAUDE.md: compiled', 'AGENTS.md: compiled', 'GEMINI.md: compiled', '.cursorrules: compiled'));
  });

  it('--mode misuse is a usage error (exit 2)', async () => {
    scaffold();
    const cases: Array<[string[], string]> = [
      [['compile', '--target', 'claude', '--mode', 'compiled'], '--mode requires --write.'],
      [['compile', '--target', 'claude', '--check', '--mode', 'compiled'], '--mode requires --write.'],
      [['compile', '--target', 'claude', '--write', '--mode', 'pointer'], "--mode accepts only 'compiled'. To make a file a pointer: charter adf vendor set <file> pointer"],
      [['compile', '--target', 'claude', '--write', '--mode'], "--mode accepts only 'compiled'."],
    ];
    for (const [args, message] of cases) {
      const e = await adfCommand(TEXT, args).then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(CLIError);
      expect((e as CLIError).exitCode).toBe(2);
      expect((e as CLIError).message).toContain(message);
    }
    expect(fs.existsSync('CLAUDE.md')).toBe(false);
  });
});

// ============================================================================
// 3. adf tidy reads the record
// ============================================================================

describe('adf tidy is mode-aware', () => {
  it('INV-P2-5: the banner wins over a recorded pointer; nothing is ingested', async () => {
    scaffold(vendors('CLAUDE.md: pointer'));
    const compiled = `<!-- ${COMPILE_BANNER_MARKER} -->\n${BLOATED_CLAUDE}`;
    fs.writeFileSync('CLAUDE.md', compiled);
    const before = aiSnapshot();
    const r = await runJson<TidyJson>(['tidy']);
    expect(r.json.files).toEqual([expect.objectContaining({ file: 'CLAUDE.md', status: 'compiled', skipReason: 'banner', mode: 'pointer', source: 'recorded' })]);
    expect(aiSnapshot()).toEqual(before);
    expect(read('CLAUDE.md')).toBe(compiled);
  });

  it('skips a recorded-compiled pointer; its first remedy keeps the content (follows it to prove it)', async () => {
    scaffold(vendors('CLAUDE.md: compiled'));
    fs.writeFileSync('CLAUDE.md', BLOATED_CLAUDE);
    const before = aiSnapshot();
    const r = await runJson<TidyJson>(['tidy']);
    expect(r.json.files[0]).toMatchObject({ status: 'compiled', skipReason: 'recorded-compiled', itemsExtracted: 0 });
    expect(r.json.totalExtracted).toBe(0);
    expect(r.json.warnings).toHaveLength(1);
    expect(r.json.warnings[0]).toMatch(/^CLAUDE\.md is recorded as compiled but has no compile banner — skipping\. If it is meant to be a pointer: charter adf vendor set CLAUDE\.md pointer, then charter adf tidy --source CLAUDE\.md\. To regenerate it as compiled output instead \(discards \d+ item\(s\) not in \.ai\/\): charter adf compile --target claude --write$/);
    expect(aiSnapshot()).toEqual(before);
    expect(read('CLAUDE.md')).toBe(BLOATED_CLAUDE);

    // The first-listed commands move the content into .ai/ instead of losing it.
    expect((await run(['vendor', 'set', 'CLAUDE.md', 'pointer'])).code).toBe(0);
    expect((await run(['tidy', '--source', 'CLAUDE.md'])).code).toBe(0);
    expect(Object.values(aiSnapshot()).join('\n')).toContain('Always run pnpm test before pushing to main');
    expect(read('CLAUDE.md')).not.toContain('Always run pnpm test');
  });

  it('a recorded-compiled hand-authored file is pointed at vendor set unmanaged first', async () => {
    scaffold(vendors('CLAUDE.md: compiled'));
    fs.writeFileSync('CLAUDE.md', HAND_WRITTEN);
    const r = await runJson<TidyJson>(['tidy']);
    expect(r.json.warnings).toEqual(['CLAUDE.md is recorded as compiled but has no compile banner — skipping. If it is hand-authored: charter adf vendor set CLAUDE.md unmanaged. To regenerate it as compiled output instead (discards its hand-authored content): charter adf compile --target claude --write --force']);
  });

  it('skips a recorded-unmanaged pointer and explains it', async () => {
    scaffold(vendors('CLAUDE.md: unmanaged'));
    fs.writeFileSync('CLAUDE.md', BLOATED_CLAUDE);
    const r = await runJson<TidyJson>(['tidy']);
    expect(r.json.files[0]).toMatchObject({ status: 'unmanaged', skipReason: 'recorded-unmanaged' });
    expect(r.json.warnings).toEqual(['CLAUDE.md is unmanaged (recorded) — skipping. To move its rules into .ai/: charter adf migrate --source CLAUDE.md']);
    expect(read('CLAUDE.md')).toBe(BLOATED_CLAUDE);
  });

  it('reports a hand-authored file as unmanaged; the warning only when named with --source', async () => {
    scaffold();
    fs.writeFileSync('GEMINI.md', HAND_WRITTEN);
    const whole = await runJson<TidyJson>(['tidy', '--dry-run']);
    expect(whole.json.files).toEqual([expect.objectContaining({ file: 'GEMINI.md', status: 'unmanaged', skipReason: 'inferred-unmanaged', source: 'inferred' })]);
    expect(whole.json.warnings).toEqual([]);
    const named = await runJson<TidyJson>(['tidy', '--dry-run', '--source', 'GEMINI.md']);
    expect(named.json.warnings).toEqual(['GEMINI.md is unmanaged (inferred) — skipping. To move its rules into .ai/: charter adf migrate --source GEMINI.md']);
  });

  it('refuses a recorded pointer with no pointer marker rather than guessing', async () => {
    scaffold(vendors('CLAUDE.md: pointer'));
    fs.writeFileSync('CLAUDE.md', HAND_WRITTEN);
    const r = await runJson<TidyJson>(['tidy']);
    expect(r.json.files[0]).toMatchObject({ status: 'unmanaged', skipReason: 'recorded-pointer-no-marker' });
    expect(r.json.warnings).toEqual(['CLAUDE.md is recorded as a pointer but has no Charter pointer marker — skipping rather than guessing. See: charter adf vendor status']);
    expect(read('CLAUDE.md')).toBe(HAND_WRITTEN);
  });

  it('tidies a recorded or inferred pointer as before', async () => {
    scaffold(vendors('CLAUDE.md: pointer'));
    fs.writeFileSync('CLAUDE.md', BLOATED_CLAUDE);
    fs.writeFileSync('.cursorrules', POINTER_CURSORRULES);
    const r = await runJson<TidyJson>(['tidy']);
    expect(r.json.files.map(f => [f.file, f.status, f.skipReason, f.mode, f.source])).toEqual([
      ['CLAUDE.md', 'tidied', null, 'pointer', 'recorded'],
      ['.cursorrules', 'clean', null, 'pointer', 'inferred'],
    ]);
    expect(r.json.totalExtracted).toBeGreaterThan(0);
    expect(read('CLAUDE.md')).not.toContain('Always run pnpm test');
  });

  it('a non-vendor --source keeps the old marker logic', async () => {
    scaffold(vendors('CLAUDE.md: compiled'));
    fs.mkdirSync('docs');
    fs.writeFileSync('docs/NOTES.md', HAND_WRITTEN);
    const hand = await runJson<TidyJson>(['tidy', '--dry-run', '--source', 'docs/NOTES.md']);
    expect(hand.json.files[0]).toMatchObject({ status: 'not-found', vendorFile: null, mode: null, skipReason: null });
    fs.writeFileSync('docs/CLAUDE.md', BLOATED_CLAUDE);
    const pointer = await runJson<TidyJson>(['tidy', '--dry-run', '--source', 'docs/CLAUDE.md']);
    expect(pointer.json.files[0]).toMatchObject({ status: 'tidied', vendorFile: null });
    expect(pointer.json.totalExtracted).toBeGreaterThan(0);
  });

  it('walks AGENTS.md and agents.md once when they are one file (#302)', async () => {
    scaffold();
    aliasedAgents(`${POINTER_AGENTS_MD}\n## Testing\n\n- Always run pnpm test before pushing to main.\n`);
    const r = await runJson<TidyJson>(['tidy', '--dry-run']);
    expect(r.json.files.map(f => f.file)).toEqual(['AGENTS.md']);
  });

  it('handles a pointer-only name by mode (INV-P2-10)', async () => {
    scaffold(vendors('copilot-instructions.md: unmanaged'));
    fs.writeFileSync('copilot-instructions.md', POINTER_COPILOT_MD);
    const r = await runJson<TidyJson>(['tidy']);
    expect(r.json.files[0]).toMatchObject({ file: 'copilot-instructions.md', status: 'unmanaged', skipReason: 'recorded-unmanaged' });
    const check = await runJson<CheckJson>(['compile', '--target', 'all', '--check']);
    expect(check.json.targets.map(t => t.file)).toEqual(['CLAUDE.md', 'AGENTS.md', '.cursorrules', 'GEMINI.md']);
  });
});

// ============================================================================
// 4. Cross-cutting invariants
// ============================================================================

describe('read-only paths and quiet record problems', () => {
  it('INV-P2-6: tidy --dry-run, compile --check and compile stdout never write manifest.adf', async () => {
    scaffold(vendors('CLAUDE.md: pointer'));
    fs.writeFileSync('CLAUDE.md', BLOATED_CLAUDE);
    fs.writeFileSync('GEMINI.md', POINTER_GEMINI_MD);
    const before = manifestText();
    await run(['compile', '--target', 'all', '--check']);
    await run(['compile', '--target', 'claude']);
    await run(['tidy', '--dry-run']);
    await run(['tidy']);
    expect(manifestText()).toBe(before);
  });

  it('INV-P2-11: compile and tidy print no VENDORS entry-problem warnings', async () => {
    scaffold(vendors('CLAUDE.md pointer', 'NOTES.md: pointer', 'AGENTS.md: compiled', 'AGENTS.md: pointer'));
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    for (const args of [['compile', '--target', 'all', '--check'], ['compile', '--target', 'all', '--write'], ['tidy']]) {
      const r = await run(args);
      expect(`${r.out}\n${r.err}`).not.toMatch(/Ignoring VENDORS entry|duplicate|malformed|unknown-file/);
    }
  });
});

// ============================================================================
// 5. No-VENDORS regression and sync hint
// ============================================================================

describe('a compiled repo with no VENDORS behaves as before', () => {
  it('INV-P2-8: --write, --check and tidy text match the pre-#318 output', async () => {
    scaffold();
    const write = await run(['compile', '--target', 'all', '--write']);
    expect(write.code).toBe(0);
    expect(write.out).toBe(['  [ok] Written CLAUDE.md', '  [ok] Written AGENTS.md', '  [ok] Written .cursorrules', '  [ok] Written GEMINI.md'].join('\n'));
    expect(write.err).toBe('');

    // Strip the record the write added, so the next runs see no VENDORS at all.
    fs.writeFileSync('.ai/manifest.adf', BASE_MANIFEST);
    fs.writeFileSync('AGENTS.md', `${read('AGENTS.md')}\n# Extra stale content\n`);
    const check = await run(['compile', '--target', 'all', '--check']);
    expect(check.code).toBe(1);
    expect(check.out).toBe([
      '  [ok] CLAUDE.md is up-to-date',
      '  [stale] AGENTS.md — out of date with .ai/ source.\n          Run: charter adf compile --target agents --write',
      '  [ok] .cursorrules is up-to-date',
      '  [ok] GEMINI.md is up-to-date',
    ].join('\n'));

    const tidy = await run(['tidy']);
    expect(tidy.code).toBe(0);
    // Discovery order, as main walks a case-sensitive tree.
    expect(tidy.out).toBe(['CLAUDE.md', '.cursorrules', 'AGENTS.md', 'GEMINI.md'].map(f =>
      `  ⚠ ${f} is \`charter adf compile\` output, not a thin pointer — skipping. Its content is generated from .ai/, so tidy will not ingest it. Edit the .ai/ modules and re-run: charter adf compile --write`,
    ).join('\n'));
    expect(manifestText()).toBe(BASE_MANIFEST);
  });

  it('INV-P2-7: a no-VENDORS pointer repo tidies exactly as before', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', BLOATED_CLAUDE);
    const r = await run(['tidy']);
    expect(r.out).toContain('  Tidied 1 vendor file(s):');
    expect(r.out).toMatch(/ {4}CLAUDE\.md: \d+ items →/);
    expect(read('CLAUDE.md')).toBe(POINTER_CLAUDE_MD);
  });
});

describe('adf sync with no SYNC entries', () => {
  it('points to adf vendor status in text and JSON', async () => {
    scaffold();
    const hint = '  If `adf compile --check` reported a file as stale, that is about vendor modes, not SYNC. See: charter adf vendor status';
    const check = await run(['sync', '--check']);
    expect(check.out).toContain(hint);
    const write = await run(['sync', '--write']);
    expect(write.out).toContain('  [ok] Wrote empty lock file');
    expect(write.out).toContain(hint);
    const json = await runJson<{ nextActions: string[] }>(['sync', '--check']);
    expect(json.json.nextActions).toEqual(['charter adf vendor status']);
  });
});

/**
 * doctor, score and bootstrap read the vendor-mode record (#318, PR 3 of 6).
 *
 * Pins the PR3 contract: doctor's `adf vendor mode` check (one row per file,
 * worst-row status, `rows` in JSON), the mode-aware agent config / bloat / cold
 * start checks, score's compile-parity substantive rule, bootstrap's pointer
 * decision table and migrate filter, `adf migrate`'s recorded-unmanaged rules,
 * and `adf vendor restore`. Each INV-P3-n has at least one test that fails if
 * the invariant breaks.
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
  POINTER_CURSORRULES,
  POINTER_GEMINI_MD,
} from '../commands/adf';
import { doctorCommand, DOCTOR_MSG, ROW_STATUS } from '../commands/doctor';
import type { VendorModeRow } from '../commands/doctor';
import { scoreCommand, SCORE_POPULATE_AI_DIR } from '../commands/score';
import { bootstrapCommand, pointerAction } from '../commands/bootstrap';
import { restoredPointer } from '../commands/adf-vendor';

// doctor's `git repository` check must not depend on the host temp dir.
vi.mock('../git-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-helpers')>();
  return { ...actual, isGitRepo: () => true };
});

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
].join('\n');

const CORE_ADF = 'ADF: 0.1\n\n\u{1F4CB} CONTEXT:\n  - TypeScript monorepo built with pnpm workspaces\n  - Deployed to Cloudflare Workers\n\n⚠️ CONSTRAINTS [load-bearing]:\n  - No secrets in commits\n  - Run pnpm test before every push\n';
const STATE_ADF = 'ADF: 0.1\n\n\u{1F9E0} STATE:\n  CURRENT: Active development\n';

const BLOATED_CLAUDE = `${POINTER_CLAUDE_MD}\n## Testing\n\n- Always run pnpm test before pushing to main.\n- Never skip the integration suite in CI.\n`;
const HAND_WRITTEN = '# My CLAUDE.md\n\n## Rules\n\n- Always use pnpm for installs.\n- Never commit .env files.\n';
/** A pointer whose own text is thin: only a marker and a title. */
const THIN_CLAUDE = '# CLAUDE.md\n\nDo not duplicate rules from .ai/\n';

const originalCwd = process.cwd();
let tmp = '';
let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-vendor-pr3-'));
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

function scaffold(manifest = BASE_MANIFEST, core = CORE_ADF): void {
  fs.mkdirSync('.ai', { recursive: true });
  fs.writeFileSync('.ai/manifest.adf', manifest);
  fs.writeFileSync('.ai/core.adf', core);
  fs.writeFileSync('.ai/state.adf', STATE_ADF);
}

const manifestText = (): string => fs.readFileSync('.ai/manifest.adf', 'utf-8');
const read = (file: string): string => fs.readFileSync(file, 'utf-8');

/** Every file under .ai/ and every vendor file at the root, to prove a command wrote nothing. */
function snapshot(): Record<string, string> {
  const files = [
    ...fs.readdirSync('.ai').map(f => path.join('.ai', f)),
    ...['CLAUDE.md', 'AGENTS.md', 'agents.md', '.cursorrules', 'GEMINI.md', 'copilot-instructions.md'].filter(f => fs.existsSync(f)),
  ].sort();
  return Object.fromEntries(files.map(f => [f, read(f)]));
}

function aliasedAgents(content: string): void {
  fs.writeFileSync('agents.md', content);
  // A hard link is one physical file on every filesystem, so this is the same
  // fixture whether or not the host is case-insensitive.
  if (!fs.existsSync('AGENTS.md')) fs.linkSync('agents.md', 'AGENTS.md');
}

async function run(args: string[], options: CLIOptions = TEXT): Promise<{ code: number; out: string; err: string }> {
  out = [];
  err = [];
  const code = await adfCommand(options, args);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function compiledOutput(target: string): Promise<string> {
  return (await run(['compile', '--target', target])).out;
}

interface Check { name: string; status: string; details: string; rows?: VendorModeRow[] }
interface DoctorJson { status: string; checks: Check[] }

async function doctor(ci = false): Promise<{ code: number; json: DoctorJson; text: string }> {
  out = [];
  const code = await doctorCommand({ ...JSON_OPTS, ciMode: ci }, ['--adf-only']);
  const json = JSON.parse(out.join('\n')) as DoctorJson;
  out = [];
  await doctorCommand(TEXT, ['--adf-only']);
  return { code, json, text: out.join('\n') };
}

const check = (j: DoctorJson, name: string): Check | undefined => j.checks.find(c => c.name === name);
const vendorCheck = (j: DoctorJson): Check => {
  const c = check(j, 'adf vendor mode');
  if (!c) throw new Error('no adf vendor mode check');
  return c;
};

// ============================================================================
// 1. doctor: adf vendor mode
// ============================================================================

describe('doctor: adf vendor mode rows', () => {
  it('INV-P3-2: no VENDORS section gives one INFO line and no new WARN; --ci still exits 0', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD_HYBRID);
    fs.writeFileSync('AGENTS.md', POINTER_AGENTS_MD);
    fs.writeFileSync('GEMINI.md', `<!-- ${COMPILE_BANNER_MARKER} -->\nold\n`);
    const r = await doctor(true);
    expect(r.code).toBe(0);
    const c = vendorCheck(r.json);
    expect(c.status).toBe('INFO');
    expect(c.rows?.map(x => [x.kind, x.file, x.status])).toEqual([
      ['inferred', 'CLAUDE.md', 'INFO'], ['inferred', 'AGENTS.md', 'INFO'], ['inferred', 'GEMINI.md', 'INFO'],
    ]);
    expect(c.details).toBe('3 vendor file(s) have no recorded mode (CLAUDE.md, AGENTS.md, GEMINI.md); modes are inferred from file content. Record them with: charter adf vendor init');
    expect(r.json.checks.filter(x => x.status === 'WARN')).toEqual([]);
    // Text mode prints it as an [info] line.
    expect(r.text).toContain('  [info] adf vendor mode: 3 vendor file(s) have no recorded mode');
  });

  it('INV-P3-2: every other check keeps its status for a no-VENDORS repo', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', HAND_WRITTEN);
    fs.writeFileSync('AGENTS.md', `${POINTER_AGENTS_MD}\n${Array.from({ length: 90 }, (_, i) => `line ${i}`).join('\n')}\n`);
    fs.writeFileSync('GEMINI.md', `<!-- ${COMPILE_BANNER_MARKER} -->\nold\n`);
    const r = await doctor();
    const statuses = Object.fromEntries(r.json.checks.filter(c => c.name !== 'adf vendor mode').map(c => [c.name, c.status]));
    // The statuses main @ 9ce61b4 gives for these files.
    expect(statuses).toMatchObject({
      'adf agent config': 'WARN',
      'adf vendor bloat': 'WARN',
      'adf manifest parse': 'PASS',
    });
    expect(check(r.json, 'adf agent config')?.details).toBe('CLAUDE.md contains stack rules that should live in .ai/. Run: charter adf migrate --dry-run');
    expect(check(r.json, 'adf vendor bloat')?.details).toContain('AGENTS.md: ');
    expect(vendorCheck(r.json).status).toBe('INFO');
  });

  it('recorded-ok: every row PASS gives the all-recorded line and a PASS check', async () => {
    scaffold(vendors('CLAUDE.md: pointer', 'AGENTS.md: unmanaged', 'GEMINI.md: compiled'));
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD_HYBRID);
    fs.writeFileSync('AGENTS.md', '# My agents\n');
    fs.writeFileSync('GEMINI.md', await compiledOutput('gemini'));
    const r = await doctor(true);
    expect(r.code).toBe(0);
    const c = vendorCheck(r.json);
    expect(c.status).toBe('PASS');
    expect(c.rows?.every(x => x.kind === 'recorded-ok' && x.status === 'PASS')).toBe(true);
    expect(c.details).toBe('All 3 vendor file(s) have a recorded mode that matches the file on disk.');
  });

  it('recorded-drift (pointer recorded, compiled on disk) WARNs, fails --ci, and the restore remedy clears it', async () => {
    scaffold(vendors('CLAUDE.md: pointer'));
    fs.writeFileSync('CLAUDE.md', await compiledOutput('claude'));
    const before = await doctor(true);
    expect(before.code).toBe(1);
    const c = vendorCheck(before.json);
    expect(c.status).toBe('WARN');
    expect(c.rows?.[0]).toEqual({
      kind: 'recorded-drift', status: 'WARN', file: 'CLAUDE.md', recordedMode: 'pointer', inferredMode: 'compiled',
      source: 'recorded', raw: null, remedy: 'charter adf vendor set CLAUDE.md compiled',
    });
    expect(c.details).toBe('CLAUDE.md is recorded as a pointer but looks compiled on disk. Accept the file: charter adf vendor set CLAUDE.md compiled  (or rewrite the pointer: charter adf vendor restore CLAUDE.md)');

    expect((await run(['vendor', 'restore', 'CLAUDE.md'])).code).toBe(0);
    const after = await doctor(true);
    expect(after.code).toBe(0);
    expect(vendorCheck(after.json)).toMatchObject({ status: 'PASS' });
  });

  it('recorded-drift (compiled recorded): the content-preserving fix comes first and the loss is named', async () => {
    scaffold(vendors('CLAUDE.md: compiled', 'AGENTS.md: compiled'));
    fs.writeFileSync('CLAUDE.md', BLOATED_CLAUDE);
    fs.writeFileSync('AGENTS.md', '# Agents I wrote\n');
    const c = vendorCheck((await doctor()).json);
    const lines = c.details.split('\n    ');
    expect(lines[0]).toMatch(/^CLAUDE\.md is recorded as compiled but looks pointer on disk\. Accept the file: charter adf vendor set CLAUDE\.md pointer {2}\(or regenerate it: charter adf compile --target claude --write; discards \d+ item\(s\) not in \.ai\/\)$/);
    expect(lines[1]).toBe('AGENTS.md is recorded as compiled but looks unmanaged on disk. Accept the file: charter adf vendor set AGENTS.md unmanaged  (or regenerate it: charter adf compile --target agents --write --force; discards its hand-authored content)');
    expect(c.rows?.map(x => x.remedy)).toEqual(['charter adf vendor set CLAUDE.md pointer', 'charter adf vendor set AGENTS.md unmanaged']);
  });

  it('recorded-absent WARNs with the mode-specific recreate command; recorded-unmanaged-absent is PASS', async () => {
    scaffold(vendors('CLAUDE.md: pointer', 'GEMINI.md: compiled', 'AGENTS.md: unmanaged'));
    const r = await doctor(true);
    expect(r.code).toBe(1);
    const c = vendorCheck(r.json);
    expect(c.rows?.map(x => [x.kind, x.status, x.inferredMode])).toEqual([
      ['recorded-absent', 'WARN', null], ['recorded-unmanaged-absent', 'PASS', null], ['recorded-absent', 'WARN', null],
    ]);
    expect(c.details.split('\n    ')).toEqual([
      'CLAUDE.md is recorded as pointer but is not on disk. Recreate it: charter adf vendor restore CLAUDE.md  (or stop tracking it: charter adf vendor set CLAUDE.md unmanaged)',
      'GEMINI.md is recorded as compiled but is not on disk. Recreate it: charter adf compile --target gemini --write  (or stop tracking it: charter adf vendor set GEMINI.md unmanaged)',
    ]);
    // Both recreate commands work.
    expect((await run(['vendor', 'restore', 'CLAUDE.md'])).code).toBe(0);
    expect((await run(['compile', '--target', 'gemini', '--write'])).code).toBe(0);
    expect(vendorCheck((await doctor()).json).status).toBe('PASS');
  });

  it('entry problems: malformed, unknown-file and mode-not-allowed WARN; a duplicate is INFO', async () => {
    scaffold(vendors('CLAUDE.md pointer', 'README.md: pointer', 'copilot-instructions.md: compiled', 'AGENTS.md: pointer', 'AGENTS.md: unmanaged'));
    const manifestPath = path.join('.ai', 'manifest.adf');
    const c = vendorCheck((await doctor()).json);
    const problems = c.rows?.filter(x => x.kind === 'entry-problem') ?? [];
    expect(problems.map(x => [x.raw, x.status, x.file])).toEqual([
      ['CLAUDE.md pointer', 'WARN', 'CLAUDE.md'],
      ['README.md: pointer', 'WARN', null],
      ['copilot-instructions.md: compiled', 'WARN', 'copilot-instructions.md'],
      ['AGENTS.md: pointer', 'INFO', 'AGENTS.md'],
    ]);
    expect(c.status).toBe('WARN');
    expect(c.details).toContain(`VENDORS entry 'README.md: pointer' in ${manifestPath} is ignored (unknown-file). Fix or delete that line in ${manifestPath}.`);
    expect(c.details).toContain(`VENDORS lists AGENTS.md more than once in ${manifestPath}; 'AGENTS.md: pointer' is ignored because a later entry wins. Delete that line.`);
  });

  it('following the duplicate advice keeps the resolved mode', async () => {
    scaffold(vendors('AGENTS.md: pointer', 'AGENTS.md: unmanaged'));
    fs.writeFileSync('AGENTS.md', '# Agents I wrote\n');
    const before = vendorCheck((await doctor()).json);
    const resolved = before.rows?.find(x => x.file === 'AGENTS.md' && x.kind !== 'entry-problem')?.recordedMode;
    expect(resolved).toBe('unmanaged');
    const dup = before.rows?.find(x => x.kind === 'entry-problem');
    expect(before.details).toContain(`'${dup?.raw}' is ignored because a later entry wins. Delete that line.`);
    // Delete exactly the line the advice names.
    fs.writeFileSync('.ai/manifest.adf', manifestText().replace(`  - ${dup?.raw}\n`, ''));
    const after = vendorCheck((await doctor()).json);
    expect(after.rows?.map(x => [x.kind, x.recordedMode])).toEqual([['recorded-ok', resolved]]);
  });

  it('a duplicate alone is INFO, so --ci passes (worst-row aggregation)', async () => {
    scaffold(vendors('CLAUDE.md: pointer', 'CLAUDE.md: pointer'));
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD_HYBRID);
    const r = await doctor(true);
    expect(r.code).toBe(0);
    expect(vendorCheck(r.json).status).toBe('INFO');
    expect(vendorCheck(r.json).rows?.map(x => x.status)).toEqual(['PASS', 'INFO']);
  });

  it('alias-recorded and legacy-spelling are INFO rows', async () => {
    scaffold(vendors('AGENTS.md: pointer', 'agents.md: pointer'));
    aliasedAgents(POINTER_AGENTS_MD);
    let c = vendorCheck((await doctor(true)).json);
    expect(c.rows?.map(x => [x.kind, x.file, x.status])).toEqual([['recorded-ok', 'AGENTS.md', 'PASS'], ['alias-recorded', 'agents.md', 'INFO']]);
    expect(c.details).toBe('VENDORS records both AGENTS.md and agents.md, which are the same file on disk; AGENTS.md is used. Delete the agents.md line.');

    fs.writeFileSync('.ai/manifest.adf', vendors('agents.md: pointer'));
    c = vendorCheck((await doctor(true)).json);
    expect(c.rows?.map(x => [x.kind, x.file, x.status])).toEqual([['recorded-ok', 'agents.md', 'PASS'], ['legacy-spelling', 'agents.md', 'INFO']]);
    expect(c.details).toBe("VENDORS records the legacy name agents.md for the file AGENTS.md; `adf compile --target agents --mode compiled` cannot switch it. Change the line to '  - AGENTS.md: pointer' (an automatic rename comes with #302).");
  });

  it('section-not-list WARNs once', async () => {
    scaffold(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS: not a list\n`);
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD_HYBRID);
    const r = await doctor(true);
    expect(r.code).toBe(1);
    const c = vendorCheck(r.json);
    expect(c.rows?.map(x => x.kind)).toEqual(['section-not-list']);
    expect(c.details).toBe(`VENDORS in ${path.join('.ai', 'manifest.adf')} does not read as a list, so every vendor mode is inferred. Every line under it must look like "  - CLAUDE.md: pointer".`);
  });

  it('INV-P3-3: inferred modes never WARN, whatever the files look like', () => {
    expect(ROW_STATUS.inferred).toBe('INFO');
    const warnKinds = Object.entries(ROW_STATUS).filter(([, s]) => s === 'WARN').map(([k]) => k).sort();
    expect(warnKinds).toEqual(['entry-problem', 'recorded-absent', 'recorded-drift', 'section-not-list']);
  });

  it('INV-P3-3: a mixed no-record repo (hand-authored, bloated, compiled) has an INFO vendor mode check', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', HAND_WRITTEN);
    fs.writeFileSync('AGENTS.md', `${POINTER_AGENTS_MD}\n## Testing\n\n- Always run pnpm test.\n`);
    fs.writeFileSync('.cursorrules', `<!-- ${COMPILE_BANNER_MARKER} -->\n`);
    expect(vendorCheck((await doctor()).json).status).toBe('INFO');
  });

  it('INV-P3-12: only the adf vendor mode check carries rows, with exactly the row schema keys', async () => {
    scaffold(vendors('CLAUDE.md: pointer'));
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD_HYBRID);
    const { json } = await doctor();
    for (const c of json.checks) {
      expect(Object.keys(c)).toEqual(c.name === 'adf vendor mode' ? ['name', 'status', 'details', 'rows'] : ['name', 'status', 'details']);
    }
    expect(Object.keys(vendorCheck(json).rows?.[0] ?? {})).toEqual(['kind', 'status', 'file', 'recordedMode', 'inferredMode', 'source', 'raw', 'remedy']);
  });

  it('is not emitted when the manifest is missing, and adds nothing with no vendor files', async () => {
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD_HYBRID);
    expect(check((await doctor()).json, 'adf vendor mode')).toBeUndefined();
    scaffold();
    fs.rmSync('CLAUDE.md');
    expect(check((await doctor()).json, 'adf vendor mode')).toBeUndefined();
  });

  it('INV-P3-1: doctor writes neither the manifest nor any vendor file', async () => {
    scaffold(vendors('CLAUDE.md: pointer', 'AGENTS.md: compiled', 'README.md: x'));
    fs.writeFileSync('CLAUDE.md', await compiledOutput('claude'));
    fs.writeFileSync('GEMINI.md', HAND_WRITTEN);
    aliasedAgents(POINTER_AGENTS_MD);
    const before = snapshot();
    await doctor(true);
    await doctorCommand(TEXT, []);
    expect(snapshot()).toEqual(before);
  });
});

// ============================================================================
// 2. doctor: mode-aware agent config, bloat and cold start
// ============================================================================

describe('doctor: agent config, bloat and cold start read the record', () => {
  it('a recorded-unmanaged hand-authored file drops the agent-config WARN', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', HAND_WRITTEN);
    expect(check((await doctor()).json, 'adf agent config')?.status).toBe('WARN');
    fs.writeFileSync('.ai/manifest.adf', vendors('CLAUDE.md: unmanaged'));
    const c = check((await doctor()).json, 'adf agent config');
    expect(c).toEqual({
      name: 'adf agent config', status: 'PASS',
      details: '0 thin pointer(s) and 0 compiled file(s) route to .ai/; 1 file(s) recorded unmanaged are left alone.',
    });
  });

  it('PASS wording counts pointers and compiled files separately', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD_HYBRID);
    fs.writeFileSync('.cursorrules', POINTER_CURSORRULES);
    fs.writeFileSync('GEMINI.md', await compiledOutput('gemini'));
    expect(check((await doctor()).json, 'adf agent config')?.details).toBe('2 thin pointer(s) and 1 compiled file(s) route to .ai/.');
  });

  it('walks AGENTS.md and agents.md once when they are one file', async () => {
    scaffold();
    aliasedAgents(`${POINTER_AGENTS_MD}\n${Array.from({ length: 90 }, (_, i) => `line ${i}`).join('\n')}\n`);
    const { json } = await doctor();
    expect(check(json, 'adf agent config')?.details).toBe('1 thin pointer(s) and 0 compiled file(s) route to .ai/.');
    const bloat = check(json, 'adf vendor bloat')?.details ?? '';
    expect(bloat.match(/agents\.md: /gi)).toHaveLength(1);
    expect(vendorCheck(json).rows).toHaveLength(1);

    // Hand-authored: listed once in the WARN, not as "agents.md, AGENTS.md".
    aliasedAgents('# Agents I wrote\n');
    expect(check((await doctor()).json, 'adf agent config')?.details).toBe('AGENTS.md contains stack rules that should live in .ai/. Run: charter adf migrate --dry-run');
  });

  it('bloat and cold start scan pointers only: a recorded-compiled or recorded-unmanaged pointer-shaped file is not scanned', async () => {
    scaffold(BASE_MANIFEST.replace('  - state.adf\n', ''));
    fs.rmSync('.ai/state.adf');
    const bloated = `${POINTER_AGENTS_MD}\n${Array.from({ length: 90 }, (_, i) => `line ${i}`).join('\n')}\n`;
    fs.writeFileSync('AGENTS.md', bloated);
    expect(check((await doctor()).json, 'adf vendor bloat')?.status).toBe('WARN');
    fs.writeFileSync('.ai/manifest.adf', `${BASE_MANIFEST.replace('  - state.adf\n', '')}\n\u{1F3F7} VENDORS:\n  - AGENTS.md: unmanaged\n`);
    const { json } = await doctor();
    expect(check(json, 'adf vendor bloat')).toBeUndefined();
    expect(check(json, 'adf cold start')).toBeUndefined();
  });

  it('cold start no longer counts compiled output as a thin pointer', async () => {
    fs.mkdirSync('.ai', { recursive: true });
    // No modules at all: cold start applies to a short, keyword-free pointer.
    fs.writeFileSync('.ai/manifest.adf', 'ADF: 0.1\n\n\u{1F3AF} ROLE: Test\n');
    fs.writeFileSync('GEMINI.md', `<!-- ${COMPILE_BANNER_MARKER} -->\nold\n`);
    fs.writeFileSync('.cursorrules', POINTER_CURSORRULES);
    const cold = (await doctor()).json.checks.filter(c => c.name === 'adf cold start');
    expect(cold.map(c => c.details.split(' ')[0])).toEqual(['.cursorrules']);
  });
});

// ============================================================================
// 3. score
// ============================================================================

interface AgentSignal { exists: boolean; substantive: boolean; mode: string | null; source: string | null; substantiveVia: string }
interface ScoreJson {
  score: { total: number };
  categories: Array<{ id: string; score: number; summary: string }>;
  recommendations: string[];
  signals: {
    agentConfig: { claude: AgentSignal; cursorRules: AgentSignal & { files: string[] }; agents: AgentSignal & { file?: string } };
    grounding: { pathReferences: { broken: string[] } };
  };
}

async function score(): Promise<ScoreJson> {
  out = [];
  await scoreCommand(JSON_OPTS, []);
  return JSON.parse(out.join('\n')) as ScoreJson;
}

describe('score: a pointer is as substantive as the compiled file it routes to', () => {
  it('a thin pointer with a populated .ai/ gains substantive via ai-dir, and no Expand recommendation', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', THIN_CLAUDE);
    const j = await score();
    expect(j.signals.agentConfig.claude).toEqual({ exists: true, substantive: true, mode: 'pointer', source: 'inferred', substantiveVia: 'ai-dir' });
    expect(j.recommendations.join('\n')).not.toContain('Expand `CLAUDE.md`');
    expect(j.categories.find(c => c.id === 'agent-config')?.summary).toContain('CLAUDE.md is a thin pointer to .ai/');
  });

  it('INV-P3-7: score never decreases, against the text-only (main) rule, across fixtures', async () => {
    const fixtures: Array<{ name: string; setup: () => Promise<void> | void }> = [
      { name: 'thin pointer', setup: () => { scaffold(); fs.writeFileSync('CLAUDE.md', THIN_CLAUDE); fs.writeFileSync('.cursorrules', POINTER_CURSORRULES); } },
      { name: 'hybrid pointer', setup: () => { scaffold(); fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD_HYBRID); fs.writeFileSync('AGENTS.md', POINTER_AGENTS_MD); } },
      { name: 'compiled', setup: async () => { scaffold(); fs.writeFileSync('CLAUDE.md', await compiledOutput('claude')); } },
      { name: 'unmanaged', setup: () => { scaffold(); fs.writeFileSync('CLAUDE.md', '# Mine\n'); } },
      {
        // A monorepo with per-package agent files: the basenames are not unique.
        name: 'monorepo', setup: () => {
          scaffold();
          fs.writeFileSync('CLAUDE.md', THIN_CLAUDE);
          fs.mkdirSync(path.join('packages', 'a'), { recursive: true });
          fs.writeFileSync(path.join('packages', 'a', 'CLAUDE.md'), '# Package a\n');
          fs.writeFileSync(path.join('packages', 'a', 'AGENTS.md'), '# Package a\n');
        },
      },
      { name: 'empty .ai/', setup: () => { fs.mkdirSync('.ai'); fs.writeFileSync('.ai/manifest.adf', BASE_MANIFEST); fs.writeFileSync('CLAUDE.md', THIN_CLAUDE); fs.writeFileSync('.cursorrules', POINTER_CURSORRULES); } },
    ];
    for (const fixture of fixtures) {
      for (const f of ['CLAUDE.md', '.cursorrules', 'AGENTS.md', 'packages']) fs.rmSync(f, { recursive: true, force: true });
      fs.rmSync('.ai', { recursive: true, force: true });
      await fixture.setup();
      const now = await score();
      // Recording every file unmanaged applies the text-only rule main used for all of them.
      const manifest = manifestText();
      fs.writeFileSync('.ai/manifest.adf', `${manifest}\n\u{1F3F7} VENDORS:\n  - CLAUDE.md: unmanaged\n  - .cursorrules: unmanaged\n  - AGENTS.md: unmanaged\n`);
      const main = await score();
      fs.writeFileSync('.ai/manifest.adf', manifest);
      const flags = (j: ScoreJson) => [j.signals.agentConfig.claude, j.signals.agentConfig.cursorRules, j.signals.agentConfig.agents].map(s => s.substantive);
      expect(now.score.total, fixture.name).toBeGreaterThanOrEqual(main.score.total);
      flags(now).forEach((v, i) => expect(Number(v), `${fixture.name} #${i}`).toBeGreaterThanOrEqual(Number(flags(main)[i])));
    }
  });

  it('the thin-pointer fixture scores strictly higher than the text-only rule (+5 per file)', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', THIN_CLAUDE);
    fs.writeFileSync('.cursorrules', POINTER_CURSORRULES);
    const now = await score();
    fs.writeFileSync('.ai/manifest.adf', vendors('CLAUDE.md: unmanaged', '.cursorrules: unmanaged'));
    const main = await score();
    const agentConfig = (j: ScoreJson) => j.categories.find(c => c.id === 'agent-config')?.score ?? 0;
    expect(agentConfig(now) - agentConfig(main)).toBe(8); // CLAUDE.md +5, .cursorrules 2 -> 5
    expect(now.signals.agentConfig.cursorRules).toMatchObject({ substantive: true, mode: 'pointer', substantiveVia: 'ai-dir', files: ['.cursorrules'] });
  });

  it('INV-P3-8: a thin pointer or compiled CLAUDE.md is never told to be hand-edited', async () => {
    // A pointer to an .ai/ with nothing to compile: not substantive either way.
    fs.mkdirSync('.ai');
    fs.writeFileSync('.ai/manifest.adf', BASE_MANIFEST);
    fs.writeFileSync('CLAUDE.md', THIN_CLAUDE);
    let j = await score();
    expect(j.signals.agentConfig.claude).toMatchObject({ substantive: false, mode: 'pointer', substantiveVia: 'none' });
    const populate = SCORE_POPULATE_AI_DIR.replace('{file}', 'CLAUDE.md').replace(/\{aiDir\}/g, '.ai');
    expect(j.recommendations).toContain(populate);
    for (const rec of j.recommendations) expect(rec).not.toMatch(/`CLAUDE\.md`(?! routes)/);

    fs.writeFileSync('CLAUDE.md', `<!-- ${COMPILE_BANNER_MARKER} -->\n`);
    j = await score();
    expect(j.signals.agentConfig.claude).toMatchObject({ substantive: false, mode: 'compiled', substantiveVia: 'none' });
    expect(j.recommendations).toContain(populate);
    for (const rec of j.recommendations) expect(rec).not.toMatch(/`CLAUDE\.md`(?! routes)/);
  });

  it('a thin hand-authored CLAUDE.md keeps the Expand recommendation', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', '# Mine\n');
    const j = await score();
    expect(j.signals.agentConfig.claude).toMatchObject({ substantive: false, mode: 'unmanaged', substantiveVia: 'none' });
    expect(j.recommendations.join('\n')).toContain('Expand `CLAUDE.md` beyond a thin pointer');
  });

  it('additive JSON: existing keys keep their place; .cursor/rules has no mode', async () => {
    scaffold();
    fs.mkdirSync('.cursor/rules', { recursive: true });
    fs.writeFileSync('.cursor/rules/a.mdc', 'Always run pnpm lint before committing changes to this repository.\nKeep it tidy.\nThird line.\n');
    const j = await score();
    expect(Object.keys(j.signals.agentConfig.claude)).toEqual(['exists', 'substantive', 'mode', 'source', 'substantiveVia']);
    expect(j.signals.agentConfig.claude).toEqual({ exists: false, substantive: false, mode: null, source: null, substantiveVia: 'none' });
    expect(j.signals.agentConfig.cursorRules).toEqual({ exists: true, substantive: true, mode: null, source: null, substantiveVia: 'file', files: ['.cursor/rules/a.mdc'] });
  });

  it('VENDORS stays out of path grounding, and score writes nothing (INV-P3-1)', async () => {
    scaffold(vendors('CLAUDE.md: pointer', 'copilot-instructions.md: pointer'));
    fs.writeFileSync('CLAUDE.md', THIN_CLAUDE);
    const before = snapshot();
    const j = await score();
    expect(j.signals.grounding.pathReferences.broken.join(' ')).not.toContain('copilot-instructions.md');
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync('.ai/.adf.lock')).toBe(false);
  });
});

// ============================================================================
// 4. bootstrap
// ============================================================================

describe('bootstrap: pointer decision table', () => {
  const table: Array<{ record: string | null; content: string | null; noForce: string; force: string }> = [
    { record: 'compiled', content: 'BANNER', noForce: 'skip-compiled', force: 'skip-compiled' },
    { record: 'compiled', content: null, noForce: 'skip-recorded-compiled-absent', force: 'skip-recorded-compiled-absent' },
    { record: 'compiled', content: POINTER_CLAUDE_MD_HYBRID, noForce: 'skip-compiled', force: 'skip-compiled' },
    { record: null, content: 'BANNER', noForce: 'skip-compiled', force: 'skip-compiled' },
    { record: 'pointer', content: 'BANNER', noForce: 'skip-compiled', force: 'skip-compiled' },
    { record: 'unmanaged', content: HAND_WRITTEN, noForce: 'skip-recorded-unmanaged', force: 'skip-recorded-unmanaged' },
    { record: 'unmanaged', content: null, noForce: 'skip-recorded-unmanaged', force: 'skip-recorded-unmanaged' },
    { record: null, content: null, noForce: 'write-pointer', force: 'write-pointer' },
    { record: 'pointer', content: null, noForce: 'write-pointer', force: 'write-pointer' },
    { record: null, content: HAND_WRITTEN, noForce: 'skip-custom', force: 'skip-custom' },
    { record: 'pointer', content: HAND_WRITTEN, noForce: 'skip-custom', force: 'skip-custom' },
    { record: null, content: POINTER_CLAUDE_MD_HYBRID, noForce: 'keep-managed', force: 'write-pointer' },
    { record: 'pointer', content: POINTER_CLAUDE_MD_HYBRID, noForce: 'keep-managed', force: 'write-pointer' },
  ];

  it('every row, with and without --force (INV-P3-4, INV-P3-5)', () => {
    for (const row of table) {
      scaffold(row.record ? vendors(`CLAUDE.md: ${row.record}`) : BASE_MANIFEST);
      fs.rmSync('CLAUDE.md', { force: true });
      if (row.content) fs.writeFileSync('CLAUDE.md', row.content === 'BANNER' ? `<!-- ${COMPILE_BANNER_MARKER} -->\nold\n` : row.content);
      const label = `${row.record ?? 'none'} / ${row.content ? row.content.slice(0, 12) : 'absent'}`;
      expect(pointerAction('.ai', 'CLAUDE.md', false), label).toBe(row.noForce);
      expect(pointerAction('.ai', 'CLAUDE.md', true), `${label} --force`).toBe(row.force);
    }
  });

  it('INV-P3-4: bootstrap --force leaves a compiled CLAUDE.md alone and says how to make it a pointer', async () => {
    fs.mkdirSync('.ai');
    const compiled = `<!-- ${COMPILE_BANNER_MARKER} -->\nold compiled\n`;
    fs.writeFileSync('CLAUDE.md', compiled);
    out = [];
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--force', '--yes', '--skip-install', '--skip-doctor', '--format', 'json'])).toBe(0);
    expect(read('CLAUDE.md')).toBe(compiled);
    const payload = JSON.parse(out.join('\n')) as { steps: Array<{ name: string; warnings: string[] }> };
    expect(payload.steps.find(s => s.name === 'adf-init')?.warnings).toContain(
      'CLAUDE.md is compiled output from .ai/ (compile banner); bootstrap will not replace it with a pointer. To make it a pointer: charter adf vendor set CLAUDE.md pointer && charter adf vendor restore CLAUDE.md',
    );
    // No pointer was recorded for it.
    expect(manifestText()).not.toContain('CLAUDE.md: pointer');
  });

  it('INV-P3-5: a hand-authored CLAUDE.md survives --force --yes, is migrated in phase 4, and is recorded pointer after', async () => {
    fs.writeFileSync('CLAUDE.md', HAND_WRITTEN);
    out = [];
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--force', '--yes', '--skip-install', '--skip-doctor', '--format', 'json'])).toBe(0);
    const payload = JSON.parse(out.join('\n')) as { steps: Array<{ name: string; warnings: string[]; details: Record<string, unknown> }> };
    const init = payload.steps.find(s => s.name === 'adf-init');
    expect(init?.warnings).toContain("CLAUDE.md has custom content; skipping pointer even with --force, because bootstrap does not back up vendor files. Phase 4 below migrates its rules into .ai/ and then writes the pointer.");
    expect(init?.details.pointers).not.toContain('CLAUDE.md (hybrid pointer)');
    const migrate = payload.steps.find(s => s.name === 'migrate');
    expect(migrate?.details).toMatchObject({ sources: ['CLAUDE.md'], migrated: 1 });
    // The rules moved into .ai/, the file is now a pointer, and the record followed.
    const ai = fs.readdirSync('.ai').filter(f => f.endsWith('.adf')).map(f => read(path.join('.ai', f))).join('\n');
    expect(ai).toContain('Never commit .env files');
    expect(read('CLAUDE.md')).toContain('DO NOT add rules, constraints, or context to this file');
    expect(manifestText()).toContain('  - CLAUDE.md: pointer\n');
    expect(fs.readFileSync('CLAUDE.md.pre-adf-migrate.bak', 'utf-8')).toBe(HAND_WRITTEN);
  });

  it('INV-P3-6: bootstrap neither overwrites nor migrates a recorded-unmanaged file', async () => {
    scaffold(vendors('CLAUDE.md: unmanaged'));
    fs.writeFileSync('CLAUDE.md', HAND_WRITTEN);
    out = [];
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, ['--force', '--yes', '--skip-install', '--skip-doctor', '--format', 'json'])).toBe(0);
    expect(read('CLAUDE.md')).toBe(HAND_WRITTEN);
    const payload = JSON.parse(out.join('\n')) as { steps: Array<{ name: string; warnings: string[]; status: string }> };
    expect(payload.steps.find(s => s.name === 'adf-init')?.warnings).toContain('CLAUDE.md is recorded as unmanaged; leaving it as is.');
    const migrate = payload.steps.find(s => s.name === 'migrate');
    expect(migrate?.status).toBe('skip');
    expect(migrate?.warnings).toContain('CLAUDE.md is recorded as unmanaged; not migrating. To migrate it anyway: charter adf migrate --source CLAUDE.md');
    // --force re-scaffolds manifest.adf; the record is carried over.
    expect(manifestText()).toContain('  - CLAUDE.md: unmanaged\n');
    expect(fs.readdirSync('.ai/.backup').some(f => f.startsWith('manifest.adf.'))).toBe(true);
  });

  it('--force carries every valid record entry over the re-scaffolded manifest', async () => {
    scaffold(vendors('GEMINI.md: compiled', 'AGENTS.md: unmanaged', 'CLAUDE.md: pointer'));
    await bootstrapCommand({ ...TEXT, yes: true }, ['--force', '--yes', '--skip-install', '--skip-doctor']);
    const record = manifestText().slice(manifestText().indexOf('VENDORS:'));
    expect(record).toBe('VENDORS:\n  - GEMINI.md: compiled\n  - AGENTS.md: unmanaged\n  - CLAUDE.md: pointer\n  - .cursorrules: pointer\n  - copilot-instructions.md: pointer\n');
    expect(fs.existsSync('GEMINI.md')).toBe(false);
    expect(fs.existsSync('AGENTS.md')).toBe(false);
  });

  it('without --force, the custom-content warning is unchanged (#305)', async () => {
    fs.writeFileSync('AGENTS.md', '# Agents\n\n- Always run the linter.\n');
    await bootstrapCommand(TEXT, ['--skip-install', '--skip-doctor']);
    expect(out.join('\n')).toContain("AGENTS.md has custom content; skipping pointer. Run 'charter adf migrate --source AGENTS.md'");
  });
});

// ============================================================================
// 5. adf migrate
// ============================================================================

describe('adf migrate and recorded unmanaged', () => {
  it('INV-P3-6: bare discovery skips a recorded-unmanaged file (text and JSON) and leaves it untouched', async () => {
    scaffold(vendors('CLAUDE.md: unmanaged'));
    fs.writeFileSync('CLAUDE.md', HAND_WRITTEN);
    fs.writeFileSync('GEMINI.md', '# Gemini\n\n## Rules\n\n- Prefer small diffs.\n');
    const text = await run(['migrate', '--no-backup']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('Skipped: CLAUDE.md is recorded as unmanaged; skipped. Name it explicitly to migrate it: charter adf migrate --source CLAUDE.md');
    expect(read('CLAUDE.md')).toBe(HAND_WRITTEN);
    // GEMINI.md, not named and not recorded, is still migrated.
    expect(read('GEMINI.md')).not.toContain('Prefer small diffs');
    const json = await run(['migrate', '--dry-run', '--format', 'json'], JSON_OPTS);
    const parsed = JSON.parse(json.out) as { sources: Array<{ source: string; skipped: boolean; skipReason?: string }> };
    expect(parsed.sources.find(s => s.source === 'CLAUDE.md')).toMatchObject({ skipped: true });
  });

  it('CP-6: explicit --source migrates it and upserts pointer, so doctor shows no drift', async () => {
    scaffold(vendors('CLAUDE.md: unmanaged'));
    fs.writeFileSync('CLAUDE.md', HAND_WRITTEN);
    const r = await run(['migrate', '--source', 'CLAUDE.md', '--no-backup']);
    expect(r.code).toBe(0);
    expect(manifestText()).toBe(vendors('CLAUDE.md: pointer'));
    expect(read('CLAUDE.md')).toContain('DO NOT add rules, constraints, or context to this file');
    const c = vendorCheck((await doctor()).json);
    expect(c.rows?.map(x => x.kind)).toEqual(['recorded-ok']);
  });

  it('record before write: a failed migration restores the unmanaged entry', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    scaffold(vendors('CLAUDE.md: unmanaged'));
    fs.writeFileSync('CLAUDE.md', HAND_WRITTEN);
    fs.chmodSync('CLAUDE.md', 0o444);
    try {
      await expect(run(['migrate', '--source', 'CLAUDE.md', '--no-backup'])).rejects.toThrow();
      expect(manifestText()).toBe(vendors('CLAUDE.md: unmanaged'));
      expect(read('CLAUDE.md')).toBe(HAND_WRITTEN);
    } finally {
      fs.chmodSync('CLAUDE.md', 0o644);
    }
  });

  it('an explicit --source on an unrecorded file records add-if-absent as before', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', HAND_WRITTEN);
    expect((await run(['migrate', '--source', 'CLAUDE.md', '--no-backup'])).code).toBe(0);
    expect(manifestText()).toBe(vendors('CLAUDE.md: pointer'));
  });
});

// ============================================================================
// 6. adf vendor restore
// ============================================================================

interface RestoreJson { file: string; status: string; refusal: string | null; keptSections: string[]; remedy: string | null; writeError: string | null }

async function restore(file: string, extra: string[] = []): Promise<{ code: number; json: RestoreJson; err: string }> {
  const r = await run(['vendor', 'restore', file, ...extra, '--format', 'json'], JSON_OPTS);
  return { code: r.code, json: JSON.parse(r.out) as RestoreJson, err: r.err };
}

describe('adf vendor restore', () => {
  it('refuses a recorded compiled or unmanaged file, and an inferred compiled one (mode-not-pointer)', async () => {
    scaffold(vendors('CLAUDE.md: compiled', 'AGENTS.md: unmanaged'));
    fs.writeFileSync('CLAUDE.md', `<!-- ${COMPILE_BANNER_MARKER} -->\n`);
    fs.writeFileSync('AGENTS.md', POINTER_AGENTS_MD);
    fs.writeFileSync('GEMINI.md', `<!-- ${COMPILE_BANNER_MARKER} -->\n`);
    const before = snapshot();
    const text = await run(['vendor', 'restore', 'CLAUDE.md']);
    expect(text.code).toBe(1);
    expect(text.err).toContain('  [warn] CLAUDE.md is compiled (recorded); restore writes a pointer. Record that intent first: charter adf vendor set CLAUDE.md pointer');
    expect((await restore('AGENTS.md')).json).toEqual({ file: 'AGENTS.md', status: 'refused', refusal: 'mode-not-pointer', keptSections: [], remedy: 'charter adf vendor set AGENTS.md pointer', writeError: null });
    expect((await restore('GEMINI.md')).json.refusal).toBe('mode-not-pointer');
    expect(snapshot()).toEqual(before);
  });

  it('refuses hand-authored content, recorded pointer or not (hand-authored)', async () => {
    scaffold(vendors('AGENTS.md: pointer'));
    fs.writeFileSync('CLAUDE.md', HAND_WRITTEN);
    fs.writeFileSync('AGENTS.md', '# Agents I wrote\n');
    const before = snapshot();
    const claude = await restore('CLAUDE.md');
    expect(claude.code).toBe(1);
    expect(claude.json).toMatchObject({ refusal: 'hand-authored', remedy: 'charter adf migrate --source CLAUDE.md' });
    expect(claude.err).toContain('  [warn] CLAUDE.md has hand-authored content that .ai/ does not hold. Move it first: charter adf migrate --source CLAUDE.md');
    expect((await restore('AGENTS.md')).json.refusal).toBe('hand-authored');
    expect(snapshot()).toEqual(before);
  });

  it('refuses a bloated pointer (pointer-bloated)', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', BLOATED_CLAUDE);
    const r = await restore('CLAUDE.md');
    expect(r.json).toMatchObject({ status: 'refused', refusal: 'pointer-bloated', remedy: 'charter adf tidy --source CLAUDE.md' });
    expect(r.err).toMatch(/ {2}\[warn\] CLAUDE\.md carries \d+ item\(s\) beyond the pointer\. Fold them into \.ai\/ first: charter adf tidy --source CLAUDE\.md/);
    expect(read('CLAUDE.md')).toBe(BLOATED_CLAUDE);
  });

  it('carries a compiled file\'s own retained sections into the pointer (#303; retained-divergent retired)', async () => {
    scaffold(vendors('CLAUDE.md: pointer'));
    const compiled = `${await compiledOutput('claude')}\n## Environment\n- Use WSL for builds\n`;
    fs.writeFileSync('CLAUDE.md', compiled);
    const r = await restore('CLAUDE.md');
    expect(r.json).toMatchObject({ status: 'restored', refusal: null, keptSections: ['## Environment'] });
    expect(read('CLAUDE.md')).toBe(restoredPointer('CLAUDE.md', null, '.ai', '## Environment\n- Use WSL for builds'));
    expect(read('CLAUDE.md').endsWith('## Environment\n- Use WSL for builds\n')).toBe(true);
  });

  it('refuses when the record cannot be written, and writes no file (record-write)', async () => {
    scaffold(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS: not a list\n`);
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    const before = snapshot();
    const r = await restore('CLAUDE.md');
    expect(r.json).toMatchObject({ status: 'refused', refusal: 'record-write', remedy: 'charter adf vendor status' });
    expect(snapshot()).toEqual(before);
  });

  it('keeps retained sections verbatim and reports them', async () => {
    scaffold();
    const notes = `${POINTER_CLAUDE_MD.replace('<!-- Add runtime/OS/shell-specific notes here (not stack rules) -->\n', '- Use WSL for builds\n')}\n## Release Protocol\n\nTag, then push.\n`;
    fs.writeFileSync('CLAUDE.md', notes);
    const text = await run(['vendor', 'restore', 'CLAUDE.md']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('  [ok] Restored CLAUDE.md as a thin pointer (kept ## Environment, ## Release Protocol)');
    const restored = read('CLAUDE.md');
    expect(restored).toContain('## Environment\n- Use WSL for builds\n');
    expect(restored).toContain('## Release Protocol\n\nTag, then push.\n');
    expect(restored).toContain('| core.adf | _(always loaded)_ | DEFAULT |\n');
    expect(restored.match(/## Module Index/g)).toHaveLength(1);
    expect(manifestText()).toBe(vendors('CLAUDE.md: pointer'));
  });

  it('an unchanged pointer is byte-equal: status unchanged, nothing written', async () => {
    await bootstrapCommand({ ...TEXT, yes: true }, ['--yes', '--skip-install', '--skip-doctor']);
    const before = snapshot();
    for (const f of ['CLAUDE.md', 'AGENTS.md', '.cursorrules', 'GEMINI.md', 'copilot-instructions.md']) {
      const r = await restore(f);
      expect(r.json, f).toMatchObject({ status: 'unchanged', refusal: null });
    }
    expect(snapshot()).toEqual(before);
    expect(restoredPointer('CLAUDE.md', read('CLAUDE.md'), '.ai')).toBe(read('CLAUDE.md'));
  });

  it('restores an absent unrecorded file, recording pointer before the write', async () => {
    scaffold();
    const r = await restore('GEMINI.md');
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ file: 'GEMINI.md', status: 'restored', refusal: null, keptSections: [], remedy: null, writeError: null });
    expect(read('GEMINI.md')).toBe(POINTER_GEMINI_MD);
    expect(manifestText()).toBe(vendors('GEMINI.md: pointer'));
  });

  it('--dry-run plans and writes nothing', async () => {
    scaffold(vendors('CLAUDE.md: pointer'));
    fs.writeFileSync('CLAUDE.md', await compiledOutput('claude'));
    const before = snapshot();
    const text = await run(['vendor', 'restore', 'CLAUDE.md', '--dry-run']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('  [dry-run] Would restore CLAUDE.md as a thin pointer');
    expect((await restore('CLAUDE.md', ['--dry-run'])).json.status).toBe('planned');
    expect(snapshot()).toEqual(before);
  });

  it('a failed file write puts the manifest back (record revert)', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    scaffold();
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    const manifest = manifestText();
    fs.chmodSync('CLAUDE.md', 0o444);
    try {
      const text = await run(['vendor', 'restore', 'CLAUDE.md']);
      expect(text.code).toBe(1);
      expect(text.err).toMatch(/ {2}\[warn\] Could not write CLAUDE\.md: .+\. Its new mode record was removed again\./);
      expect(manifestText()).toBe(manifest);
      expect(read('CLAUDE.md')).toBe(POINTER_CLAUDE_MD);
      // JSON tells a failed file write apart from a skipped record (record-write).
      const j = await restore('CLAUDE.md');
      expect(j.json.refusal).toBe('write-failed');
      expect(j.json.writeError).toBeTruthy();
      expect(manifestText()).toBe(manifest);
    } finally {
      fs.chmodSync('CLAUDE.md', 0o644);
    }
  });

  it('usage errors and unknown files are exit 2 (CLIError)', async () => {
    scaffold();
    await expect(run(['vendor', 'restore'])).rejects.toBeInstanceOf(CLIError);
    await expect(run(['vendor', 'restore', 'README.md'])).rejects.toThrow("Unknown vendor file 'README.md'");
    try {
      await run(['vendor', 'restore', 'README.md']);
    } catch (e) {
      expect((e as CLIError).exitCode).toBe(2);
    }
  });

  it('INV-P3-9: across every refusal fixture no byte is lost', async () => {
    const fixtures: Array<[string, string, string]> = [
      [vendors('CLAUDE.md: compiled'), 'CLAUDE.md', HAND_WRITTEN],
      [BASE_MANIFEST, 'CLAUDE.md', HAND_WRITTEN],
      [BASE_MANIFEST, 'CLAUDE.md', BLOATED_CLAUDE],
      [vendors('CLAUDE.md: pointer'), 'CLAUDE.md', HAND_WRITTEN],
    ];
    for (const [manifest, file, content] of fixtures) {
      scaffold(manifest);
      fs.writeFileSync(file, content);
      const before = snapshot();
      const r = await restore(file);
      expect(r.json.status).toBe('refused');
      expect(snapshot()).toEqual(before);
    }
  });
});

describe('adf vendor restore keeps every user line (review round 1)', () => {
  /** A bootstrapped repo whose hybrid CLAUDE.md is then edited by `edit`. */
  async function bootstrapped(edit: (text: string) => string): Promise<string> {
    await bootstrapCommand({ ...TEXT, yes: true }, ['--yes', '--skip-install', '--skip-doctor']);
    const edited = edit(read('CLAUDE.md'));
    expect(edited).not.toBe(read('CLAUDE.md'));
    fs.writeFileSync('CLAUDE.md', edited);
    return edited;
  }

  const repros: Array<[string, (t: string) => string, string]> = [
    ['an edited title', t => t.replace('# CLAUDE.md', '# Acme Payments — agent notes'), '# Acme Payments — agent notes'],
    ['an extra blockquote line', t => t.replace('> See `.ai/manifest.adf` for the module routing manifest.\n', '> See `.ai/manifest.adf` for the module routing manifest.\n> Escalate prod incidents to #oncall-payments.\n'), '> Escalate prod incidents to #oncall-payments.'],
    ['edited Session Start text', t => t.replace(/Call `charter_context`[^\n]*\n/, 'Our CI token lives in 1Password vault Eng-Prod.\n'), 'Our CI token lives in 1Password vault Eng-Prod.'],
    ['prose after the module-index end marker', t => t.replace('<!-- charter:module-index:end -->\n', '<!-- charter:module-index:end -->\nDeploys go through the release train on Tuesdays.\n'), 'Deploys go through the release train on Tuesdays.'],
  ];

  for (const [name, edit, line] of repros) {
    it(`INV-P3-9: refuses a pointer with ${name}, naming the line, and writes nothing`, async () => {
      const edited = await bootstrapped(edit);
      const before = snapshot();
      const text = await run(['vendor', 'restore', 'CLAUDE.md']);
      expect(text.code).toBe(1);
      expect(text.err).toContain(`  [warn] CLAUDE.md has 1 line(s) the pointer template would drop: '${line}'.`);
      expect(text.out).not.toContain('Restored');
      const j = await restore('CLAUDE.md');
      expect(j.json).toMatchObject({ status: 'refused', refusal: 'hand-authored' });
      expect(read('CLAUDE.md')).toBe(edited);
      expect(snapshot()).toEqual(before);
    });
  }

  it('never reports Module Index as kept; prose under it is refused, not dropped', async () => {
    await bootstrapped(t => t.replace('## Module Index\n', '## Module Index\nRead payments.adf first.\n'));
    const r = await restore('CLAUDE.md');
    expect(r.json.refusal).toBe('hand-authored');
    expect(r.err).toContain("'Read payments.adf first.'");

    // An Environment note survives, and only Environment is listed as kept.
    await bootstrapped(t => t.replace('<!-- Add runtime/OS/shell-specific notes here (not stack rules) -->', '- Use WSL for builds'));
    fs.writeFileSync('CLAUDE.md', `${POINTER_CLAUDE_MD.replace('<!-- Add runtime/OS/shell-specific notes here (not stack rules) -->', '- Use WSL for builds')}`);
    const ok = await restore('CLAUDE.md');
    expect(ok.json).toMatchObject({ status: 'restored', keptSections: ['## Environment'] });
    expect(read('CLAUDE.md')).toContain('- Use WSL for builds');
  });

  it('a successful restore keeps every non-template line of the old file', async () => {
    scaffold();
    const old = `${POINTER_CLAUDE_MD.replace('<!-- Add runtime/OS/shell-specific notes here (not stack rules) -->', '- Use WSL for builds\n- Node 20 via fnm')}\n## Release Protocol\n\nTag, then push.\n`;
    fs.writeFileSync('CLAUDE.md', old);
    expect((await restore('CLAUDE.md')).json.status).toBe('restored');
    const now = read('CLAUDE.md');
    for (const l of ['- Use WSL for builds', '- Node 20 via fnm', '## Release Protocol', 'Tag, then push.']) expect(now).toContain(l);
  });

  it('a pristine pointer from an earlier template version still restores', async () => {
    scaffold();
    // POINTER_CLAUDE_MD as first shipped (8cbfd78), and the pre-#155 one without Session Start.
    const v1 = '# Project Context\n\n> This project uses [ADF](https://github.com/Stackbilt-dev/charter) for AI agent context management.\n> All stack rules, constraints, and architectural guidance live in `.ai/`.\n> **Do not duplicate ADF rules here.** Only pre-ADF bootstrap content belongs in this file.\n\nSee `.ai/manifest.adf` for the module routing manifest.\n\n## Environment\n<!-- Add runtime/OS/shell-specific notes here (not stack rules) -->\n';
    fs.writeFileSync('CLAUDE.md', v1);
    expect((await restore('CLAUDE.md')).json).toMatchObject({ status: 'restored', refusal: null });
    expect(read('CLAUDE.md')).toContain('<!-- charter:module-index:start -->');
    const v2 = POINTER_CLAUDE_MD.replace(/## Session Start[\s\S]*?(?=## Environment)/, '');
    fs.writeFileSync('CLAUDE.md', v2);
    expect((await restore('CLAUDE.md')).json.status).toBe('restored');
    // The old lowercase-titled agents pointer.
    fs.writeFileSync('AGENTS.md', '# agents.md\n\n> **DO NOT add instructions to this file.**\n> All agent instructions are managed in `.ai/` by Charter.\n> See `.ai/manifest.adf` for the module routing manifest.\n');
    expect((await restore('AGENTS.md')).json.status).toBe('restored');
  });

  it('refuses a recorded pointer whose compiled body was hand-edited (compiled-differs); a fresh compile restores', async () => {
    scaffold(vendors('CLAUDE.md: pointer'));
    const compiled = await compiledOutput('claude');
    const edited = compiled.replace(/\n(?=[^\n]*$)/, '\n- HAND EDIT: call Bob before deploying\n');
    expect(edited).not.toBe(compiled);
    fs.writeFileSync('CLAUDE.md', edited);
    const before = snapshot();
    const r = await restore('CLAUDE.md');
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', refusal: 'compiled-differs', remedy: 'charter adf vendor set CLAUDE.md compiled' });
    expect(r.err).toContain('charter adf compile --target claude --check');
    expect(snapshot()).toEqual(before);
    fs.writeFileSync('CLAUDE.md', compiled);
    expect((await restore('CLAUDE.md')).json.status).toBe('restored');
  });
});

// ============================================================================
// 7. compile messages name restore
// ============================================================================

describe('adf compile remedies name adf vendor restore', () => {
  it('a missing recorded pointer: following the remedy passes --check', async () => {
    scaffold(vendors('AGENTS.md: pointer'));
    const r = await run(['compile', '--target', 'agents', '--check', '--format', 'json'], JSON_OPTS);
    const j = JSON.parse(r.out) as { targets: Array<{ remedy: string }>; nextActions: string[] };
    expect(j.targets[0].remedy).toBe('charter adf vendor restore AGENTS.md');
    expect(j.nextActions.join('\n')).not.toContain('git checkout');
    expect((await run(j.targets[0].remedy.replace(/^charter adf /, '').split(' '))).code).toBe(0);
    expect((await run(['compile', '--target', 'agents', '--check'])).code).toBe(0);
  });
});

// Literal templates the doctor rows use (kept in one place so a rename is caught).
describe('doctor message templates', () => {
  it('match the addendum wording', () => {
    expect(DOCTOR_MSG.allRecorded).toBe('All {n} vendor file(s) have a recorded mode that matches the file on disk.');
    expect(DOCTOR_MSG.agentConfigPass).toBe('{pointers} thin pointer(s) and {compiled} compiled file(s) route to .ai/{unmanagedNote}.');
  });
});

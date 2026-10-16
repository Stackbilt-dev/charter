/**
 * Legacy lowercase agents.md (#302 gap 1; #318 PR 6 of 6).
 *
 * Pins doctor's index-only detection (legacy-tracked / legacy-both-distinct /
 * legacy-both-one-file, all INFO), `charter adf vendor rename-legacy` (record
 * first, two-step rename, undo), and the compile / vendor set messages for a
 * legacy-keyed AGENTS.md (PR2-review note 8). INV-P6-1..9 in the PR6 contract.
 *
 * Every git repo here is a fresh mkdtemp directory; each test asserts that git's
 * top level IS that directory before any git write.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAdf, parseManifest } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { adfCommand, POINTER_AGENTS_MD } from '../commands/adf';
import {
  legacyIndexEntries,
  legacyIndexKind,
  legacyKeyFor,
  POINTER_ONLY_VENDOR_FILES,
  RENAME_TMP,
  renameLegacyAgents,
} from '../commands/adf-vendor';
import { removeManifestBullet } from '../commands/adf-manifest-register';
import { AGENT_CONFIG_FILES, discoverAgentConfigFiles } from '../commands/adf-migrate';
import { doctorCommand } from '../commands/doctor';

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

/** The pre-#297 template: the AGENTS.md pointer under its old lowercase title. */
const LEGACY_POINTER = POINTER_AGENTS_MD.replace(/^# AGENTS\.md/, '# agents.md');

const vendors = (...lines: string[]): string => `${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\n${lines.map(l => `  - ${l}`).join('\n')}\n`;

const originalCwd = process.cwd();
let tmp = '';
let out: string[] = [];
let err: string[] = [];

// A test run from inside a git hook inherits GIT_DIR / GIT_INDEX_FILE, which would
// point every git call here at the outer repository. Drop them for this file.
const GIT_ENV_KEYS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'];
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of GIT_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const k of GIT_ENV_KEYS) if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
});

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'charter-legacy-agents-')));
  process.chdir(tmp);
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: tmp, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** git init in the temp dir, then prove git's top level is that dir before any write. */
function initRepo(): void {
  git(['init', '-q']);
  const top = fs.realpathSync.native(path.resolve(git(['rev-parse', '--show-toplevel']).trim()));
  if (top !== tmp) throw new Error(`refusing to run: git top level ${top} is not the temp repo ${tmp}`);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);
}

function commitAll(): void {
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture']);
}

function scaffold(manifest = BASE_MANIFEST): void {
  fs.mkdirSync('.ai', { recursive: true });
  fs.writeFileSync('.ai/manifest.adf', manifest);
  fs.writeFileSync('.ai/core.adf', 'ADF: 0.1\n\n\u{1F4CB} CONTEXT:\n  - TypeScript monorepo\n');
  fs.writeFileSync('.ai/state.adf', 'ADF: 0.1\n\n\u{1F9E0} STATE:\n  CURRENT: Active development\n');
}

const manifestText = (): string => fs.readFileSync('.ai/manifest.adf', 'utf-8');
const rootNames = (): string[] => fs.readdirSync('.').filter(n => n !== '.git').sort();
const cached = (): string => git(['diff', '--cached', '--name-status', '-M']).trim();
const porcelain = (): string => git(['status', '--porcelain=v1', '--untracked-files=all']);

/** Is this temp dir on a case-insensitive filesystem? */
function caseInsensitive(): boolean {
  fs.writeFileSync('.case-probe', '');
  const ci = fs.existsSync('.CASE-PROBE');
  fs.rmSync('.case-probe');
  return ci;
}

/** A blob for `git update-index --cacheinfo`. */
function blob(content: string): string {
  return execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: tmp, input: content, encoding: 'utf-8' }).trim();
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

interface Row { kind: string; status: string; file: string | null; remedy: string | null }
interface DoctorJson { checks: Array<{ name: string; status: string; details: string; rows?: Row[] }> }

async function doctor(ci = false): Promise<{ code: number; check: DoctorJson['checks'][number] | undefined }> {
  out = [];
  const code = await doctorCommand({ ...JSON_OPTS, ciMode: ci }, ['--adf-only']);
  const json = JSON.parse(out.join('\n')) as DoctorJson;
  return { code, check: json.checks.find(c => c.name === 'adf vendor mode') };
}

const legacyRows = (rows: Row[] | undefined): Array<[string, string, string | null]> =>
  (rows ?? []).filter(r => r.kind.startsWith('legacy-')).map(r => [r.kind, r.status, r.remedy]);

/** A committed repo tracking the lowercase pre-#297 agents.md, recorded as agents.md: pointer. */
function legacyRepo(manifest = vendors('agents.md: pointer'), content = LEGACY_POINTER): void {
  initRepo();
  scaffold(manifest);
  fs.writeFileSync('agents.md', content);
  commitAll();
}

const RESULT_KEYS = ['status', 'method', 'from', 'to', 'staged', 'record', 'titleUpdated', 'references', 'refusal', 'remedy', 'error'];

// ============================================================================
// removeManifestBullet (the shared writer's remove helper)
// ============================================================================

describe('removeManifestBullet', () => {
  it('removes exactly one item line, keeping every other byte (LF and CRLF)', () => {
    const lf = vendors('AGENTS.md: pointer', 'agents.md: pointer', 'CLAUDE.md: compiled');
    expect(removeManifestBullet(lf, 'VENDORS', 1)).toBe(vendors('AGENTS.md: pointer', 'CLAUDE.md: compiled'));
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(removeManifestBullet(crlf, 'VENDORS', 1)).toBe(vendors('AGENTS.md: pointer', 'CLAUDE.md: compiled').replace(/\n/g, '\r\n'));
  });

  it('keeps the no-trailing-newline state when the last line goes', () => {
    const text = `${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\r\n  - AGENTS.md: pointer\r\n  - agents.md: pointer`;
    expect(removeManifestBullet(text, 'VENDORS', 1)).toBe(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\r\n  - AGENTS.md: pointer`);
  });

  it('returns null for a missing section or item', () => {
    expect(removeManifestBullet(BASE_MANIFEST, 'VENDORS', 0)).toBeNull();
    expect(removeManifestBullet(vendors('AGENTS.md: pointer'), 'VENDORS', 3)).toBeNull();
  });
});

// ============================================================================
// Detection (D0-D4; INV-P6-1, INV-P6-2)
// ============================================================================

describe('legacy agents.md detection (index only)', () => {
  it('queries the index with an icase pathspec and filters by exact case (INV-P6-1, mocked git)', () => {
    const calls: string[][] = [];
    const entries = legacyIndexEntries(args => {
      calls.push(args);
      return 'Agents.md\0agents.md\0';
    });
    expect(calls).toEqual([['ls-files', '-z', '--', ':(icase)agents.md']]);
    expect(entries).toEqual({ lower: true, upper: false });
    expect(legacyIndexEntries(() => 'AGENTS.md\0agents.md\0')).toEqual({ lower: true, upper: true });
    expect(legacyIndexEntries(() => { throw new Error('not a git repository'); })).toBeNull();
  });

  it('classifies by index entries, using file identity only to split both-spellings (mocked)', () => {
    expect(legacyIndexKind(null)).toBeNull();
    expect(legacyIndexKind({ lower: false, upper: true })).toBeNull();
    expect(legacyIndexKind({ lower: true, upper: false }, () => { throw new Error('identity must not be read'); })).toBe('legacy-tracked');
    expect(legacyIndexKind({ lower: true, upper: true }, () => false)).toBe('legacy-both-distinct');
    expect(legacyIndexKind({ lower: true, upper: true }, () => true)).toBe('legacy-both-one-file');
  });

  it('reports a tracked lowercase agents.md as legacy-tracked INFO naming rename-legacy', async () => {
    legacyRepo(vendors('AGENTS.md: pointer'));
    const { check } = await doctor();
    expect(legacyRows(check?.rows)).toEqual([['legacy-tracked', 'INFO', 'charter adf vendor rename-legacy']]);
    expect(check?.details).toContain('git tracks agents.md under its pre-#297 lowercase name. Rename it (case-safe, keeps its VENDORS entry): charter adf vendor rename-legacy');
  });

  it('reports two index entries for one file as legacy-both-one-file (update-index --cacheinfo)', async () => {
    legacyRepo(vendors('AGENTS.md: pointer'));
    // One physical file under both names: a case-insensitive checkout, or a hard link.
    if (!fs.existsSync('AGENTS.md')) fs.linkSync('agents.md', 'AGENTS.md');
    git(['update-index', '--add', '--cacheinfo', `100644,${blob(LEGACY_POINTER)},AGENTS.md`]);
    expect(git(['ls-files']).split('\n')).toEqual(expect.arrayContaining(['agents.md', 'AGENTS.md']));
    const { check } = await doctor();
    expect(legacyRows(check?.rows)).toEqual([['legacy-both-one-file', 'INFO', 'git rm --cached agents.md']]);
  });

  it('reports two distinct tracked files as legacy-both-distinct (case-sensitive filesystems only)', async () => {
    initRepo();
    if (caseInsensitive()) return; // covered by the mocked classification test above
    scaffold(vendors('AGENTS.md: pointer'));
    fs.writeFileSync('agents.md', LEGACY_POINTER);
    fs.writeFileSync('AGENTS.md', POINTER_AGENTS_MD);
    commitAll();
    const { check } = await doctor();
    expect(legacyRows(check?.rows)).toEqual([['legacy-both-distinct', 'INFO', 'git rm agents.md']]);
  });

  it('gives no row for an untracked agents.md, a tracked AGENTS.md, or a non-git directory (D3)', async () => {
    scaffold(vendors('AGENTS.md: pointer'));
    fs.writeFileSync('agents.md', LEGACY_POINTER);
    expect(legacyRows((await doctor()).check?.rows)).toEqual([]); // not a git repo
    initRepo();
    expect(legacyRows((await doctor()).check?.rows)).toEqual([]); // untracked
    fs.rmSync('agents.md');
    fs.writeFileSync('AGENTS.md', POINTER_AGENTS_MD);
    commitAll();
    expect(legacyRows((await doctor()).check?.rows)).toEqual([]); // tracked as AGENTS.md
  });

  it('never raises the check above INFO or changes doctor --ci exit (INV-P6-2)', async () => {
    legacyRepo(vendors('agents.md: pointer'));
    const before = await doctor(true);
    expect(before.check?.status).toBe('INFO');
    expect(before.check?.rows?.filter(r => r.kind.startsWith('legacy-')).every(r => r.status === 'INFO')).toBe(true);
    expect(before.code).toBe(0);
  });
});

// ============================================================================
// rename-legacy: git method (CP-1..CP-5; INV-P6-3..6)
// ============================================================================

describe('adf vendor rename-legacy (git mv)', () => {
  it('--dry-run plans the rename and writes nothing to fs, git or the manifest (INV-P6-6)', async () => {
    legacyRepo();
    const names = rootNames();
    const manifest = manifestText();
    const status = porcelain();
    const r = await runJson<Record<string, unknown>>(['vendor', 'rename-legacy', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'planned', method: 'git-mv', staged: [], record: { action: 'rekeyed', mode: 'pointer' }, titleUpdated: true });
    expect(rootNames()).toEqual(names);
    expect(manifestText()).toBe(manifest);
    expect(porcelain()).toBe(status);
    expect(git(['ls-files', 'agents.md']).trim()).toBe('agents.md');
  });

  it('stages a pure rename, re-keys the record first, leaves the manifest unstaged with a hint (CP-1, CP-3, INV-P6-5)', async () => {
    legacyRepo();
    // Unrelated work in progress must not be staged or touched.
    fs.writeFileSync('.ai/core.adf', 'ADF: 0.1\n\n\u{1F4CB} CONTEXT:\n  - edited, not staged\n');
    fs.writeFileSync('notes.txt', 'untracked\n');
    const r = await run(['vendor', 'rename-legacy']);
    expect(r.code).toBe(0);
    expect(cached()).toMatch(/^R100\tagents\.md\tAGENTS\.md$/);
    expect(git(['ls-files', '-z', '--', ':(icase)agents.md']).split('\0').filter(Boolean)).toEqual(['AGENTS.md']);
    expect(porcelain().split('\n').filter(Boolean).sort()).toEqual([' M .ai/core.adf', ' M .ai/manifest.adf', '?? notes.txt', 'RM agents.md -> AGENTS.md'].sort());
    expect(parseManifest(parseAdf(manifestText())).vendors.map(v => v.raw)).toEqual(['AGENTS.md: pointer']);
    expect(manifestText()).toBe(vendors('AGENTS.md: pointer'));
    expect(r.out).toContain('[ok] Renamed agents.md -> AGENTS.md (git-mv); VENDORS entry moved; title line updated');
    expect(r.out).toContain('The rename is staged. Commit it together with .ai/manifest.adf and AGENTS.md: git add .ai/manifest.adf AGENTS.md && git commit');
  });

  it('rewrites only an exact `# agents.md` first line (CP-4, INV-P6-3)', async () => {
    legacyRepo();
    await run(['vendor', 'rename-legacy']);
    expect(fs.readFileSync('AGENTS.md', 'utf-8')).toBe(POINTER_AGENTS_MD);
    expect(rootNames()).toContain('AGENTS.md');
    expect(rootNames()).not.toContain('agents.md');
  });

  it('leaves any other first line, and every other byte, untouched (INV-P6-3)', async () => {
    const content = '# agents.md notes\r\n\r\nMy own text mentions # agents.md here.\r\n';
    legacyRepo(vendors('agents.md: unmanaged'), content);
    const r = await runJson<{ titleUpdated: boolean; record: unknown }>(['vendor', 'rename-legacy']);
    expect(r.json.titleUpdated).toBe(false);
    expect(r.json.record).toEqual({ action: 'rekeyed', mode: 'unmanaged' });
    expect(fs.readFileSync('AGENTS.md', 'utf-8')).toBe(content);
  });

  it('updates a CRLF legacy title line and keeps its line ending', async () => {
    legacyRepo(vendors('agents.md: pointer'), LEGACY_POINTER.replace(/\n/g, '\r\n'));
    await run(['vendor', 'rename-legacy']);
    expect(fs.readFileSync('AGENTS.md', 'utf-8')).toBe(POINTER_AGENTS_MD.replace(/\n/g, '\r\n'));
  });

  it('is idempotent: a second run after the commit reports unchanged', async () => {
    legacyRepo();
    await run(['vendor', 'rename-legacy']);
    git(['add', '.ai/manifest.adf', 'AGENTS.md']);
    git(['commit', '-q', '-m', 'rename']);
    const r = await runJson<{ status: string; method: string }>(['vendor', 'rename-legacy']);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'unchanged', method: 'none' });
    expect(porcelain()).toBe('');
    expect(legacyRows((await doctor()).check?.rows)).toEqual([]);
  });

  it('removes a same-mode duplicate agents.md entry through the re-parse guard (CP-5)', async () => {
    legacyRepo(vendors('AGENTS.md: pointer', 'CLAUDE.md: pointer', 'agents.md: pointer'));
    const r = await runJson<{ status: string; record: unknown }>(['vendor', 'rename-legacy']);
    expect(r.json).toMatchObject({ status: 'renamed', record: { action: 'removed-duplicate', mode: 'pointer' } });
    expect(manifestText()).toBe(vendors('AGENTS.md: pointer', 'CLAUDE.md: pointer'));
  });

  it('refuses record-conflict when the two keys disagree, changing nothing (CP-5)', async () => {
    legacyRepo(vendors('AGENTS.md: unmanaged', 'agents.md: pointer'));
    const manifest = manifestText();
    const r = await run(['vendor', 'rename-legacy']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('VENDORS records agents.md as pointer and AGENTS.md as unmanaged. Keep one line in .ai/manifest.adf, then re-run.');
    expect(manifestText()).toBe(manifest);
    expect(porcelain()).toBe('');
  });

  it('refuses when agents.md has unstaged or staged changes (CP-2)', async () => {
    legacyRepo();
    fs.appendFileSync('agents.md', 'local edit\n');
    const unstaged = await runJson<{ status: string; refusal: string }>(['vendor', 'rename-legacy']);
    expect(unstaged.code).toBe(1);
    expect(unstaged.json).toMatchObject({ status: 'refused', refusal: 'dirty' });
    expect(unstaged.err).toContain('agents.md has uncommitted changes. Commit or stash them first');
    git(['add', 'agents.md']);
    const staged = await runJson<{ refusal: string }>(['vendor', 'rename-legacy']);
    expect(staged.json.refusal).toBe('dirty');
    expect(manifestText()).toBe(vendors('agents.md: pointer'));
    expect(cached()).toBe('M\tagents.md');
  });

  it('refuses when the temp name exists, changing nothing', async () => {
    legacyRepo();
    fs.writeFileSync(RENAME_TMP, 'in the way\n');
    const status = porcelain();
    const r = await runJson<{ refusal: string; remedy: string }>(['vendor', 'rename-legacy']);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ refusal: 'tmp-exists', remedy: `rm ${RENAME_TMP}` });
    expect(porcelain()).toBe(status);
    expect(manifestText()).toBe(vendors('agents.md: pointer'));
  });

  it('refuses two index entries on one file with the index-only remedy (P4)', async () => {
    legacyRepo();
    if (!fs.existsSync('AGENTS.md')) fs.linkSync('agents.md', 'AGENTS.md');
    git(['update-index', '--add', '--cacheinfo', `100644,${blob(LEGACY_POINTER)},AGENTS.md`]);
    const r = await runJson<{ refusal: string; remedy: string }>(['vendor', 'rename-legacy']);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ refusal: 'both-distinct', remedy: 'git rm --cached agents.md' });
    expect(manifestText()).toBe(vendors('agents.md: pointer'));
  });

  it('refuses two distinct files with the merge remedy, never deleting either (P2, simulated case-sensitive index)', async () => {
    legacyRepo();
    // Two distinct index entries, as a case-sensitive checkout has them.
    git(['update-index', '--add', '--cacheinfo', `100644,${blob('# my AGENTS\n')},AGENTS.md`]);
    const sensitive = !caseInsensitive();
    if (sensitive) fs.writeFileSync('AGENTS.md', '# my AGENTS\n');
    const r = await runJson<{ refusal: string; remedy: string }>(['vendor', 'rename-legacy']);
    expect(r.code).toBe(1);
    expect(r.json.refusal).toBe('both-distinct');
    // On a case-insensitive disk the two entries share one file: the index-only remedy.
    expect(r.json.remedy).toBe(sensitive ? 'git rm agents.md' : 'git rm --cached agents.md');
    expect(fs.readFileSync('agents.md', 'utf-8')).toBe(sensitive ? LEGACY_POINTER : fs.readFileSync('AGENTS.md', 'utf-8'));
    expect(manifestText()).toBe(vendors('agents.md: pointer'));
  });

  it('splits both index entries by file identity, deterministically on any host (mocked index and identity)', () => {
    fs.writeFileSync('agents.md', 'a\n');
    const git = (args: string[]): string => (args[0] === 'ls-files' ? 'agents.md\0AGENTS.md\0' : '');
    const distinct = renameLegacyAgents('.ai', { git, sameFile: () => false });
    expect(distinct).toMatchObject({ refusal: 'both-distinct', remedy: 'git rm agents.md' });
    const oneFile = renameLegacyAgents('.ai', { git, sameFile: () => true });
    expect(oneFile).toMatchObject({ refusal: 'both-distinct', remedy: 'git rm --cached agents.md' });
    expect(rootNames()).toEqual(['agents.md']);
  });

  it('JSON stdout is exactly one RenameResult document', async () => {
    legacyRepo();
    const r = await runJson<Record<string, unknown>>(['vendor', 'rename-legacy']);
    expect(Object.keys(r.json)).toEqual(RESULT_KEYS);
    expect(r.json).toMatchObject({ status: 'renamed', method: 'git-mv', from: 'agents.md', to: 'AGENTS.md', staged: ['agents.md', 'AGENTS.md'] });
  });

  it('reports references to agents.md without editing them (S6)', async () => {
    legacyRepo();
    fs.writeFileSync('README.md', '# Project\n\nSee agents.md for agent rules.\n');
    commitAll();
    const r = await runJson<{ references: string[] }>(['vendor', 'rename-legacy']);
    expect(r.json.references).toEqual(['README.md:3']);
    expect(fs.readFileSync('README.md', 'utf-8')).toContain('See agents.md');
    expect(r.err).toContain('agents.md is still mentioned in: README.md:3');
  });
});

// ============================================================================
// rename-legacy: other methods and preconditions
// ============================================================================

describe('adf vendor rename-legacy (fs and record-only)', () => {
  it('renames an untracked agents.md with fs (nothing staged)', async () => {
    initRepo();
    scaffold(vendors('agents.md: pointer'));
    commitAll();
    fs.writeFileSync('agents.md', LEGACY_POINTER);
    const r = await runJson<{ method: string; staged: string[] }>(['vendor', 'rename-legacy']);
    expect(r.json).toMatchObject({ method: 'fs', staged: [] });
    expect(cached()).toBe('');
    expect(rootNames()).toContain('AGENTS.md');
    expect(rootNames()).not.toContain('agents.md');
    expect(manifestText()).toBe(vendors('AGENTS.md: pointer'));
  });

  it('renames in a non-git directory, and without a manifest (P5)', async () => {
    fs.writeFileSync('agents.md', LEGACY_POINTER);
    const r = await runJson<{ status: string; method: string; record: unknown }>(['vendor', 'rename-legacy']);
    expect(r.json).toMatchObject({ status: 'renamed', method: 'fs', record: { action: 'none', mode: null } });
    expect(fs.readFileSync('AGENTS.md', 'utf-8')).toBe(POINTER_AGENTS_MD);
  });

  it('moves only the record when the file is already AGENTS.md (record-only)', async () => {
    scaffold(vendors('agents.md: pointer'));
    fs.writeFileSync('AGENTS.md', POINTER_AGENTS_MD);
    const r = await run(['vendor', 'rename-legacy']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('The file is already AGENTS.md; moved its VENDORS entry from agents.md to AGENTS.md');
    expect(manifestText()).toBe(vendors('AGENTS.md: pointer'));
    expect(rootNames()).toEqual(['.ai', 'AGENTS.md']);
  });

  it('reports unchanged with nothing to do (P1)', async () => {
    scaffold(vendors('AGENTS.md: pointer'));
    fs.writeFileSync('AGENTS.md', POINTER_AGENTS_MD);
    const r = await run(['vendor', 'rename-legacy']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Nothing to rename: no lowercase agents.md in git, on disk, or in VENDORS.');
  });

  it('refuses record-write and renames nothing when the record cannot be read (guard skip)', async () => {
    scaffold(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS: agents.md is pointer\n`);
    fs.writeFileSync('agents.md', LEGACY_POINTER);
    const manifest = manifestText();
    const r = await runJson<{ refusal: string }>(['vendor', 'rename-legacy']);
    expect(r.code).toBe(1);
    expect(r.json.refusal).toBe('record-write');
    expect(rootNames()).toContain('agents.md');
    expect(manifestText()).toBe(manifest);
  });

  it('rejects positional arguments with a usage error (exit 2)', async () => {
    await expect(run(['vendor', 'rename-legacy', 'agents.md'])).rejects.toMatchObject({
      message: 'Usage: charter adf vendor rename-legacy [--dry-run] [--ai-dir <dir>] [--format json]',
      exitCode: 2,
    });
  });
});

// ============================================================================
// Undo (S4; INV-P6-4)
// ============================================================================

describe('adf vendor rename-legacy undo', () => {
  it('git: a failed second git mv puts the file, index and record back (real git, injected failure)', () => {
    legacyRepo();
    const manifest = manifestText();
    let mvCalls = 0;
    const injected = (args: string[]): string => {
      if (args[0] === 'mv' && ++mvCalls === 2) throw new Error('simulated: destination exists');
      return git(args);
    };
    const lines: string[] = [];
    const r = renameLegacyAgents('.ai', { git: injected, print: l => lines.push(l) });
    expect(r).toMatchObject({ status: 'refused', refusal: 'rename-failed', record: { action: 'reverted', mode: 'pointer' }, error: 'simulated: destination exists' });
    expect(lines.join('\n')).toContain('Rename failed: simulated: destination exists. agents.md and the VENDORS entry are back as they were.');
    expect(rootNames()).toContain('agents.md');
    expect(rootNames()).not.toContain(RENAME_TMP);
    expect(manifestText()).toBe(manifest);
    expect(porcelain()).toBe('');
  });

  it('fs: a failed second rename puts the file and record back (mocked rename)', () => {
    scaffold(vendors('agents.md: pointer'));
    fs.writeFileSync('agents.md', LEGACY_POINTER);
    const manifest = manifestText();
    let calls = 0;
    const rename = (from: string, to: string): void => {
      if (++calls === 2) throw new Error('EPERM');
      fs.renameSync(from, to);
    };
    const r = renameLegacyAgents('.ai', { rename, git: () => { throw new Error('not a git repository'); } });
    expect(r).toMatchObject({ refusal: 'rename-failed', record: { action: 'reverted' } });
    expect(rootNames()).toEqual(['.ai', 'agents.md']);
    expect(fs.readFileSync('agents.md', 'utf-8')).toBe(LEGACY_POINTER);
    expect(manifestText()).toBe(manifest);
  });

  it('names the manual recovery when the undo itself fails', () => {
    scaffold(vendors('agents.md: pointer'));
    fs.writeFileSync('agents.md', LEGACY_POINTER);
    let calls = 0;
    const rename = (from: string, to: string): void => {
      if (++calls >= 2) throw new Error('EPERM');
      fs.renameSync(from, to);
    };
    const lines: string[] = [];
    const r = renameLegacyAgents('.ai', { rename, git: () => { throw new Error('no git'); }, print: l => lines.push(l) });
    expect(r.refusal).toBe('rename-failed');
    expect(lines.join('\n')).toContain(`Recover by hand: mv ${RENAME_TMP} agents.md`);
    expect(r.record.action).toBe('reverted');
  });
});

// ============================================================================
// Note 8: compile and vendor set with a legacy key (INV-P6-7)
// ============================================================================

/** agents.md and AGENTS.md as one physical file (a hard link on a case-sensitive host). */
function aliasedAgents(content: string): void {
  fs.writeFileSync('agents.md', content);
  if (!fs.existsSync('AGENTS.md')) fs.linkSync('agents.md', 'AGENTS.md');
}

describe('compile and vendor set with a legacy agents.md key (note 8)', () => {
  it('legacyKeyFor is set only for AGENTS.md keyed as agents.md on one physical file', () => {
    scaffold(vendors('agents.md: pointer'));
    expect(legacyKeyFor('.ai/manifest.adf', 'AGENTS.md')).toBeNull(); // no file
    aliasedAgents(POINTER_AGENTS_MD);
    expect(legacyKeyFor('.ai/manifest.adf', 'AGENTS.md')).toBe('agents.md');
    expect(legacyKeyFor('.ai/manifest.adf', 'agents.md')).toBeNull();
    fs.writeFileSync('.ai/manifest.adf', vendors('AGENTS.md: pointer'));
    expect(legacyKeyFor('.ai/manifest.adf', 'AGENTS.md')).toBeNull();
  });

  it('--mode compiled gives refused-legacy-spelling, exit 1, and writes no record or file', async () => {
    scaffold(vendors('agents.md: pointer'));
    aliasedAgents(POINTER_AGENTS_MD);
    const manifest = manifestText();
    const text = await run(['compile', '--target', 'agents', '--write', '--mode', 'compiled']);
    expect(text.code).toBe(1);
    expect(text.err).toContain('Refused to compile AGENTS.md: its VENDORS entry and git path still use the legacy name agents.md');
    expect(text.err).toContain('Run: charter adf vendor rename-legacy, then re-run this command.');
    expect(text.err).not.toContain('could not be recorded');
    const json = await runJson<{ targets: Array<{ status: string; remedy: string }>; nextActions: string[] }>(
      ['compile', '--target', 'agents', '--write', '--mode', 'compiled']);
    expect(json.json.targets[0]).toMatchObject({ status: 'refused-legacy-spelling', remedy: 'charter adf vendor rename-legacy && charter adf compile --target agents --write --mode compiled' });
    expect(json.err).not.toContain("cannot be 'compiled'");
    expect(manifestText()).toBe(manifest);
    expect(fs.readFileSync('AGENTS.md', 'utf-8')).toBe(POINTER_AGENTS_MD);
  });

  it('without --mode, the skip / refusal remedy is prefixed with the rename', async () => {
    scaffold(vendors('agents.md: pointer'));
    aliasedAgents(POINTER_AGENTS_MD);
    const one = await runJson<{ targets: Array<{ status: string; remedy: string }> }>(['compile', '--target', 'agents', '--write']);
    expect(one.json.targets[0]).toMatchObject({ status: 'refused-mode-change', remedy: 'charter adf vendor rename-legacy && charter adf compile --target agents --write --mode compiled' });
    const all = await run(['compile', '--target', 'all', '--write']);
    expect(all.out).toContain('AGENTS.md is still recorded as agents.md; rename it first: charter adf vendor rename-legacy');
  });

  it('after rename-legacy, --mode compiled succeeds', async () => {
    scaffold(vendors('agents.md: pointer'));
    aliasedAgents(POINTER_AGENTS_MD);
    expect((await run(['vendor', 'rename-legacy'])).code).toBe(0);
    const r = await runJson<{ targets: Array<{ status: string }> }>(['compile', '--target', 'agents', '--write', '--mode', 'compiled']);
    expect(r.code).toBe(0);
    expect(r.json.targets[0].status).toBe('written');
    expect(parseManifest(parseAdf(manifestText())).vendors.map(v => v.raw)).toEqual(['AGENTS.md: compiled']);
  });

  it('vendor set AGENTS.md compiled names the rename, not the generic modeNotAllowed', async () => {
    scaffold(vendors('agents.md: pointer'));
    aliasedAgents(POINTER_AGENTS_MD);
    const manifest = manifestText();
    const r = await run(['vendor', 'set', 'AGENTS.md', 'compiled']);
    expect(r.code).toBe(1);
    expect(r.err).toContain("AGENTS.md is recorded under the legacy name agents.md, which cannot be 'compiled'. Run: charter adf vendor rename-legacy, then: charter adf vendor set AGENTS.md compiled");
    expect(r.err).not.toContain('no compile target writes it');
    const json = await runJson<{ remedy: string }>(['vendor', 'set', 'AGENTS.md', 'compiled']);
    expect(json.json.remedy).toBe('charter adf vendor rename-legacy');
    // pointer|unmanaged still write through the recorded agents.md spelling (N4).
    expect((await run(['vendor', 'set', 'AGENTS.md', 'unmanaged'])).code).toBe(0);
    expect(manifestText()).toBe(manifest.replace('agents.md: pointer', 'agents.md: unmanaged'));
  });

  it('doctor legacy-spelling now names rename-legacy (D4)', async () => {
    scaffold(vendors('agents.md: pointer'));
    aliasedAgents(POINTER_AGENTS_MD);
    const { check } = await doctor();
    const row = check?.rows?.find(r => r.kind === 'legacy-spelling');
    expect(row).toMatchObject({ status: 'INFO', remedy: 'charter adf vendor rename-legacy' });
  });
});

// ============================================================================
// INV-P6-7 (no auto-rename) and INV-P6-9 (discovery keeps agents.md)
// ============================================================================

describe('no automatic rename; discovery keeps the legacy name', () => {
  it('doctor, compile --check and vendor status never rename a tracked agents.md (CP-7)', async () => {
    legacyRepo();
    await doctor();
    await run(['compile', '--target', 'all', '--check']);
    await run(['vendor', 'status']);
    await run(['tidy', '--dry-run']);
    expect(git(['ls-files', '-z', '--', ':(icase)agents.md']).split('\0').filter(Boolean)).toEqual(['agents.md']);
    expect(porcelain()).toBe('');
  });

  it('agents.md stays a vendor and discovery name (INV-P6-9)', () => {
    expect(POINTER_ONLY_VENDOR_FILES).toContain('agents.md');
    expect(AGENT_CONFIG_FILES).toContain('agents.md');
    fs.writeFileSync('agents.md', LEGACY_POINTER);
    // Discovered once, under whichever spelling the host's filesystem matches first.
    expect(discoverAgentConfigFiles().filter(n => n.toLowerCase() === 'agents.md')).toHaveLength(1);
  });
});

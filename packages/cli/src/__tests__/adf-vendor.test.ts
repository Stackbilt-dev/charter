/**
 * `charter adf vendor` and the vendor file mode record (#318, PR 1 of 6).
 *
 * The record is a VENDORS list in <aiDir>/manifest.adf. These tests pin the
 * inference rule, the text-level writer, the three subcommands, the implicit
 * writers, and that no consumer's behaviour changes yet (INV-1..INV-12 in the
 * #318 contract).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPILE_BANNER_MARKER, formatAdf, parseAdf, parseManifest } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import {
  adfCommand,
  POINTER_AGENTS_MD,
  POINTER_CLAUDE_MD,
  POINTER_CLAUDE_MD_HYBRID,
  POINTER_COPILOT_MD,
  POINTER_CURSORRULES,
  POINTER_GEMINI_MD,
} from '../commands/adf';
import {
  inferVendorMode,
  recordVendorModes,
  resolveVendorMode,
  resolveVendorModes,
  VENDOR_FILES,
  withoutVendorsSection,
} from '../commands/adf-vendor';
import { scoreCommand } from '../commands/score';
import type { VendorFile } from '../commands/adf-vendor';
import { insertManifestBullet } from '../commands/adf-manifest-register';
import { bootstrapCommand } from '../commands/bootstrap';
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
  '\u{1F4C2} ON_DEMAND:',
  '  - frontend.adf (Triggers on: React, CSS)',
  '',
].join('\n');

const VENDORS_BLOCK = '\n\u{1F3F7} VENDORS:\n  - CLAUDE.md: pointer\n';

const originalCwd = process.cwd();
let tmp = '';
let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-vendor-test-'));
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

function scaffold(manifest = BASE_MANIFEST, aiDir = '.ai'): string {
  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'manifest.adf'), manifest);
  fs.writeFileSync(path.join(aiDir, 'core.adf'), 'ADF: 0.1\n\n\u{1F4CB} CONTEXT:\n  - TypeScript monorepo\n');
  fs.writeFileSync(path.join(aiDir, 'state.adf'), 'ADF: 0.1\n\n\u{1F9E0} STATE:\n  CURRENT: Active development\n');
  return path.join(aiDir, 'manifest.adf');
}

function manifestText(aiDir = '.ai'): string {
  return fs.readFileSync(path.join(aiDir, 'manifest.adf'), 'utf-8');
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

/** Lines of `after` not in `before` (multiset difference). */
function addedLines(before: string, after: string): string[] {
  const pool = before.split('\n');
  const added: string[] = [];
  for (const line of after.split('\n')) {
    const i = pool.indexOf(line);
    if (i === -1) added.push(line);
    else pool.splice(i, 1);
  }
  return added;
}

/**
 * Make agents.md and AGENTS.md one physical file. On a case-insensitive
 * filesystem one write already gives both names; on a case-sensitive one a hard
 * link does (the #344 trick), so the identity paths run on every host.
 */
function aliasedAgents(content: string): void {
  fs.writeFileSync('agents.md', content);
  if (!fs.existsSync('AGENTS.md')) fs.linkSync('agents.md', 'AGENTS.md');
}

// ============================================================================
// 1. Inference (INV-5)
// ============================================================================

describe('inferVendorMode', () => {
  const BANNER = `<!-- ${COMPILE_BANNER_MARKER} -->\n# CLAUDE.md\n\n- TypeScript monorepo\n`;
  const cases: Array<{ name: string; file: VendorFile; content: string; mode: string }> = [
    { name: 'compile banner', file: 'CLAUDE.md', content: BANNER, mode: 'compiled' },
    { name: 'plain CLAUDE.md pointer', file: 'CLAUDE.md', content: POINTER_CLAUDE_MD, mode: 'pointer' },
    { name: 'hybrid CLAUDE.md pointer', file: 'CLAUDE.md', content: POINTER_CLAUDE_MD_HYBRID, mode: 'pointer' },
    { name: '.cursorrules pointer', file: '.cursorrules', content: POINTER_CURSORRULES, mode: 'pointer' },
    { name: 'AGENTS.md pointer', file: 'AGENTS.md', content: POINTER_AGENTS_MD, mode: 'pointer' },
    { name: 'GEMINI.md pointer', file: 'GEMINI.md', content: POINTER_GEMINI_MD, mode: 'pointer' },
    { name: 'copilot pointer', file: 'copilot-instructions.md', content: POINTER_COPILOT_MD, mode: 'pointer' },
    {
      name: 'banner plus a quoted pointer marker (#296)',
      file: 'AGENTS.md',
      content: `${BANNER}\n- Never write "Do not duplicate ADF rules here" in vendor files.\n`,
      mode: 'compiled',
    },
    { name: 'hand-written', file: 'GEMINI.md', content: '# Gemini\n\nAlways use pnpm.\n', mode: 'unmanaged' },
  ];

  /** What `adf tidy --dry-run` does with the file today: the classification oracle. */
  async function tidyClassification(file: string): Promise<string> {
    const { json } = await runJson<{ files: Array<{ status: string }> }>(['tidy', '--dry-run', '--source', file]);
    const status = json.files[0].status;
    if (status === 'compiled') return 'compiled';
    if (status === 'not-found') return fs.existsSync(file) ? 'unmanaged' : 'absent';
    return 'pointer';
  }

  for (const c of cases) {
    it(`classifies ${c.name} as ${c.mode}, as adf tidy does`, async () => {
      scaffold();
      fs.writeFileSync(c.file, c.content);
      const evidence = inferVendorMode(c.file, c.content);
      expect(evidence.inferredMode).toBe(c.mode);
      expect(evidence.exists).toBe(true);
      expect(evidence.banner).toBe(c.content.includes(COMPILE_BANNER_MARKER));
      expect(await tidyClassification(c.file)).toBe(c.mode);
    });
  }

  it('reports an absent file with no mode', async () => {
    scaffold();
    expect(inferVendorMode('CLAUDE.md', null)).toEqual({ exists: false, banner: false, pointerMarkers: [], inferredMode: null });
    expect(await tidyClassification('CLAUDE.md')).toBe('absent');
  });

  it('never infers compiled for a pointer-only name', () => {
    expect(inferVendorMode('copilot-instructions.md', `<!-- ${COMPILE_BANNER_MARKER} -->\n`).inferredMode).toBe('unmanaged');
    expect(inferVendorMode('agents.md', `<!-- ${COMPILE_BANNER_MARKER} -->\n`).inferredMode).toBe('unmanaged');
  });

  it('resolves an unrecorded file to its inferred mode (INV-5)', () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    fs.writeFileSync('GEMINI.md', 'hand-written\n');
    expect(resolveVendorMode('.ai', 'CLAUDE.md')).toMatchObject({ mode: 'pointer', source: 'inferred', disagrees: false });
    expect(resolveVendorModes('.ai').map(r => [r.file, r.mode, r.source])).toEqual([
      ['CLAUDE.md', 'pointer', 'inferred'],
      ['GEMINI.md', 'unmanaged', 'inferred'],
    ]);
  });

  it('prefers a valid record and falls back to inference for an invalid entry', () => {
    scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}  - GEMINI.md: compiled\n  - GEMINI.md: bogus\n  - copilot-instructions.md: compiled\n`);
    fs.writeFileSync('CLAUDE.md', `<!-- ${COMPILE_BANNER_MARKER} -->\n`);
    fs.writeFileSync('copilot-instructions.md', POINTER_COPILOT_MD);
    expect(resolveVendorMode('.ai', 'CLAUDE.md')).toMatchObject({ mode: 'pointer', source: 'recorded', disagrees: true });
    expect(resolveVendorMode('.ai', 'GEMINI.md')).toMatchObject({ mode: 'compiled', source: 'recorded', disagrees: false });
    expect(resolveVendorMode('.ai', 'copilot-instructions.md')).toMatchObject({ mode: 'pointer', source: 'inferred' });
  });
});

// ============================================================================
// 2. Writer (INV-2, INV-7)
// ============================================================================

describe('recordVendorModes', () => {
  let warnings: string[];
  const onWarning = (w: string) => { warnings.push(w); };
  beforeEach(() => { warnings = []; });

  it('creates the VENDORS section at EOF, changing nothing else', () => {
    const manifestPath = scaffold();
    const result = recordVendorModes(manifestPath, [{ file: 'CLAUDE.md', mode: 'pointer' }], 'add-if-absent', { onWarning });
    expect(result.written).toBe(true);
    expect(result.results).toEqual([{ status: 'added', file: 'CLAUDE.md', mode: 'pointer' }]);
    expect(manifestText()).toBe(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\n  - CLAUDE.md: pointer\n`);
    expect(warnings).toEqual([]);
  });

  it('inserts into an existing section after its last item', () => {
    const manifestPath = scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}\n\u{1F4D0} RULES:\n  - Keep it small.\n`);
    const before = manifestText();
    recordVendorModes(manifestPath, [{ file: 'AGENTS.md', mode: 'compiled' }], 'add-if-absent');
    const after = manifestText();
    expect(addedLines(before, after)).toEqual(['  - AGENTS.md: compiled']);
    expect(after).toContain('  - CLAUDE.md: pointer\n  - AGENTS.md: compiled\n\n\u{1F4D0} RULES:');
  });

  it('keeps CRLF line endings', () => {
    const manifestPath = scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}`.replace(/\n/g, '\r\n'));
    recordVendorModes(manifestPath, [{ file: 'GEMINI.md', mode: 'pointer' }], 'add-if-absent');
    recordVendorModes(manifestPath, [{ file: 'CLAUDE.md', mode: 'compiled' }], 'upsert');
    const after = manifestText();
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
    expect(after.endsWith('  - CLAUDE.md: compiled\r\n  - GEMINI.md: pointer\r\n')).toBe(true);
  });

  it('keeps a missing trailing newline', () => {
    const manifestPath = scaffold(BASE_MANIFEST.trimEnd());
    recordVendorModes(manifestPath, [{ file: 'CLAUDE.md', mode: 'pointer' }], 'add-if-absent');
    expect(manifestText()).toBe(`${BASE_MANIFEST.trimEnd()}\n\n\u{1F3F7} VENDORS:\n  - CLAUDE.md: pointer`);
    const manifestPath2 = manifestPath;
    recordVendorModes(manifestPath2, [{ file: 'AGENTS.md', mode: 'pointer' }], 'add-if-absent');
    expect(manifestText().endsWith('  - CLAUDE.md: pointer\n  - AGENTS.md: pointer')).toBe(true);
  });

  it('upsert replaces exactly one line in place', () => {
    const manifestPath = scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}  - AGENTS.md: pointer\n`);
    const before = manifestText();
    const result = recordVendorModes(manifestPath, [{ file: 'CLAUDE.md', mode: 'compiled' }], 'upsert');
    expect(result.results).toEqual([{ status: 'updated', file: 'CLAUDE.md', mode: 'compiled', previous: 'pointer' }]);
    expect(manifestText()).toBe(before.replace('  - CLAUDE.md: pointer', '  - CLAUDE.md: compiled'));
  });

  it("keeps this repo's own manifest byte-identical apart from the new line", () => {
    const original = fs.readFileSync(path.join(__dirname, 'fixtures', 'charter-manifest.adf'), 'utf-8');
    const manifestPath = scaffold(original);
    recordVendorModes(manifestPath, [{ file: 'CLAUDE.md', mode: 'pointer' }, { file: 'AGENTS.md', mode: 'pointer' }], 'add-if-absent');
    const after = manifestText();
    expect(after.startsWith(original)).toBe(true);
    expect(addedLines(original, after).filter(l => l !== '')).toEqual([
      '\u{1F3F7} VENDORS:', '  - CLAUDE.md: pointer', '  - AGENTS.md: pointer',
    ]);
  });

  it('refuses to write when the re-parse guard sees any other change (INV-2)', () => {
    // Lone-CR line endings: the parser splits them, a line edit cannot place the
    // bullet, and the re-parse check catches the mismatch.
    const original = 'ADF: 0.1\r\r\u{1F3F7} VENDORS:\r  - CLAUDE.md: pointer\r';
    const manifestPath = scaffold(original);
    const add = recordVendorModes(manifestPath, [{ file: 'AGENTS.md', mode: 'pointer' }], 'add-if-absent', { onWarning });
    const upsert = recordVendorModes(manifestPath, [{ file: 'CLAUDE.md', mode: 'compiled' }], 'upsert', { onWarning });
    expect(add).toMatchObject({ written: false, results: [{ status: 'skipped', skipReason: 'reparse-guard' }] });
    expect(upsert).toMatchObject({ written: false, results: [{ status: 'skipped', skipReason: 'reparse-guard' }] });
    expect(manifestText()).toBe(original);
    expect(warnings[0]).toBe(`${manifestPath} could not be updated without changing its other entries; AGENTS.md was not recorded. Fix the manifest or run: charter doctor`);
  });

  it('add-if-absent never changes an existing entry', () => {
    const manifestPath = scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}`);
    const before = manifestText();
    const result = recordVendorModes(manifestPath, [{ file: 'CLAUDE.md', mode: 'compiled' }], 'add-if-absent', { onWarning, writer: 'adf compile --write' });
    expect(result).toMatchObject({ written: false, results: [{ status: 'skipped', skipReason: 'already-recorded' }] });
    expect(manifestText()).toBe(before);
    expect(warnings).toEqual(['CLAUDE.md is recorded as pointer but adf compile --write wrote it as compiled; record kept. To change it: charter adf vendor set CLAUDE.md compiled']);
  });

  it('rejects compiled for pointer-only names under every policy (INV-7)', () => {
    const manifestPath = scaffold();
    for (const policy of ['add-if-absent', 'upsert'] as const) {
      for (const file of ['agents.md', 'copilot-instructions.md'] as const) {
        const result = recordVendorModes(manifestPath, [{ file, mode: 'compiled' }], policy, { onWarning });
        expect(result.results).toEqual([{ status: 'skipped', file, mode: 'compiled', skipReason: 'mode-not-allowed' }]);
      }
    }
    expect(fs.rmSync(path.join('.ai', 'manifest.adf'))).toBeUndefined();
    expect(recordVendorModes(manifestPath, [{ file: 'agents.md', mode: 'compiled' }], 'upsert').results[0])
      .toMatchObject({ skipReason: 'mode-not-allowed' });
    expect(warnings[0]).toBe("agents.md cannot be 'compiled': no compile target writes it. Allowed: pointer, unmanaged");
  });

  it('writes nothing under dryRun and reports planned', () => {
    const manifestPath = scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}`);
    const before = manifestText();
    const result = recordVendorModes(manifestPath, [{ file: 'CLAUDE.md', mode: 'compiled' }, { file: 'GEMINI.md', mode: 'pointer' }], 'upsert', { dryRun: true });
    expect(result.written).toBe(false);
    expect(result.results).toEqual([
      { status: 'planned', file: 'CLAUDE.md', mode: 'compiled', previous: 'pointer' },
      { status: 'planned', file: 'GEMINI.md', mode: 'pointer', previous: null },
    ]);
    expect(manifestText()).toBe(before);
  });

  it('never rewrites a malformed entry for the file, or a non-list section', () => {
    const malformed = scaffold(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\n  - CLAUDE.md pointr\n`);
    expect(recordVendorModes(malformed, [{ file: 'CLAUDE.md', mode: 'pointer' }], 'upsert', { onWarning }).results[0])
      .toMatchObject({ status: 'skipped', skipReason: 'entry-malformed' });
    expect(warnings.pop()).toBe(`VENDORS in ${malformed} has an unreadable entry for CLAUDE.md ('CLAUDE.md pointr'); not rewritten. Fix that line by hand.`);

    const text = scaffold(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS: CLAUDE.md is a pointer\n`);
    const before = manifestText();
    expect(recordVendorModes(text, [{ file: 'CLAUDE.md', mode: 'pointer' }], 'upsert', { onWarning }).results[0])
      .toMatchObject({ status: 'skipped', skipReason: 'section-not-list' });
    expect(manifestText()).toBe(before);
  });

  it('skips when the manifest is missing or unparseable', () => {
    expect(recordVendorModes(path.join('.ai', 'manifest.adf'), [{ file: 'CLAUDE.md', mode: 'pointer' }], 'upsert', { onWarning }).results[0])
      .toMatchObject({ skipReason: 'manifest-missing' });
    const manifestPath = scaffold('ADF: 9.9\n');
    expect(recordVendorModes(manifestPath, [{ file: 'CLAUDE.md', mode: 'pointer' }], 'upsert', { onWarning }).results[0])
      .toMatchObject({ skipReason: 'manifest-unparseable' });
    expect(manifestText()).toBe('ADF: 9.9\n');
  });

  it('re-parses to the old document plus exactly the new entries', () => {
    const manifestPath = scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}`);
    const before = parseAdf(manifestText());
    recordVendorModes(manifestPath, [{ file: 'AGENTS.md', mode: 'pointer' }], 'add-if-absent');
    const after = parseAdf(manifestText());
    const vendors = after.sections.find(s => s.key === 'VENDORS');
    expect(vendors?.content).toEqual({ type: 'list', items: ['CLAUDE.md: pointer', 'AGENTS.md: pointer'] });
    expect(after.sections.filter(s => s.key !== 'VENDORS')).toEqual(before.sections.filter(s => s.key !== 'VENDORS'));
  });
});

describe('insertManifestBullet (INV-11)', () => {
  it('keeps the DEFAULT_LOAD and ON_DEMAND decorations by default', () => {
    expect(insertManifestBullet('ADF: 0.1\n', 'DEFAULT_LOAD', 'core.adf')).toBe('ADF: 0.1\n\n\u{1F4E6} DEFAULT_LOAD:\n  - core.adf\n');
    expect(insertManifestBullet('ADF: 0.1\n', 'ON_DEMAND', 'x.adf')).toBe('ADF: 0.1\n\n\u{1F4C2} ON_DEMAND:\n  - x.adf\n');
  });

  it('takes the decoration as a parameter for other keys', () => {
    expect(insertManifestBullet('ADF: 0.1\n', 'VENDORS', 'CLAUDE.md: pointer', '\u{1F3F7}'))
      .toBe('ADF: 0.1\n\n\u{1F3F7} VENDORS:\n  - CLAUDE.md: pointer\n');
  });
});

// ============================================================================
// 3. adf vendor set
// ============================================================================

describe('adf vendor set', () => {
  it('moves CLAUDE.md from pointer to compiled, then reports unchanged', async () => {
    scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}`);
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    const first = await run(['vendor', 'set', 'CLAUDE.md', 'compiled']);
    expect(first.code).toBe(0);
    expect(first.out).toContain('  [ok] CLAUDE.md: pointer -> compiled');
    expect(manifestText()).toContain('  - CLAUDE.md: compiled\n');
    expect(manifestText()).not.toContain('CLAUDE.md: pointer');

    const again = await runJson(['vendor', 'set', 'CLAUDE.md', 'compiled']);
    expect(again.code).toBe(0);
    expect(again.json).toEqual({
      manifestPath: path.join('.ai', 'manifest.adf'),
      written: false,
      result: { status: 'unchanged', file: 'CLAUDE.md', mode: 'compiled' },
    });
  });

  it('refuses compiled for copilot-instructions.md with exit 1', async () => {
    scaffold();
    const before = manifestText();
    const r = await run(['vendor', 'set', 'copilot-instructions.md', 'compiled']);
    expect(r.code).toBe(1);
    expect(r.err).toContain("copilot-instructions.md cannot be 'compiled': no compile target writes it. Allowed: pointer, unmanaged");
    expect(manifestText()).toBe(before);
  });

  it('rejects an unknown file, an unknown mode and bad usage with exit 2', async () => {
    scaffold();
    await expect(run(['vendor', 'set', 'README.md', 'pointer'])).rejects.toMatchObject({
      exitCode: 2,
      message: "Unknown vendor file 'README.md'. Expected one of: CLAUDE.md, AGENTS.md, .cursorrules, GEMINI.md, agents.md, copilot-instructions.md",
    });
    await expect(run(['vendor', 'set', 'CLAUDE.md', 'thin'])).rejects.toMatchObject({ exitCode: 2 });
    await expect(run(['vendor', 'set', 'CLAUDE.md'])).rejects.toMatchObject({
      exitCode: 2, message: 'Usage: charter adf vendor set <file> <pointer|compiled|unmanaged> [--dry-run]',
    });
  });

  it('exits 2 when the manifest is missing', async () => {
    await expect(run(['vendor', 'set', 'CLAUDE.md', 'pointer'])).rejects.toMatchObject({ exitCode: 2 });
  });

  it('writes nothing under --dry-run', async () => {
    scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}`);
    const before = manifestText();
    const r = await runJson<{ written: boolean; result: { status: string } }>(['vendor', 'set', 'CLAUDE.md', 'unmanaged', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.json.written).toBe(false);
    expect(r.json.result).toEqual({ status: 'planned', file: 'CLAUDE.md', mode: 'unmanaged', previous: 'pointer' });
    expect(manifestText()).toBe(before);
  });

  it('records an intended mode for an absent file', async () => {
    scaffold();
    const r = await run(['vendor', 'set', 'GEMINI.md', 'compiled']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("GEMINI.md does not exist yet; recording 'compiled' as its intended mode.");
    expect(manifestText()).toContain('  - GEMINI.md: compiled\n');
  });

  it('follows --ai-dir (INV-10)', async () => {
    scaffold(BASE_MANIFEST, 'ctx');
    const r = await run(['vendor', 'set', 'AGENTS.md', 'pointer', '--ai-dir', 'ctx']);
    expect(r.code).toBe(0);
    expect(manifestText('ctx')).toContain('  - AGENTS.md: pointer\n');
    expect(fs.existsSync('.ai')).toBe(false);
  });
});

// ============================================================================
// 4. adf vendor init (INV-6)
// ============================================================================

describe('adf vendor init', () => {
  it('records inferred modes once and is idempotent', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    fs.writeFileSync('GEMINI.md', `<!-- ${COMPILE_BANNER_MARKER} -->\n`);
    fs.writeFileSync('.cursorrules', 'Use tabs.\n');

    const first = await runJson<{ written: boolean; results: unknown[] }>(['vendor', 'init']);
    expect(first.code).toBe(0);
    expect(first.json.written).toBe(true);
    expect(first.json.results).toEqual([
      { status: 'added', file: 'CLAUDE.md', mode: 'pointer' },
      { status: 'added', file: '.cursorrules', mode: 'unmanaged' },
      { status: 'added', file: 'GEMINI.md', mode: 'compiled' },
    ]);
    const after = manifestText();

    const second = await run(['vendor', 'init']);
    expect(second.code).toBe(0);
    expect(second.out).toContain('  [ok] All vendor files on disk already have a recorded mode.');
    expect(manifestText()).toBe(after);
    const third = await runJson<{ written: boolean; results: Array<{ status: string }> }>(['vendor', 'init']);
    expect(third.json.written).toBe(false);
    expect(third.json.results.every(r => r.status === 'unchanged')).toBe(true);
  });

  it('never overwrites an entry, and reports recorded-but-absent files', async () => {
    scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}  - AGENTS.md: compiled\n`);
    fs.writeFileSync('CLAUDE.md', `<!-- ${COMPILE_BANNER_MARKER} -->\n`);
    const before = manifestText();
    const r = await runJson<{ written: boolean; results: unknown[] }>(['vendor', 'init']);
    expect(r.code).toBe(0);
    expect(r.json.results).toEqual([
      { status: 'skipped', file: 'CLAUDE.md', mode: 'compiled', skipReason: 'already-recorded' },
      { status: 'skipped', file: 'AGENTS.md', mode: 'compiled', skipReason: 'file-absent' },
    ]);
    expect(r.err).toContain('CLAUDE.md is recorded as pointer but looks compiled on disk; record kept. To change it: charter adf vendor set CLAUDE.md compiled');
    expect(manifestText()).toBe(before);
  });

  it('records AGENTS.md once when agents.md is the same file', async () => {
    scaffold();
    aliasedAgents(POINTER_AGENTS_MD);
    const r = await runJson<{ results: Array<{ file: string }> }>(['vendor', 'init']);
    expect(r.json.results.map(x => x.file)).toEqual(['AGENTS.md']);
    expect(manifestText()).not.toContain('agents.md');
  });

  it('exits 2 when the manifest is missing, and writes nothing under --dry-run', async () => {
    await expect(run(['vendor', 'init'])).rejects.toMatchObject({ exitCode: 2 });
    scaffold();
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    const r = await run(['vendor', 'init', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('[dry-run] Would record CLAUDE.md: pointer');
    expect(manifestText()).toBe(BASE_MANIFEST);
  });
});

// ============================================================================
// 5. adf vendor status (INV-3)
// ============================================================================

describe('adf vendor status', () => {
  it('prints recorded and inferred modes, and flags disagreement', async () => {
    scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}  - GEMINI.md: pointer\n`);
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    fs.writeFileSync('AGENTS.md', `<!-- ${COMPILE_BANNER_MARKER} -->\n`);
    fs.writeFileSync('GEMINI.md', `<!-- ${COMPILE_BANNER_MARKER} -->\n`);
    const r = await run(['vendor', 'status']);
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toEqual([
      `  Vendor file modes (${path.join('.ai', 'manifest.adf')}):`,
      '  CLAUDE.md  pointer  (recorded)',
      '  AGENTS.md  compiled  (inferred: compile banner)',
      '  GEMINI.md  pointer  (recorded; file looks compiled)',
      '  1 file(s) have no recorded mode. Record the inferred modes with: charter adf vendor init',
    ]);
  });

  it('emits the JSON shape', async () => {
    scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}  - README.md: pointer\n`);
    fs.writeFileSync('CLAUDE.md', `<!-- ${COMPILE_BANNER_MARKER} -->\n`);
    fs.writeFileSync('.cursorrules', POINTER_CURSORRULES);
    const r = await runJson<Record<string, unknown>>(['vendor', 'status']);
    expect(r.code).toBe(0);
    expect(Object.keys(r.json)).toEqual(['manifestPath', 'manifestFound', 'files', 'entryProblems', 'unrecorded', 'nextActions']);
    expect(r.json.manifestFound).toBe(true);
    expect(r.json.files).toEqual([
      {
        file: 'CLAUDE.md', mode: 'pointer', source: 'recorded', disagrees: true,
        evidence: { exists: true, banner: true, pointerMarkers: [], inferredMode: 'compiled' },
      },
      {
        file: '.cursorrules', mode: 'pointer', source: 'inferred', disagrees: false,
        evidence: { exists: true, banner: false, pointerMarkers: ['DO NOT modify this file. All project rules are managed in .ai/'], inferredMode: 'pointer' },
      },
    ]);
    expect(r.json.entryProblems).toEqual([{ raw: 'README.md: pointer', problem: 'unknown-file' }]);
    expect(r.json.unrecorded).toEqual(['.cursorrules']);
    expect(r.json.nextActions).toEqual(['charter adf vendor init']);
  });

  it('lists absent names with --all, and recorded absent files always', async () => {
    scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}`);
    const plain = await runJson<{ files: Array<{ file: string; evidence: { exists: boolean } }> }>(['vendor', 'status']);
    expect(plain.json.files.map(f => [f.file, f.evidence.exists])).toEqual([['CLAUDE.md', false]]);
    const all = await runJson<{ files: Array<{ file: string }> }>(['vendor', 'status', '--all']);
    expect(all.json.files.map(f => f.file)).toEqual([...VENDOR_FILES]);
  });

  it('warns about duplicate and malformed entries; the last valid entry wins', async () => {
    scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}  - CLAUDE.md: compiled\n  - nonsense\n`);
    const r = await runJson<{ files: Array<{ mode: string }>; entryProblems: unknown[] }>(['vendor', 'status']);
    expect(r.json.files[0].mode).toBe('compiled');
    expect(r.json.entryProblems).toEqual([
      { raw: 'nonsense', problem: 'malformed' },
      { raw: 'CLAUDE.md: pointer', problem: 'duplicate' },
    ]);
    expect(r.err).toContain(`Ignoring VENDORS entry 'CLAUDE.md: pointer' in ${path.join('.ai', 'manifest.adf')}: duplicate.`);
  });

  it('exits 0 with a warning when the manifest is missing', async () => {
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    const text = await run(['vendor', 'status']);
    expect(text.code).toBe(0);
    expect(text.out).toContain(`Warning: ${path.join('.ai', 'manifest.adf')} not found; showing inferred modes only.`);
    expect(text.out).toContain('  CLAUDE.md  pointer  (inferred: pointer marker)');
    const json = await runJson<{ manifestFound: boolean; nextActions: string[] }>(['vendor', 'status']);
    expect(json.code).toBe(0);
    expect(json.json.manifestFound).toBe(false);
    expect(json.json.nextActions).toEqual(['charter adf init']);
    expect(fs.existsSync('.ai')).toBe(false);
  });

  it('reads the record under --ai-dir (INV-10)', async () => {
    scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}`, 'ctx');
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    const r = await runJson<{ manifestPath: string; files: Array<{ source: string }> }>(['vendor', 'status', '--ai-dir', 'ctx']);
    expect(r.json.manifestPath).toBe(path.join('ctx', 'manifest.adf'));
    expect(r.json.files[0].source).toBe('recorded');
  });

  it('never writes the manifest (INV-3)', async () => {
    const manifestPath = scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}  - bogus\n`);
    fs.writeFileSync('AGENTS.md', POINTER_AGENTS_MD);
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(manifestPath, past, past);
    const before = manifestText();
    await run(['vendor', 'status']);
    await runJson(['vendor', 'status', '--all']);
    expect(manifestText()).toBe(before);
    expect(fs.statSync(manifestPath).mtimeMs).toBe(past.getTime());
  });
});

// ============================================================================
// 6. Implicit writers (INV-8, INV-9)
// ============================================================================

describe('implicit writers', () => {
  it('adf init --emit-pointers records pointer for each pointer it wrote', async () => {
    fs.writeFileSync('GEMINI.md', 'hand-written\n');
    const r = await run(['init', '--emit-pointers']);
    expect(r.code).toBe(0);
    const text = manifestText();
    for (const f of ['CLAUDE.md', '.cursorrules', 'AGENTS.md', 'copilot-instructions.md']) {
      expect(text).toContain(`  - ${f}: pointer\n`);
    }
    // Skipped because it already existed: not written, so not recorded.
    expect(text).not.toContain('GEMINI.md');
  });

  it('adf compile --write records compiled; --check and stdout never write (INV-3)', async () => {
    scaffold();
    await run(['compile', '--target', 'claude', '--check']);
    await run(['compile', '--target', 'claude']);
    expect(manifestText()).toBe(BASE_MANIFEST);

    const r = await runJson<{ written: string[] }>(['compile', '--target', 'claude', '--write']);
    expect(r.code).toBe(0);
    expect(r.json.written).toEqual(['CLAUDE.md']);
    expect(manifestText()).toBe(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\n  - CLAUDE.md: compiled\n`);
  });

  it('adf compile --write keeps an existing entry and only warns', async () => {
    scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}`);
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    const before = manifestText();
    const r = await run(['compile', '--target', 'claude', '--write']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('  [warn] CLAUDE.md is recorded as pointer but adf compile --write wrote it as compiled; record kept. To change it: charter adf vendor set CLAUDE.md compiled');
    expect(manifestText()).toBe(before);
  });

  it('a record-write failure leaves the exit code and JSON unchanged (INV-9)', async () => {
    scaffold();
    const baseline = await runJson(['compile', '--target', 'agents', '--write']);
    fs.rmSync('AGENTS.md');
    scaffold(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS: not a list\n`);
    const broken = await runJson(['compile', '--target', 'agents', '--write']);
    expect(broken.code).toBe(baseline.code);
    expect(broken.json).toEqual(baseline.json);
    expect(broken.err).toContain('VENDORS in');
    expect(broken.err).toContain('does not read as a list');
    expect(broken.err).toContain('AGENTS.md was not recorded.');
  });

  it('adf migrate records pointer after a real migration, not under --dry-run', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', '# Project\n\n## Rules\n\n- Always use pnpm for installs.\n');
    await run(['migrate', '--dry-run', '--no-backup']);
    expect(manifestText()).not.toContain('VENDORS');
    const r = await run(['migrate', '--no-backup']);
    expect(r.code).toBe(0);
    expect(manifestText()).toContain('  - CLAUDE.md: pointer\n');
  });

  it('bootstrap records pointers and routes writer warnings into the phase step (CP-7)', async () => {
    const args = ['--yes', '--skip-install', '--skip-doctor'];
    expect(await bootstrapCommand({ ...TEXT, yes: true }, args)).toBe(0);
    const text = manifestText();
    for (const f of ['CLAUDE.md', '.cursorrules', 'AGENTS.md', 'GEMINI.md', 'copilot-instructions.md']) {
      expect(text).toContain(`  - ${f}: pointer\n`);
    }

    // A record that cannot be written: the warning joins the adf-init step's JSON
    // warnings, and bootstrap's exit code is unchanged.
    for (const f of ['CLAUDE.md', '.cursorrules', 'AGENTS.md', 'GEMINI.md', 'copilot-instructions.md']) fs.rmSync(f);
    const broken = `${text.slice(0, text.indexOf('\n\u{1F3F7} VENDORS:'))}\n\n\u{1F3F7} VENDORS: hand-written\n`;
    fs.writeFileSync(path.join('.ai', 'manifest.adf'), broken);
    out = [];
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, [...args, '--format', 'json'])).toBe(0);
    const payload = JSON.parse(out.join('\n')) as { steps: Array<{ name: string; warnings: string[] }> };
    const step = payload.steps.find(s => s.name === 'adf-init');
    expect(step?.warnings).toContain(`VENDORS in ${path.join('.ai', 'manifest.adf')} does not read as a list: every line under it must be an item like "  - CLAUDE.md: pointer" (ADF has no comment lines). CLAUDE.md was not recorded.`);
    expect(fs.existsSync('CLAUDE.md')).toBe(true);
    expect(manifestText()).toBe(broken);
  });

  it('bootstrap keeps an existing entry for a pointer it writes', async () => {
    const args = ['--yes', '--skip-install', '--skip-doctor'];
    scaffold(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\n  - GEMINI.md: compiled\n`);
    out = [];
    expect(await bootstrapCommand({ ...JSON_OPTS, yes: true }, [...args, '--format', 'json'])).toBe(0);
    const payload = JSON.parse(out.join('\n')) as { steps: Array<{ name: string; warnings: string[] }> };
    expect(payload.steps.find(s => s.name === 'adf-init')?.warnings).toContain(
      'GEMINI.md is recorded as compiled but bootstrap wrote it as pointer; record kept. To change it: charter adf vendor set GEMINI.md pointer',
    );
    expect(manifestText()).toContain('  - GEMINI.md: compiled\n  - CLAUDE.md: pointer\n');
  });
});

// ============================================================================
// 7. No consumer behaviour change (INV-1)
// ============================================================================

describe('consumers ignore the record (INV-1)', () => {
  type Run = { code: number; out: string; err: string };

  /** Run `steps` in two fresh repos, identical except for a VENDORS section. */
  async function compare(setup: () => void, steps: Array<() => Promise<Run>>): Promise<void> {
    const results: Run[][] = [];
    for (const withVendors of [false, true]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-vendor-inv1-'));
      process.chdir(dir);
      try {
        scaffold(withVendors
          // copilot-instructions.md is recorded but never created: a recorded-but-absent file.
          ? `${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\n  - CLAUDE.md: pointer\n  - AGENTS.md: compiled\n  - GEMINI.md: unmanaged\n  - .cursorrules: compiled\n  - copilot-instructions.md: pointer\n`
          : BASE_MANIFEST);
        setup();
        const runs: Run[] = [];
        for (const step of steps) {
          const r = await step();
          // The only allowed difference: the implicit writers' record warnings.
          const errLines = r.err.split('\n').filter(l => !/record kept|VENDORS|vendor modes/.test(l)).join('\n');
          const norm = (s: string) => s.split(dir).join('<tmp>').split(path.basename(dir)).join('<tmp>')
            .replace(/"generatedAt": "[^"]+"/g, '"generatedAt": "<t>"');
          runs.push({ ...r, out: norm(r.out), err: norm(errLines) });
        }
        // Vendor files on disk end up byte-identical too.
        runs.push({ code: 0, out: ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules'].map(f => fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : '<absent>').join('\n---\n'), err: '' });
        results.push(runs);
      } finally {
        process.chdir(tmp);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    expect(results[1]).toEqual(results[0]);
  }

  const setupVendorFiles = () => {
    fs.writeFileSync('CLAUDE.md', `${POINTER_CLAUDE_MD}\n## Notes\n\n- Always run pnpm test before pushing.\n`);
    fs.writeFileSync('GEMINI.md', `<!-- ${COMPILE_BANNER_MARKER} -->\nold\n`);
    fs.writeFileSync('.cursorrules', 'hand-written rules\n');
  };

  it('compile --check, --write and stdout are unchanged', async () => {
    await compare(setupVendorFiles, [
      () => run(['compile', '--target', 'all', '--check']),
      () => run(['compile', '--target', 'all', '--check', '--format', 'json'], JSON_OPTS),
      () => run(['compile', '--target', 'claude']),
      () => run(['compile', '--target', 'all', '--write', '--format', 'json'], JSON_OPTS),
      () => run(['compile', '--target', 'all', '--check']),
    ]);
  });

  it('compile output never contains VENDORS (INV-4)', async () => {
    scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}`);
    const r = await run(['compile', '--target', 'claude']);
    expect(r.out).not.toContain('VENDORS');
  });

  it('tidy is unchanged', async () => {
    await compare(setupVendorFiles, [
      () => run(['tidy', '--dry-run', '--format', 'json'], JSON_OPTS),
      () => run(['tidy']),
    ]);
  });

  it('doctor is unchanged', async () => {
    const doctor = async (options: CLIOptions, args: string[]): Promise<Run> => {
      out = [];
      err = [];
      const code = await doctorCommand(options, args);
      return { code, out: out.join('\n'), err: err.join('\n') };
    };
    await compare(setupVendorFiles, [
      () => doctor(TEXT, []),
      () => doctor(JSON_OPTS, []),
    ]);
  });

  it('score is unchanged, including non-unique vendor basenames', async () => {
    const score = async (options: CLIOptions): Promise<Run> => {
      out = [];
      err = [];
      const code = await scoreCommand(options, []);
      return { code, out: out.join('\n'), err: err.join('\n') };
    };
    await compare(() => {
      setupVendorFiles();
      // A monorepo with per-package agent files: the basenames are not unique.
      fs.mkdirSync(path.join('packages', 'a'), { recursive: true });
      fs.writeFileSync(path.join('packages', 'a', 'CLAUDE.md'), '# Package a\n');
      fs.writeFileSync(path.join('packages', 'a', 'AGENTS.md'), '# Package a\n');
    }, [
      () => score(JSON_OPTS),
      () => score(TEXT),
    ]);
  });
});

describe('withoutVendorsSection', () => {
  it('returns a manifest without VENDORS unchanged', () => {
    expect(withoutVendorsSection(BASE_MANIFEST)).toBe(BASE_MANIFEST);
  });

  it('removes VENDORS at EOF or mid-file and keeps every other section', () => {
    expect(withoutVendorsSection(`${BASE_MANIFEST}${VENDORS_BLOCK}`)).toBe(BASE_MANIFEST);
    const mid = `${BASE_MANIFEST}${VENDORS_BLOCK}\n\u{1F4D0} RULES:\n  - Keep it small.\n`;
    const stripped = withoutVendorsSection(mid);
    expect(stripped).not.toContain('VENDORS');
    expect(parseAdf(stripped).sections).toEqual(parseAdf(mid).sections.filter(s => s.key !== 'VENDORS'));
  });
});

// ============================================================================
// 8. adf fmt round-trip: the writer's output is canonical
// ============================================================================

describe('VENDORS survives adf fmt', () => {
  const canonical = formatAdf(parseAdf(BASE_MANIFEST));
  const roundTrips = (): void => {
    const text = manifestText();
    expect(formatAdf(parseAdf(text))).toBe(text);
  };

  it('stays canonical when the writer creates, extends and upserts the section', () => {
    const manifestPath = scaffold(canonical);
    recordVendorModes(manifestPath, [{ file: 'CLAUDE.md', mode: 'pointer' }], 'add-if-absent');
    expect(manifestText()).toContain('\u{1F3F7} VENDORS:\n');
    roundTrips();
    recordVendorModes(manifestPath, [{ file: 'AGENTS.md', mode: 'compiled' }], 'add-if-absent');
    roundTrips();
    recordVendorModes(manifestPath, [{ file: 'CLAUDE.md', mode: 'unmanaged' }], 'upsert');
    roundTrips();
  });

  it('adf fmt --check passes after vendor set', async () => {
    scaffold(canonical);
    expect((await run(['fmt', path.join('.ai', 'manifest.adf'), '--check'])).code).toBe(0);
    expect((await run(['vendor', 'set', 'CLAUDE.md', 'pointer'])).code).toBe(0);
    expect((await run(['fmt', path.join('.ai', 'manifest.adf'), '--check'])).code).toBe(0);
  });
});

// ============================================================================
// 9. One physical file, one record (AGENTS.md / agents.md)
// ============================================================================

describe('vendor file identity', () => {
  it('vendor set maps another spelling of a recorded file to the recorded one', async () => {
    scaffold(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\n  - AGENTS.md: unmanaged\n`);
    aliasedAgents('# legacy agents\n');
    const r = await run(['vendor', 'set', 'agents.md', 'pointer']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('agents.md is the same file as AGENTS.md on disk; recorded under AGENTS.md.');
    expect(r.out).not.toContain('does not exist yet');
    expect(r.out).toContain('  [ok] AGENTS.md: unmanaged -> pointer');
    expect(manifestText()).toBe(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\n  - AGENTS.md: pointer\n`);
  });

  it('keeps the legacy spelling when that is the one recorded', async () => {
    scaffold(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\n  - agents.md: pointer\n`);
    aliasedAgents(POINTER_AGENTS_MD);
    const before = manifestText();
    const init = await runJson<{ results: unknown[] }>(['vendor', 'init']);
    expect(init.json.results).toEqual([{ status: 'unchanged', file: 'agents.md', mode: 'pointer' }]);
    expect(manifestText()).toBe(before);
    const status = await runJson<{ files: Array<{ file: string; source: string; evidence: { exists: boolean } }>; unrecorded: string[] }>(['vendor', 'status']);
    expect(status.json.files.map(f => [f.file, f.source, f.evidence.exists])).toEqual([['agents.md', 'recorded', true]]);
    expect(status.json.unrecorded).toEqual([]);
  });

  it('adf migrate --source agents.md does not split the record', async () => {
    scaffold(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\n  - AGENTS.md: unmanaged\n`);
    aliasedAgents('# Agents\n\n## Rules\n\n- Always use pnpm for installs.\n');
    const r = await run(['migrate', '--source', 'agents.md', '--no-backup']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('AGENTS.md is recorded as unmanaged but adf migrate wrote it as pointer; record kept.');
    const vendors = parseAdf(manifestText()).sections.find(s => s.key === 'VENDORS');
    expect(vendors?.content).toEqual({ type: 'list', items: ['AGENTS.md: unmanaged'] });
  });

  it('status shows one row when both spellings are recorded, and says which is used', async () => {
    scaffold(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\n  - AGENTS.md: unmanaged\n  - agents.md: pointer\n`);
    aliasedAgents(POINTER_AGENTS_MD);
    const r = await runJson<{ files: Array<{ file: string; mode: string }> }>(['vendor', 'status']);
    expect(r.json.files).toEqual([expect.objectContaining({ file: 'AGENTS.md', mode: 'unmanaged', disagrees: true })]);
    expect(r.err).toContain('records both AGENTS.md and agents.md, which are the same file on disk; AGENTS.md is used.');
    expect(resolveVendorMode('.ai', 'agents.md')).toMatchObject({ file: 'AGENTS.md', mode: 'unmanaged' });
  });
});

// ============================================================================
// 10. Last VENDORS section wins; comment lines
// ============================================================================

describe('VENDORS edge cases', () => {
  it('an empty last VENDORS section means no entries, for the library and the CLI alike', async () => {
    scaffold(`${BASE_MANIFEST}${VENDORS_BLOCK}\n\u{1F3F7} VENDORS:\n`);
    fs.writeFileSync('CLAUDE.md', `<!-- ${COMPILE_BANNER_MARKER} -->\n`);
    expect(parseManifest(parseAdf(manifestText())).vendors).toEqual([]);
    expect(resolveVendorMode('.ai', 'CLAUDE.md')).toMatchObject({ mode: 'compiled', source: 'inferred' });
  });

  it('names the real problem when VENDORS holds a non-item line', async () => {
    scaffold(`${BASE_MANIFEST}\n\u{1F3F7} VENDORS:\n  # recorded by bootstrap\n  - CLAUDE.md: pointer\n`);
    const r = await run(['vendor', 'set', 'AGENTS.md', 'pointer']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('does not read as a list: every line under it must be an item like "  - CLAUDE.md: pointer" (ADF has no comment lines). AGENTS.md was not recorded.');
  });
});

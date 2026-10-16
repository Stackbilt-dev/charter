/**
 * `adf tidy --source` is repeatable and `--print-paths` reports what tidy wrote
 * (#320, PR 4 of the #318 sequence). The pre-commit hook relies on both.
 *
 * Pins INV-P4-5 (a single --source, and no --source, behave exactly as on main
 * @ 01d2834, against output captured from that commit) and INV-P4-6 (the JSON
 * change is the additive `paths` field only).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPILE_BANNER_MARKER } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { adfCommand, POINTER_AGENTS_MD, POINTER_CLAUDE_MD, POINTER_GEMINI_MD } from '../commands/adf';

// Identity is mocked per test so case-insensitive de-dup is tested without
// relying on the host filesystem's case sensitivity.
const FAKE_IDENTITY = vi.hoisted((): Record<string, string> => ({}));

vi.mock('../commands/adf-migrate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commands/adf-migrate')>();
  return {
    ...actual,
    fileIdentity: (fullPath: string) => FAKE_IDENTITY[path.basename(fullPath)] ?? actual.fileIdentity(fullPath),
  };
});

const TEXT: CLIOptions = { configPath: '.charter', format: 'text', ciMode: false, yes: false };
const JSON_OPTS: CLIOptions = { ...TEXT, format: 'json' };

// The scenario the golden fixture was captured from (main @ 01d2834).
const BASE_MANIFEST = ['ADF: 0.1', '', '\u{1F3AF} ROLE: Test project', '', '\u{1F4E6} DEFAULT_LOAD:', '  - core.adf', '  - state.adf', '', '\u{1F4C2} ON_DEMAND:', '  - frontend.adf (Triggers on: React, CSS)', ''].join('\n');
const CORE_ADF = 'ADF: 0.1\n\n\u{1F4CB} CONTEXT:\n  - TypeScript monorepo\n\n⚠️ CONSTRAINTS [load-bearing]:\n  - No secrets in commits\n';
const BLOATED_CLAUDE = `${POINTER_CLAUDE_MD}\n## Testing\n\n- Always run pnpm test before pushing to main.\n- Never skip the integration suite in CI.\n\n## Frontend\n\n- Use React hooks and CSS modules for styling.\n`;
const BLOATED_GEMINI = `${POINTER_GEMINI_MD}\n## Testing\n\n- Always run pnpm test before pushing to main.\n`;

interface GoldenRun { code: number; out: string; err: string; files: Record<string, string> }
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tidy-single-source.main-01d2834.json'), 'utf-8')) as Record<string, GoldenRun>;

const originalCwd = process.cwd();
let tmp = '';
let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-tidy-sources-'));
  process.chdir(tmp);
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  for (const key of Object.keys(FAKE_IDENTITY)) delete FAKE_IDENTITY[key];
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function scaffold(): void {
  fs.mkdirSync('.ai', { recursive: true });
  fs.writeFileSync('.ai/manifest.adf', BASE_MANIFEST);
  fs.writeFileSync('.ai/core.adf', CORE_ADF);
  fs.writeFileSync('.ai/state.adf', 'ADF: 0.1\n\n\u{1F9E0} STATE:\n  CURRENT: Active development\n');
  fs.writeFileSync('CLAUDE.md', BLOATED_CLAUDE);
}

function snapshot(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const f of ['CLAUDE.md', ...fs.readdirSync('.ai').sort().map(x => `.ai/${x}`)]) files[f] = fs.readFileSync(f, 'utf-8');
  return files;
}

async function run(args: string[], options: CLIOptions = TEXT): Promise<{ code: number; out: string; err: string }> {
  out = [];
  err = [];
  const code = await adfCommand(options, args);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

interface TidyJson {
  files: Array<{ file: string; status: string }>;
  totalExtracted: number;
  modulesModified: string[];
  paths: { vendor: string[]; modules: string[] };
}

async function runJson(args: string[]): Promise<{ code: number; json: TidyJson; raw: string }> {
  const r = await run([...args, '--format', 'json'], JSON_OPTS);
  return { code: r.code, json: JSON.parse(r.out) as TidyJson, raw: r.out };
}

/** Main's JSON for the same run: the new output with the additive `paths` key removed. */
function withoutPaths(raw: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  expect(Object.keys(parsed).pop()).toBe('paths');
  delete parsed.paths;
  return JSON.stringify(parsed, null, 2);
}

describe('INV-P4-5: a single --source, and no --source, match main byte for byte', () => {
  it.each([
    ['dryText', ['tidy', '--dry-run', '--source', 'CLAUDE.md'], TEXT],
    ['realText', ['tidy', '--source', 'CLAUDE.md'], TEXT],
    ['missingText', ['tidy', '--source', 'GEMINI.md'], TEXT],
    ['wholeText', ['tidy', '--dry-run'], TEXT],
  ] as const)('%s', async (label, args, options) => {
    scaffold();
    const r = await run([...args], options);
    const golden = GOLDEN[label];
    expect(r.code).toBe(golden.code);
    expect(r.out).toBe(golden.out);
    expect(r.err).toBe(golden.err);
    expect(snapshot()).toEqual(golden.files);
  });

  it.each([
    ['dryJson', ['tidy', '--dry-run', '--source', 'CLAUDE.md']],
    ['realJson', ['tidy', '--source', 'CLAUDE.md']],
    ['missingJson', ['tidy', '--source', 'GEMINI.md']],
  ] as const)('%s (INV-P4-6: only `paths` is added)', async (label, args) => {
    scaffold();
    const r = await run([...args, '--format', 'json'], JSON_OPTS);
    const golden = GOLDEN[label];
    expect(r.code).toBe(golden.code);
    expect(withoutPaths(r.out)).toBe(golden.out);
    expect(snapshot()).toEqual(golden.files);
  });
});

describe('--source is repeatable', () => {
  it('processes every value in argument order, one result per file', async () => {
    scaffold();
    fs.writeFileSync('GEMINI.md', BLOATED_GEMINI);
    const r = await runJson(['tidy', '--dry-run', '--source', 'GEMINI.md', '--source', 'CLAUDE.md']);
    expect(r.json.files.map(f => [f.file, f.status])).toEqual([['GEMINI.md', 'tidied'], ['CLAUDE.md', 'tidied']]);
    expect(r.json.paths.vendor).toEqual(['GEMINI.md', 'CLAUDE.md']);
  });

  it('leaves an unnamed vendor file alone (INV-P4-2 at the CLI level)', async () => {
    scaffold();
    fs.writeFileSync('GEMINI.md', BLOATED_GEMINI);
    await run(['tidy', '--source', 'CLAUDE.md']);
    expect(fs.readFileSync('GEMINI.md', 'utf-8')).toBe(BLOATED_GEMINI);
    expect(fs.readFileSync('CLAUDE.md', 'utf-8')).toBe(POINTER_CLAUDE_MD);
  });

  it('drops a second name for the same file when identities match (case-insensitive mount, mocked)', async () => {
    scaffold();
    // Two real files, so the result does not depend on the host's case folding;
    // the mocked identity says they are one file, as on a case-insensitive mount.
    fs.mkdirSync('upper');
    fs.mkdirSync('lower');
    fs.writeFileSync('upper/AGENTS.md', `${POINTER_AGENTS_MD}\n## Testing\n\n- Always run pnpm test before pushing to main.\n`);
    fs.writeFileSync('lower/agents.md', 'not read');
    FAKE_IDENTITY['AGENTS.md'] = '9:42';
    FAKE_IDENTITY['agents.md'] = '9:42';
    const r = await runJson(['tidy', '--dry-run', '--source', 'upper/AGENTS.md', '--source', 'lower/agents.md']);
    expect(r.json.files.map(f => f.file)).toEqual(['upper/AGENTS.md']);
  });

  it('drops a hard link to a file already named', async () => {
    scaffold();
    fs.linkSync('CLAUDE.md', 'CLAUDE-link.md');
    const r = await runJson(['tidy', '--dry-run', '--source', 'CLAUDE.md', '--source', 'CLAUDE-link.md', '--source', './CLAUDE.md']);
    expect(r.json.files.map(f => f.file)).toEqual(['CLAUDE.md']);
  });

  it('keeps one result for a repeated missing path, reported not-found', async () => {
    scaffold();
    const r = await runJson(['tidy', '--dry-run', '--source', 'GEMINI.md', '--source', 'GEMINI.md']);
    expect(r.code).toBe(0);
    expect(r.json.files.map(f => [f.file, f.status])).toEqual([['GEMINI.md', 'not-found']]);
  });

  it.each([
    ['as the last argument', ['tidy', '--source', 'CLAUDE.md', '--source']],
    ['followed by another flag', ['tidy', '--source', '--dry-run']],
  ])('a --source with no value is a usage error (exit 2) %s, and nothing is written', async (_label, args) => {
    scaffold();
    const before = snapshot();
    await expect(run(args)).rejects.toMatchObject({
      name: 'CLIError',
      exitCode: 2,
      message: '--source needs a file path, e.g. --source CLAUDE.md. Repeat it to tidy several files.',
    });
    expect(snapshot()).toEqual(before);
  });
});

describe('--print-paths', () => {
  it('prints exactly the typed lines under --dry-run, matching JSON paths, and writes nothing', async () => {
    scaffold();
    fs.writeFileSync('GEMINI.md', BLOATED_GEMINI);
    const before = snapshot();
    const r = await run(['tidy', '--dry-run', '--print-paths', '--source', 'GEMINI.md', '--source', 'CLAUDE.md']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(['vendor GEMINI.md', 'vendor CLAUDE.md', 'module .ai/qa.adf', 'module .ai/frontend.adf'].join('\n'));
    expect(snapshot()).toEqual(before);
    const json = await runJson(['tidy', '--dry-run', '--source', 'GEMINI.md', '--source', 'CLAUDE.md']);
    expect(json.json.paths).toEqual({ vendor: ['GEMINI.md', 'CLAUDE.md'], modules: ['.ai/qa.adf', '.ai/frontend.adf'] });
    expect(json.json.modulesModified).toEqual(['qa.adf', 'frontend.adf']);
  });

  it('a real run prints the same lines for the files it wrote, and they are the files that changed', async () => {
    scaffold();
    const before = snapshot();
    const r = await run(['tidy', '--print-paths', '--source', 'CLAUDE.md']);
    expect(r.out).toBe(['vendor CLAUDE.md', 'module .ai/qa.adf', 'module .ai/frontend.adf'].join('\n'));
    const after = snapshot();
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(f => before[f] !== after[f]).sort();
    expect(changed).toEqual(['.ai/frontend.adf', '.ai/qa.adf', 'CLAUDE.md']);
  });

  it('prints nothing for a clean file, and sends skip warnings to stderr, not stdout', async () => {
    scaffold();
    fs.writeFileSync('CLAUDE.md', POINTER_CLAUDE_MD);
    fs.writeFileSync('AGENTS.md', `${COMPILE_BANNER_MARKER}\n# Compiled\n\n## Constraints\n\n- Keep API contracts stable\n`);
    const r = await run(['tidy', '--dry-run', '--print-paths', '--source', 'CLAUDE.md', '--source', 'AGENTS.md']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toContain('AGENTS.md is `charter adf compile` output');
  });

  it('reports a restore-only rewrite as a vendor line with no module line (CP-5)', async () => {
    scaffold();
    // The only bloat item is already in core.adf, so nothing is extracted, but
    // tidy still rewrites the pointer to drop it.
    fs.writeFileSync('CLAUDE.md', `${POINTER_CLAUDE_MD}\n## Rules\n\n- No secrets in commits\n`);
    const dry = await run(['tidy', '--dry-run', '--print-paths', '--source', 'CLAUDE.md']);
    expect(dry.out).toBe('vendor CLAUDE.md');
    const real = await run(['tidy', '--print-paths', '--source', 'CLAUDE.md']);
    expect(real.out).toBe('vendor CLAUDE.md');
    expect(fs.readFileSync('CLAUDE.md', 'utf-8')).toBe(POINTER_CLAUDE_MD);
  });

  it('prints repo-relative POSIX paths for a nested source and a non-default --ai-dir', async () => {
    scaffold();
    fs.renameSync('.ai', 'ctx');
    fs.mkdirSync('docs');
    fs.writeFileSync('docs/CLAUDE.md', BLOATED_CLAUDE);
    const r = await run(['tidy', '--dry-run', '--print-paths', '--ai-dir', 'ctx', '--source', path.join('docs', 'CLAUDE.md')]);
    expect(r.out).toBe(['vendor docs/CLAUDE.md', 'module ctx/qa.adf', 'module ctx/frontend.adf'].join('\n'));
  });

  it('cannot be combined with --format json (exit 2)', async () => {
    scaffold();
    await expect(run(['tidy', '--print-paths', '--source', 'CLAUDE.md', '--format', 'json'], JSON_OPTS)).rejects.toMatchObject({
      name: 'CLIError',
      exitCode: 2,
      message: '--print-paths prints plain paths; it cannot be combined with --format json.',
    });
    expect(fs.readFileSync('CLAUDE.md', 'utf-8')).toBe(BLOATED_CLAUDE);
  });

  it('prints nothing at all when there are no vendor files', async () => {
    fs.mkdirSync('.ai');
    fs.writeFileSync('.ai/manifest.adf', BASE_MANIFEST);
    const r = await run(['tidy', '--print-paths']);
    expect(r.out).toBe('');
  });
});

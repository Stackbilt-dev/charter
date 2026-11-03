import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adfCommand, POINTER_CLAUDE_MD, POINTER_CLAUDE_MD_HYBRID, POINTER_COPILOT_MD } from '../commands/adf';
import { bootstrapCommand } from '../commands/bootstrap';
import { COPILOT_INSTRUCTIONS_FILE as FILE, copilotPointer, isGithubCopilotFile } from '../commands/copilot-pointer';
import { discoverAgentConfigFiles, updateModuleIndex } from '../commands/adf-migrate';
import { countExtractable } from '../commands/adf-tidy';
import { recordVendorModes, resolveVendorMode, restoredPointer } from '../commands/adf-vendor';
import { doctorCommand } from '../commands/doctor';
import { scoreCommand } from '../commands/score';
import type { CLIOptions } from '../index';

const originalCwd = process.cwd();
const options: CLIOptions = { configPath: '.charter', format: 'json', ciMode: false, yes: false };
let tmp: string;
let lines: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-copilot-'));
  process.chdir(tmp);
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const read = (file: string): string => fs.readFileSync(file, 'utf8');
function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
async function adf(args: string[]): Promise<{ code: number; json: any }> {
  lines = [];
  const code = await adfCommand(options, args);
  return { code, json: JSON.parse(lines.join('\n')) };
}
async function bootstrap(force = false): Promise<number> {
  lines = [];
  return bootstrapCommand({ ...options, yes: true }, ['--yes', '--skip-install', '--skip-doctor', ...(force ? ['--force'] : [])]);
}

describe('Copilot repository instructions (#403)', () => {
  it('renders location-correct links at call time without changing the legacy export', () => {
    expect(FILE).toBe('.github/copilot-instructions.md');
    expect(copilotPointer()).toContain('See ../.ai/manifest.adf');
    expect(POINTER_COPILOT_MD).toContain('See .ai/manifest.adf');
    expect(POINTER_COPILOT_MD).not.toContain('../.ai');
    const aiDir = path.resolve('policy context');
    expect(copilotPointer(aiDir)).toContain('See ../policy context/manifest.adf');
    fs.mkdirSync('nested');
    process.chdir('nested');
    expect(copilotPointer(aiDir)).toContain('See ../../policy context/manifest.adf');
    expect(restoredPointer(FILE, null, aiDir)).toBe(copilotPointer(aiDir));
  });

  it('normalizes native separators without changing literal POSIX backslashes', () => {
    const content = copilotPointer('policy\\name');
    const expected = path.relative(path.resolve('.github'), path.resolve('policy\\name')).split(path.sep).join('/');
    expect(content).toContain(`See ${expected}/manifest.adf`);
    if (path.sep === '/') expect(content).toContain('policy\\name');
  });

  it('creates the canonical file and its parent on a fresh pointer init', async () => {
    const r = await adf(['init', '--emit-pointers']);
    expect(r.code).toBe(0);
    expect(r.json.pointers).toContain(FILE);
    expect(read(FILE)).toBe(copilotPointer());
    expect(fs.existsSync('copilot-instructions.md')).toBe(false);
    expect(read('.ai/manifest.adf')).toContain(`  - ${FILE}: pointer`);
    expect(resolveVendorMode('.ai', FILE)).toMatchObject({ mode: 'pointer', source: 'recorded' });
  });

  it('uses the selected AI directory for a canonical init pointer', async () => {
    await adf(['init', '--emit-pointers', '--ai-dir', 'rules/context']);
    expect(read(FILE)).toBe(copilotPointer('rules/context'));
    expect(read(FILE)).toContain('../rules/context/manifest.adf');
    expect(fs.existsSync(path.resolve('.github', '../rules/context/manifest.adf'))).toBe(true);
    lines = [];
    await scoreCommand(options, ['--ai-dir', 'rules/context']);
    const score = JSON.parse(lines.join('\n'));
    expect(score.signals.grounding.filesScanned).toContain(FILE);
    expect(score.signals.grounding.pathReferences.broken.filter((p: string) => p.startsWith('.github/'))).toEqual([]);
  });

  it.each(['LF', 'CRLF'])('scores generated targets with spaces and %s without hiding missing user paths', async (ending) => {
    const aiDir = 'policy context';
    await adf(['init', '--emit-pointers', '--ai-dir', aiDir]);
    const source = (read(FILE) + '\nUser requires ../missing-decision.md\n').replace(/\n/g, ending === 'CRLF' ? '\r\n' : '\n');
    write(FILE, source);
    lines = [];
    await scoreCommand(options, ['--ai-dir', aiDir]);
    let broken = JSON.parse(lines.join('\n')).signals.grounding.pathReferences.broken as string[];
    expect(broken).not.toContain('policy');
    expect(broken).not.toContain('.github/context/manifest.adf');
    expect(broken).toContain('missing-decision.md');
    fs.unlinkSync(path.join(aiDir, 'manifest.adf'));
    lines = [];
    await scoreCommand(options, ['--ai-dir', aiDir]);
    broken = JSON.parse(lines.join('\n')).signals.grounding.pathReferences.broken as string[];
    expect(broken).toContain('policy context/manifest.adf');
    expect(broken).toContain('missing-decision.md');
    expect(read(FILE)).toBe(source);
  });

  it('skips an existing canonical file on init and preserves a legacy root file byte-for-byte', async () => {
    const custom = '# Custom Copilot\r\nKeep these instructions.\r\n';
    const legacy = '# Legacy user instructions\r\nLeave me alone.\r\n';
    write(FILE, custom);
    write('copilot-instructions.md', legacy);
    await adf(['init', '--emit-pointers']);
    await adf(['init', '--emit-pointers', '--force']);
    expect(read(FILE)).toBe(custom);
    expect(read('copilot-instructions.md')).toBe(legacy);
    expect(read('.ai/manifest.adf')).not.toContain(`  - ${FILE}: pointer`);
  });

  it('bootstraps five vendors but keeps only four compilable targets', async () => {
    execFileSync('git', ['init', '-q']);
    expect(await bootstrap()).toBe(0);
    expect(read(FILE)).toBe(copilotPointer());
    expect(fs.existsSync('copilot-instructions.md')).toBe(false);
    const status = await adf(['vendor', 'status']);
    expect(status.json.files).toHaveLength(5);
    expect(status.json.files.find((f: any) => f.file === FILE)).toMatchObject({ mode: 'pointer', source: 'recorded' });
    const check = await adf(['compile', '--target', 'all', '--check']);
    expect(check.code).toBe(0);
    expect(check.json.targets).toHaveLength(4);
    expect(check.json.targets.map((f: any) => f.file)).not.toContain(FILE);
    lines = [];
    expect(resolveVendorMode('.ai', FILE).evidence.inferredMode, read(FILE)).toBe('pointer');
    const doctorCode = await doctorCommand({ ...options, ciMode: true }, ['--adf-only']);
    expect(doctorCode, lines.join('\n')).toBe(0);
    expect(lines.join('\n')).toContain(FILE);
    lines = [];
    await scoreCommand(options);
    const score = JSON.parse(lines.join('\n'));
    expect(score.signals.grounding.pathReferences.broken.join(' ')).not.toContain('.github/.ai');
  });

  it('never overwrites hand-authored canonical or legacy content, including bootstrap force', async () => {
    const custom = '# GitHub Copilot\r\nUse our own policy.\r\n';
    write(FILE, custom);
    write('copilot-instructions.md', 'legacy custom\r\n');
    await adf(['init']);
    recordVendorModes('.ai/manifest.adf', [{ file: 'copilot-instructions.md', mode: 'unmanaged' }], 'upsert');
    expect(await bootstrap()).toBe(0);
    expect(await bootstrap(true)).toBe(0);
    expect(read(FILE)).toBe(custom);
    expect(read('copilot-instructions.md')).toBe('legacy custom\r\n');
  });

  it('preserves recorded unmanaged canonical absence under forced bootstrap', async () => {
    await adf(['init']);
    recordVendorModes('.ai/manifest.adf', [{ file: FILE, mode: 'unmanaged' }], 'upsert');
    await bootstrap(true);
    expect(fs.existsSync(FILE)).toBe(false);
    expect(resolveVendorMode('.ai', FILE)).toMatchObject({ mode: 'unmanaged', source: 'recorded' });
  });

  it('keeps legacy root vendor records and content while adding the canonical pointer', async () => {
    await adf(['init']);
    write('copilot-instructions.md', POINTER_COPILOT_MD);
    recordVendorModes('.ai/manifest.adf', [{ file: 'copilot-instructions.md', mode: 'unmanaged' }], 'upsert');
    await bootstrap();
    expect(read('copilot-instructions.md')).toBe(POINTER_COPILOT_MD);
    expect(resolveVendorMode('.ai', 'copilot-instructions.md').mode).toBe('unmanaged');
    expect(resolveVendorMode('.ai', FILE).mode).toBe('pointer');
  });

  it('keeps both Copilot names pointer-only and the legacy API operational', async () => {
    await adf(['init']);
    for (const file of [FILE, 'copilot-instructions.md']) {
      const r = await adf(['vendor', 'set', file, 'compiled']);
      expect(r.code).toBe(1);
    }
    expect((await adf(['vendor', 'restore', 'copilot-instructions.md'])).code).toBe(0);
    expect(read('copilot-instructions.md')).toBe(POINTER_COPILOT_MD);
  });

  it('plans restore without a parent and creates it only on an actual restore', async () => {
    await adf(['init']);
    const before = read('.ai/manifest.adf');
    expect((await adf(['vendor', 'restore', FILE, '--dry-run'])).json.status).toBe('planned');
    expect(fs.existsSync('.github')).toBe(false);
    expect(read('.ai/manifest.adf')).toBe(before);
    expect((await adf(['vendor', 'restore', FILE])).json.status).toBe('restored');
    expect(read(FILE)).toBe(copilotPointer());
  });

  it('rolls back the vendor record when the canonical parent cannot be created', async () => {
    await adf(['init']);
    write('.github', 'not a directory\r\n');
    const before = read('.ai/manifest.adf');
    const r = await adf(['vendor', 'restore', FILE]);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', refusal: 'write-failed' });
    expect(read('.ai/manifest.adf')).toBe(before);
    expect(read('.github')).toBe('not a directory\r\n');
  });

  it('recognizes canonical identity at call time and retains distinct legacy discovery', () => {
    write(FILE, copilotPointer());
    write('copilot-instructions.md', POINTER_COPILOT_MD);
    expect(isGithubCopilotFile(path.resolve(FILE))).toBe(true);
    expect(isGithubCopilotFile('copilot-instructions.md')).toBe(false);
    expect(isGithubCopilotFile('.github\\copilot-instructions.md')).toBe(path.sep === '\\');
    expect(discoverAgentConfigFiles()).toEqual([FILE, 'copilot-instructions.md']);
  });

  it('accepts a case variant only when it identifies the canonical physical file', () => {
    write(FILE, copilotPointer());
    const variant = '.GITHUB/COPILOT-INSTRUCTIONS.MD';
    const folded = fs.existsSync(variant);
    expect(isGithubCopilotFile(variant)).toBe(folded);
    if (!folded) {
      write(variant, 'a distinct hand-authored file');
      expect(isGithubCopilotFile(variant)).toBe(false);
    }
  });

  it('deduplicates canonical and legacy names only when they are one physical file', () => {
    write(FILE, copilotPointer());
    fs.linkSync(FILE, 'copilot-instructions.md');
    expect(discoverAgentConfigFiles()).toEqual([FILE]);
  });

  it('does not auto-migrate an unmanaged canonical file through its legacy hard link', async () => {
    const custom = '# User Copilot\r\n\r\n## Database Rules\r\n- Queries must be parameterized.\r\n';
    write(FILE, custom);
    fs.linkSync(FILE, 'copilot-instructions.md');
    expect(await bootstrap()).toBe(0);
    expect(await bootstrap(true)).toBe(0);
    expect(read(FILE)).toBe(custom);
    expect(read('copilot-instructions.md')).toBe(custom);
  });

  it.each(['CLAUDE.md', 'GEMINI.md', 'AGENTS.md', '.cursorrules'])('preserves unmanaged canonical content aliased by %s', async (alias) => {
    const custom = '# User Copilot\r\n\r\n## Database Rules\r\n- Queries must be parameterized.\r\n';
    write(FILE, custom);
    fs.linkSync(FILE, alias);
    expect(await bootstrap()).toBe(0);
    expect(await bootstrap(true)).toBe(0);
    expect(read(FILE)).toBe(custom);
    expect(read(alias)).toBe(custom);
  });

  it('preserves explicit canonical unmanaged intent through a managed force-write alias', async () => {
    await adf(['init']);
    const current = POINTER_CLAUDE_MD + '\nUser Copilot notes must remain.\n';
    write(FILE, current);
    fs.linkSync(FILE, 'CLAUDE.md');
    fs.appendFileSync('.ai/manifest.adf', '\nVENDORS:\n  - .github/copilot-instructions.md: unmanaged\n  - CLAUDE.md: pointer\n');
    expect(await bootstrap(true)).toBe(0);
    expect(read(FILE)).toBe(current);
    expect(read('CLAUDE.md')).toBe(current);
  });

  it('does not refresh a module index through an unmanaged canonical hybrid alias', async () => {
    await adf(['init']);
    const current = POINTER_CLAUDE_MD_HYBRID + '\nUser Copilot notes must remain.\n';
    write(FILE, current);
    fs.linkSync(FILE, 'CLAUDE.md');
    fs.appendFileSync('.ai/manifest.adf', '\nVENDORS:\n  - .github/copilot-instructions.md: unmanaged\n  - CLAUDE.md: pointer\n');
    write('.ai/custom.adf', 'ADF: 0.1\nROLE: Custom project module\n');
    updateModuleIndex('CLAUDE.md', '.ai');
    expect(read(FILE)).toBe(current);
    expect(await bootstrap()).toBe(0);
    expect(read('.ai/manifest.adf')).toContain('custom.adf (Triggers on: custom)');
    expect(await bootstrap(true)).toBe(0);
    expect(read(FILE)).toBe(current);
    expect(read('CLAUDE.md')).toBe(current);
  });

  it('still refreshes an ordinary non-aliased hybrid module index', async () => {
    await adf(['init']);
    write('CLAUDE.md', POINTER_CLAUDE_MD_HYBRID);
    expect(await bootstrap()).toBe(0);
    expect(read('CLAUDE.md')).toContain('frontend.adf');
    expect(read('CLAUDE.md')).not.toBe(POINTER_CLAUDE_MD_HYBRID);
  });

  it('retains ordinary non-aliased CLAUDE automatic migration', async () => {
    const original = '# Project\n\n## Database Rules\n- Database queries must use parameterized statements.\n';
    write('CLAUDE.md', original);
    expect(await bootstrap()).toBe(0);
    expect(read('CLAUDE.md.pre-adf-migrate.bak')).toBe(original);
    expect(read('CLAUDE.md')).toContain('DO NOT add rules');
    expect(read(FILE)).toBe(copilotPointer());
  });

  it('tidies canonical instructions using their location-correct template', async () => {
    await adf(['init', '--emit-pointers']);
    expect(countExtractable(FILE, '.ai')).toBe(0);
    write(FILE, `${read(FILE)}\n## Database Rules\n- Database queries must use parameterized statements.\n`);
    expect((await adf(['tidy', '--source', FILE])).code).toBe(0);
    expect(read(FILE)).toContain(copilotPointer());
    expect(countExtractable(FILE, '.ai')).toBe(0);
  });

  it('migrates canonical content with a same-parent backup and keeps the legacy root untouched', async () => {
    await adf(['init']);
    const custom = '# Copilot\r\n\r\n## Database Rules\r\n- Database queries must use parameterized statements.\r\n';
    write(FILE, custom);
    write('copilot-instructions.md', 'user legacy\r\n');
    const result = await adf(['migrate', '--source', FILE, '--replace']);
    expect(result.code).toBe(0);
    expect(read(`${FILE}.pre-adf-migrate.bak`)).toBe(custom);
    expect(read(FILE)).toContain(copilotPointer());
    expect(read('copilot-instructions.md')).toBe('user legacy\r\n');
    expect(resolveVendorMode('.ai', FILE).mode).toBe('pointer');
  });
});

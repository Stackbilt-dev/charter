import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { bootstrapCommand } from '../commands/bootstrap';
import { contextRefreshCommand } from '../commands/context-refresh';
import { doctorCommand } from '../commands/doctor';
import { POINTER_CLAUDE_MD, POINTER_CLAUDE_MD_HYBRID } from '../commands/adf';
import { isGeneratedContextModule, stripGeneratedPointerSession } from '../commands/generated-context';

const options: CLIOptions = { configPath: '.charter', format: 'json', ciMode: false, yes: true };
const args = ['--ci', 'github', '--preset', 'fullstack', '--mode', 'lean', '--yes', '--skip-install', '--skip-doctor'];
const originalCwd = process.cwd();
let dir: string;
let output: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-generated-context-'));
  process.chdir(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync('package.json', JSON.stringify({ name: 'context-fixture', version: '1.0.0', scripts: { test: 'node --test' } }));
  output = [];
  vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.map(String).join(' ')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function bootstrap(): Promise<void> {
  expect(await bootstrapCommand(options, args)).toBe(0);
}

async function doctor(): Promise<{ exit: number; bloat: { status: string; details: string } }> {
  output = [];
  const exit = await doctorCommand({ ...options, ciMode: true }, ['--adf-only', '--ci']);
  const report = JSON.parse(output.join('\n'));
  return { exit, bloat: report.checks.find((check: { name: string }) => check.name === 'adf vendor bloat') };
}

describe('generated context does not become routed instructions (#401)', () => {
  it('keeps a real bootstrap/refresh/bootstrap cycle clean without routing the snapshot', async () => {
    await bootstrap();
    expect(await contextRefreshCommand(options, ['--once', '--sources', 'git'])).toBe(0);
    const generated = fs.readFileSync('.ai/context.adf', 'utf8');
    expect(isGeneratedContextModule('context.adf', generated)).toBe(true);
    await bootstrap();
    const manifest = fs.readFileSync('.ai/manifest.adf', 'utf8');
    expect(manifest).not.toContain('context.adf');
    expect(fs.readFileSync('.ai/context.adf', 'utf8')).toBe(generated);
    expect(await doctor()).toMatchObject({ exit: 0, bloat: { status: 'PASS' } });
  });

  it('preserves an explicitly registered legacy snapshot and ignores only generated pointer text', async () => {
    await bootstrap();
    await contextRefreshCommand(options, ['--once', '--sources', 'git']);
    const manifest = fs.readFileSync('.ai/manifest.adf', 'utf8');
    expect(manifest).toContain('ON_DEMAND:\n');
    fs.writeFileSync('.ai/manifest.adf', manifest.replace('ON_DEMAND:\n', 'ON_DEMAND:\n  - context.adf (Triggers on: context)\n'));
    const before = fs.readFileSync('.ai/manifest.adf', 'utf8');
    await bootstrap();
    expect(fs.readFileSync('.ai/manifest.adf', 'utf8')).toContain('context.adf (Triggers on: context)');
    expect(before.match(/context\.adf/g)).toHaveLength(1);
    expect(await doctor()).toMatchObject({ exit: 0, bloat: { status: 'PASS' } });
    fs.appendFileSync('CLAUDE.md', '\n## Project notes\ncontext context\n');
    expect(await doctor()).toMatchObject({ exit: 1, bloat: { status: 'WARN' } });
  });

  it('still registers a hand-authored context module and reports genuine user trigger density', async () => {
    await bootstrap();
    fs.writeFileSync('.ai/context.adf', 'ADF: 0.1\nROLE: My hand-written context instructions\nRULES:\n  - Review changes\n');
    await bootstrap();
    expect(fs.readFileSync('.ai/manifest.adf', 'utf8')).toContain('context.adf');
    expect(await doctor()).toMatchObject({ bloat: { status: 'PASS' } });
    fs.appendFileSync('CLAUDE.md', '\n## Project notes\ncontext context\n');
    const result = await doctor();
    expect(result.exit).toBe(1);
    expect(result.bloat.details).toContain('context (2x)');
  });

  it('does not classify a partial signature or another file as a generated runtime artifact', async () => {
    await contextRefreshCommand(options, ['--once', '--sources', 'git', '--ai-dir', 'custom-ai']);
    const generated = fs.readFileSync('custom-ai/context.adf', 'utf8');
    expect(isGeneratedContextModule('context.adf', generated.replace(/\n/g, '\r\n'))).toBe(true);
    expect(isGeneratedContextModule('manual.adf', generated)).toBe(false);
    expect(isGeneratedContextModule('context.adf', generated.replace('EXPIRES_AT:', 'MY_EXPIRY:'))).toBe(false);
    expect(isGeneratedContextModule('context.adf', generated + '\n📐 RULES:\n  - My custom instructions\n')).toBe(false);
  });
});

describe('canonical pointer session exclusion', () => {
  it.each([POINTER_CLAUDE_MD, POINTER_CLAUDE_MD_HYBRID])('removes only one exact generated block and leaves additions', template => {
    const custom = '\n## Project notes\ncontext context\n';
    const result = stripGeneratedPointerSession('CLAUDE.md', template.replace(/\n/g, '\r\n') + custom);
    expect(result).not.toContain('Call `charter_context`');
    expect(result).toContain(custom);
    expect(result).toContain('## Environment');
    expect(stripGeneratedPointerSession('README.md', template)).toBe(template);
  });

  it('keeps edited instructions and additional copies visible', () => {
    const edited = POINTER_CLAUDE_MD.replace('before any other action', 'before context context');
    expect(stripGeneratedPointerSession('CLAUDE.md', edited)).toBe(edited);
    const doubled = POINTER_CLAUDE_MD + POINTER_CLAUDE_MD;
    expect(stripGeneratedPointerSession('CLAUDE.md', doubled)).toContain('Call `charter_context`');
  });
});

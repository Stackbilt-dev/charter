/**
 * Integration: the built CLI's `bootstrap --reset-adf` never waits on a closed
 * or non-TTY stdin, and phase 6 populate is scaffold-only end to end (#354).
 *
 * Runs dist/bin.js (built by `pnpm build`) as a child process, the way CI does.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CORE_SCAFFOLD, MANIFEST_BACKEND_SCAFFOLD } from '../../commands/adf';

const CLI_BIN = path.resolve(__dirname, '../../../dist/bin.js');
const tempDirs: string[] = [];

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-354-cli-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-354' }));
  return dir;
}

function run(dir: string, args: string[], stdin: 'ignore' | 'closed-pipe'): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_BIN, 'bootstrap', ...args], {
    cwd: dir,
    encoding: 'utf-8',
    timeout: 60_000,
    ...(stdin === 'ignore' ? { stdio: ['ignore', 'pipe', 'pipe'] } : { input: '' }),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Every file under `dir` with its content. The CLI wrapper's passive telemetry
 * log (.charter/telemetry/, gitignored, written after every command by index.ts)
 * is left out: it is not bootstrap's write and predates #354.
 */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (path.relative(dir, p) === path.join('.charter', 'telemetry')) continue;
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}:${fs.readFileSync(p, 'utf-8')}`);
    }
  };
  walk(dir);
  return out.sort();
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('bootstrap --reset-adf (built CLI)', () => {
  for (const stdin of ['ignore', 'closed-pipe'] as const) {
    it(`refuses with exit 1 and writes nothing when stdin is ${stdin}`, () => {
      const dir = repo();
      fs.mkdirSync(path.join(dir, '.ai'));
      fs.writeFileSync(path.join(dir, '.ai', 'core.adf'), 'ADF: 0.1\n\nCONTEXT:\n  - mine\n');
      const before = tree(dir);
      const r = run(dir, ['--reset-adf', '--preset', 'worker', '--skip-install', '--skip-doctor'], stdin);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Re-run with --reset-adf --yes to confirm, or use --force to merge instead.');
      expect(tree(dir)).toEqual(before);
      expect(fs.readdirSync(path.join(dir, '.charter'))).toEqual(['telemetry']);
    });
  }

  it('--format json refusal is one valid JSON document', () => {
    const dir = repo();
    const r = run(dir, ['--reset-adf', '--format', 'json', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore');
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).resetAdf).toEqual({ kind: 'refused-non-interactive', exitCode: 1 });
  });
});

describe('bootstrap phase 6 populate is scaffold-only (built CLI, INV-10)', () => {
  it('plain --yes keeps a hand-written CONTEXT and fills a scaffold one', () => {
    const dir = repo();
    fs.mkdirSync(path.join(dir, '.ai'));
    fs.writeFileSync(path.join(dir, '.ai', 'manifest.adf'), MANIFEST_BACKEND_SCAFFOLD);
    const hand = CORE_SCAFFOLD.replace("  - Project context (run 'charter adf populate' to auto-fill from codebase)", '  - Hand-written context');
    fs.writeFileSync(path.join(dir, '.ai', 'core.adf'), hand);
    const r = run(dir, ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, '.ai', 'core.adf'), 'utf-8')).toBe(hand);
    // state.adf was created from the scaffold in this run, so populate filled it.
    expect(fs.readFileSync(path.join(dir, '.ai', 'state.adf'), 'utf-8')).not.toContain('Repository initialized with ADF context system');
  });

  it('bootstrap --format json prints exactly one JSON document', () => {
    const dir = repo();
    const r = run(dir, ['--yes', '--format', 'json', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore');
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.steps.find((s: { name: string }) => s.name === 'populate').status).toBe('pass');
  });
});

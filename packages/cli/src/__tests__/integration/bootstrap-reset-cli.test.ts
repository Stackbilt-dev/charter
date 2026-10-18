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
import { CORE_SCAFFOLD, MANIFEST_BACKEND_SCAFFOLD, STATE_SCAFFOLD } from '../../commands/adf';

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
    fs.mkdirSync(path.join(dir, '.ai'));
    fs.writeFileSync(path.join(dir, '.ai', 'core.adf'), 'ADF: 0.1\n\nCONTEXT:\n  - mine\n');
    const r = run(dir, ['--reset-adf', '--format', 'json', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore');
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).resetAdf).toEqual({ kind: 'refused-non-interactive', exitCode: 1 });
  });

  // #373: with nothing to replace (no .ai/ yet) there is nothing to confirm.
  it('proceeds without --yes when no scaffold file exists to replace', () => {
    const dir = repo();
    const r = run(dir, ['--reset-adf', '--format', 'json', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).resetAdf).toEqual({ kind: 'nothing-to-replace' });
    expect(fs.readFileSync(path.join(dir, '.ai', 'core.adf'), 'utf-8')).toContain('ADF: 0.1');
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

// ============================================================================
// Review of #372: populate writes in place, fills only untouched sections, and
// the output says what happened.
// ============================================================================

const WORKER_PKG = JSON.stringify({ name: 'demo-354', dependencies: { hono: '^4.0.0' }, devDependencies: { wrangler: '^3.0.0' } });

function workerRepo(): string {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'package.json'), WORKER_PKG);
  fs.writeFileSync(path.join(dir, 'wrangler.toml'), 'name = "demo"\n');
  return dir;
}

const CF_RULE = 'No Node.js-specific APIs in Worker handlers; use CF-native APIs (fetch, KV, D1, R2)';
const read = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, rel), 'utf-8');

describe('populate never reformats or overwrites user content (built CLI)', () => {
  it('CRLF, non-canonical order, no scaffold text, CF constraint missing: --force --yes changes nothing and says why (#371)', () => {
    const dir = workerRepo();
    expect(run(dir, ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore').status).toBe(0);
    const core = [
      'ADF: 0.1',
      '\u{1F4CA} METRICS:',
      '  entry_loc: 120 / 150 [lines]',
      '',
      '\u{1F4CB} CONTEXT:',
      '  - Hand-written context',
      '',
      '\u26A0\uFE0F CONSTRAINTS [load-bearing]:',
      '    - Never commit secrets',
      '',
      '\u{1F4D6} GUIDE [advisory]:',
      '  - mine',
    ].join('\r\n') + '\r\n';
    fs.writeFileSync(path.join(dir, '.ai', 'core.adf'), core);
    // A repo from before the populate record (#371): no .ai/.populate.json.
    fs.rmSync(path.join(dir, '.ai', '.populate.json'));
    const r = run(dir, ['--force', '--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore');
    expect(r.status).toBe(0);
    // CONSTRAINTS differs from the template (defaults deleted/reworded), so the
    // stack constraint is not added (#371): the file is byte-identical.
    expect(read(dir, '.ai/core.adf')).toBe(core);
    expect(r.stdout).toContain('  Unchanged by merge: .ai/core.adf');
    expect(r.stdout).not.toContain('Added CONSTRAINTS item');
    expect(r.stdout).toContain(`CONSTRAINTS has been edited, so populate did not add the stack constraint: ${CF_RULE}. Add it by hand if you want it`);
    expect(r.stdout).not.toMatch(/populate --force/);
    expect(r.stdout).toContain('  Created .ai/.populate.json');
    // Warned once: the constraint is now recorded as offered, so a second run is quiet.
    const record = read(dir, '.ai/.populate.json');
    const again = run(dir, ['--force', '--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore');
    expect(read(dir, '.ai/core.adf')).toBe(core);
    expect(again.stdout).toContain('  No scaffold content to replace');
    expect(again.stdout).not.toContain('CONSTRAINTS has been edited');
    expect(read(dir, '.ai/.populate.json')).toBe(record);
  });

  it('#371: bootstrap --format json reports a not-added constraint as a structured field, once', () => {
    const dir = workerRepo();
    expect(run(dir, ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore').status).toBe(0);
    const core = read(dir, '.ai/core.adf').replace('  - Never commit secrets or credentials\n', '');
    fs.writeFileSync(path.join(dir, '.ai', 'core.adf'), core);
    // The stack gains plain-JS ESM after the section was edited.
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...JSON.parse(WORKER_PKG), type: 'module' }));
    const step = (): { details: { notAdded: unknown[] }; warnings: string[] } => {
      const r = run(dir, ['--format', 'json', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore');
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout).steps.find((s: { name: string }) => s.name === 'populate');
    };
    const first = step();
    expect(first.details.notAdded).toEqual([{
      file: '.ai/core.adf', section: 'CONSTRAINTS', why: 'edited',
      constraints: ['Use .js extensions for all ESM imports (never .ts in import paths)'],
    }]);
    expect(first.warnings.join('\n')).toContain('CONSTRAINTS has been edited');
    const second = step();
    expect(second.details.notAdded).toEqual([]);
    expect(second.warnings).toEqual([]);
    expect(read(dir, '.ai/core.adf')).toBe(core);
  });

  for (const flags of [[], ['--yes'], ['--force', '--yes']]) {
    it(`#371: a deleted default and a deleted populate bullet stay deleted across bootstrap ${flags.join(' ') || '(no flags)'} re-runs`, () => {
      const dir = workerRepo();
      // type: module with no tsconfig/typescript: populate also wants the ESM rule.
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...JSON.parse(WORKER_PKG), type: 'module' }));
      const boot = [...flags, '--preset', 'worker', '--skip-install', '--skip-doctor'];
      const fresh = run(dir, ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore');
      expect(fresh.status).toBe(0);
      expect(fresh.stdout).toContain('  Created .ai/.populate.json');
      const first = read(dir, '.ai/core.adf');
      const record = read(dir, '.ai/.populate.json');
      expect(first.split(CF_RULE).length - 1).toBe(1);
      expect(first).toContain('Use .js extensions for all ESM imports');
      // A second bootstrap over its own result is idempotent, record included.
      expect(run(dir, boot, 'ignore').status).toBe(0);
      expect(read(dir, '.ai/core.adf')).toBe(first);
      expect(read(dir, '.ai/.populate.json')).toBe(record);

      const edited = first.replace('  - Never commit secrets or credentials\n', '').replace(`  - ${CF_RULE}\n`, '');
      fs.writeFileSync(path.join(dir, '.ai', 'core.adf'), edited);
      for (let i = 0; i < 2; i++) {
        const r = run(dir, [...boot, '--format', 'json'], 'ignore');
        expect(r.status).toBe(0);
        expect(read(dir, '.ai/core.adf')).toBe(edited);
        expect(read(dir, '.ai/.populate.json')).toBe(record);
        // CF_RULE is recorded as added: nothing new, so nothing to warn about.
        const populate = JSON.parse(r.stdout).steps.find((s: { name: string }) => s.name === 'populate');
        expect(populate.details.notAdded).toEqual([]);
        expect(populate.warnings).toEqual([]);
      }
    });
  }

  for (const flags of [[], ['--yes'], ['--force', '--yes']]) {
    it(`#371: plain Worker (one constraint): deleting it sticks across bootstrap ${flags.join(' ') || '(no flags)'} re-runs`, () => {
      const dir = workerRepo();
      expect(run(dir, ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore').status).toBe(0);
      const edited = read(dir, '.ai/core.adf').replace(`  - ${CF_RULE}\n`, '');
      fs.writeFileSync(path.join(dir, '.ai', 'core.adf'), edited);
      for (let i = 0; i < 2; i++) {
        const r = run(dir, [...flags, '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore');
        expect(r.status).toBe(0);
        expect(r.stdout).not.toContain('Added CONSTRAINTS item');
        expect(read(dir, '.ai/core.adf')).toBe(edited);
      }
    });
  }

  for (const flags of [[], ['--yes'], ['--force', '--yes']]) {
    it(`a partially edited CONTEXT and STATE survive bootstrap ${flags.join(' ') || '(no flags)'}`, () => {
      const dir = workerRepo();
      fs.mkdirSync(path.join(dir, '.ai'));
      fs.writeFileSync(path.join(dir, '.ai', 'manifest.adf'), MANIFEST_BACKEND_SCAFFOLD);
      const core = CORE_SCAFFOLD.replace("auto-fill from codebase)\n", 'auto-fill from codebase)\n  - CUSTOM: billing team owns src/pay\n')
        .replace('  - Pure functions in library code; side effects only in entry points\n', '  - Pure functions in library code; side effects only in entry points\n  - No Node.js-specific APIs in Worker handlers; use CF-native APIs (fetch, KV, D1, R2)\n');
      const state = STATE_SCAFFOLD.replace('  NEXT: Configure on-demand modules for your stack\n', '  NEXT: Configure on-demand modules for your stack\n  BLOCKED: waiting on legal sign-off for EU\n');
      fs.writeFileSync(path.join(dir, '.ai', 'core.adf'), core);
      fs.writeFileSync(path.join(dir, '.ai', 'state.adf'), state);
      expect(run(dir, [...flags, '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore').status).toBe(0);
      expect(read(dir, '.ai/core.adf')).toBe(core);
      expect(read(dir, '.ai/state.adf')).toBe(state);
    });
  }

  it('a still-scaffold CONTEXT is filled, and the output says so after "Unchanged by merge"', () => {
    const dir = workerRepo();
    fs.mkdirSync(path.join(dir, '.ai'));
    fs.writeFileSync(path.join(dir, '.ai', 'manifest.adf'), MANIFEST_BACKEND_SCAFFOLD);
    fs.writeFileSync(path.join(dir, '.ai', 'core.adf'), CORE_SCAFFOLD.replace('entry_loc: 0 / 500', 'entry_loc: 120 / 150'));
    const r = run(dir, ['--force', '--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore');
    expect(r.stdout).toContain('  Unchanged by merge: .ai/core.adf');
    expect(r.stdout).toContain('  Filled CONTEXT in .ai/core.adf');
    expect(read(dir, '.ai/core.adf')).toContain('entry_loc: 120 / 150 [lines]');
    expect(read(dir, '.ai/core.adf')).toContain('project: demo-354');
  });
});

describe('--reset-adf --yes loss report against the final files (built CLI)', () => {
  it('does not report CONTEXT/STATE that populate refilled identically', () => {
    const dir = workerRepo();
    expect(run(dir, ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore').status).toBe(0);
    const state = read(dir, '.ai/state.adf');
    const r = run(dir, ['--reset-adf', '--yes', '--format', 'json', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore');
    expect(r.status).toBe(0);
    const init = JSON.parse(r.stdout).steps.find((s: { name: string }) => s.name === 'adf-init');
    const stateOutcome = init.details.scaffolds.find((o: { file: string }) => o.file === '.ai/state.adf');
    expect(stateOutcome.kind).toBe('replaced');
    expect(stateOutcome.lost.itemsLost).toEqual([]);
    expect(read(dir, '.ai/state.adf')).toBe(state);
    const text = run(dir, ['--reset-adf', '--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore').stdout;
    expect(text).toMatch(/ {2}\.ai\/state\.adf \(backup: \S+\): nothing lost/);
  });
});

describe('populate cleans generated values (built CLI, second review)', () => {
  for (const description of ['Demo app ', 'Demo\nsecond line', 'Demo\tapp']) {
    it(`bootstrap --yes fills CONTEXT and adds the stack constraint for description ${JSON.stringify(description)}`, () => {
      const dir = repo();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-354', description, devDependencies: { wrangler: '^3.0.0' } }));
      fs.writeFileSync(path.join(dir, 'wrangler.toml'), 'name = "demo"\n');
      const r = run(dir, ['--yes', '--format', 'json', '--preset', 'worker', '--skip-install', '--skip-doctor'], 'ignore');
      expect(r.status).toBe(0);
      const core = fs.readFileSync(path.join(dir, '.ai', 'core.adf'), 'utf-8');
      expect(core).toContain(`  - project: demo-354 — ${description.replace(/\s+/g, ' ').trim()}\n`);
      expect(core).toContain('No Node.js-specific APIs in Worker handlers');
      expect(core).not.toContain("Project context (run 'charter adf populate'");
      const populate = JSON.parse(r.stdout).steps.find((s: { name: string }) => s.name === 'populate');
      expect(populate.details.refused).toEqual([]);
      expect(populate.warnings).toEqual([]);
    });
  }
});

describe('#371 round 3: the populate record under bootstrap (built CLI)', () => {
  const BOOT = ['--preset', 'worker', '--skip-install', '--skip-doctor'];
  const populateStep = (stdout: string) => JSON.parse(stdout).steps.find((s: { name: string }) => s.name === 'populate');

  it('bootstrap --reset-adf --yes on a Worker repo gets the rule again (record entry dropped, backed up)', () => {
    const dir = workerRepo();
    expect(run(dir, ['--yes', ...BOOT], 'ignore').status).toBe(0);
    fs.writeFileSync(path.join(dir, '.ai', 'core.adf'), read(dir, '.ai/core.adf').replace(`  - ${CF_RULE}\n`, ''));
    const recordBefore = read(dir, '.ai/.populate.json');
    const r = run(dir, ['--reset-adf', '--yes', ...BOOT], 'ignore');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Dropped core\.adf from \.ai\/\.populate\.json \(backup: \.ai\/\.backup\/\.populate\.json\.\S+\)/);
    expect(r.stdout).toContain(`  Added CONSTRAINTS item in .ai/core.adf: ${CF_RULE}`);
    expect(read(dir, '.ai/core.adf').split(CF_RULE).length - 1).toBe(1);
    const backup = fs.readdirSync(path.join(dir, '.ai', '.backup')).find(f => f.startsWith('.populate.json.'))!;
    expect(read(dir, `.ai/.backup/${backup}`)).toBe(recordBefore);
    expect(JSON.parse(read(dir, '.ai/.populate.json')).constraints).toEqual({ 'core.adf': { added: [CF_RULE], offered: [] } });
  });

  it('details.populated counts ADF modules only, not the record', () => {
    const dir = workerRepo();
    const r = run(dir, ['--yes', '--format', 'json', ...BOOT], 'ignore');
    const step = populateStep(r.stdout);
    expect(step.details.changes).toContainEqual({ file: '.ai/.populate.json', change: 'Created .ai/.populate.json' });
    const modules = ['core.adf', 'state.adf', 'backend.adf', 'frontend.adf'].filter(f => fs.existsSync(path.join(dir, '.ai', f)));
    expect(step.details.populated).toBe(modules.length);
  });

  it('an invalid record: core.adf CONSTRAINTS unchanged, one warning without a doubled "left as is"', () => {
    const dir = workerRepo();
    expect(run(dir, ['--yes', ...BOOT], 'ignore').status).toBe(0);
    const edited = read(dir, '.ai/core.adf').replace(`  - ${CF_RULE}\n`, '');
    fs.writeFileSync(path.join(dir, '.ai', 'core.adf'), edited);
    fs.writeFileSync(path.join(dir, '.ai', '.populate.json'), '{"version":2,"constraints":{}}');
    const r = run(dir, ['--format', 'json', ...BOOT], 'ignore');
    expect(r.status).toBe(0);
    expect(read(dir, '.ai/core.adf')).toBe(edited);
    expect(read(dir, '.ai/.populate.json')).toBe('{"version":2,"constraints":{}}');
    const step = populateStep(r.stdout);
    const recordWarnings = (step.warnings as string[]).filter(w => w.includes('.populate.json'));
    expect(recordWarnings).toEqual([
      '.ai/.populate.json could not be read (version is 2, not 1), so populate added no stack constraints this run; fix or delete it; left as is.',
    ]);
    expect(step.details.refused).toEqual([{ file: '.ai/.populate.json', reason: 'could not be read (version is 2, not 1), so populate added no stack constraints this run; fix or delete it' }]);
  });
});

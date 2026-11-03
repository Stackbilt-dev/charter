import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAdf, parseManifest } from '@stackbilt/adf';
import { adfMigrateCommand } from '../commands/adf-migrate';
import { bootstrapCommand } from '../commands/bootstrap';
import type { CLIOptions } from '../index';

// #239: `adf migrate` registers the modules it routes content into, in
// manifest.adf and in the hybrid CLAUDE.md module index.

const baseOptions: CLIOptions = {
  configPath: '.charter',
  format: 'text',
  ciMode: false,
  yes: false,
};

const MANIFEST = `ADF: 0.1

\u{1F4E6} DEFAULT_LOAD:
  - core.adf
  - state.adf

\u{1F4C2} ON_DEMAND:
  - frontend.adf (Triggers on: React, CSS, UI)
`;

const DEPLOY_MD = '# Project\n\n## Deployment\n\n- Always deploy from the main branch.\n- Never push directly to production.\n';
const GENERAL_MD = '# Project\n\n## General\n\n- Always write a changelog entry.\n';

const MANIFEST_PATH = path.join('.ai', 'manifest.adf');

/**
 * The manifest minus the VENDORS block where implicit writers record vendor modes
 * (#318). The block must hold exactly `entries`, appended at EOF, so a module
 * bullet misplaced into it fails the test instead of being stripped.
 */
function readManifestWithoutVendors(entries: readonly string[] = ['CLAUDE.md: pointer']): string {
  const text = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  const block = `\n\u{1F3F7} VENDORS:\n${entries.map(e => `  - ${e}\n`).join('')}`;
  expect(text.endsWith(block)).toBe(true);
  return text.slice(0, text.length - block.length);
}

interface JsonRegistration {
  module: string;
  loadPolicy: string;
  triggers: string[];
  reason: string;
  status: string;
  skipReason?: string;
  triggerSources: string[];
}

interface JsonSource {
  source: string;
  skipped: boolean;
  registrations: JsonRegistration[];
  actions: Array<{ type: string; target: string; detail: string; module?: string; status?: string }>;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, 'utf-8');
    }
  };
  walk(dir);
  return out;
}

function onDemand(manifestPath = MANIFEST_PATH) {
  return parseManifest(parseAdf(fs.readFileSync(manifestPath, 'utf-8'))).onDemand;
}

describe('adf migrate — manifest registration (#239)', () => {
  let originalCwd: string;
  let tempDir: string;
  let logs: string[];
  let warns: string[];

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-migrate-register-'));
    process.chdir(tempDir);
    logs = [];
    warns = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    });
    fs.mkdirSync('.ai');
    fs.writeFileSync(MANIFEST_PATH, MANIFEST);
    fs.writeFileSync(path.join('.ai', 'core.adf'), 'ADF: 0.1\n\nCONTEXT:\n  - Core rules\n');
    fs.writeFileSync(path.join('.ai', 'state.adf'), 'ADF: 0.1\n\nSTATE:\n  CURRENT: active\n');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function migrateJson(args: string[] = []): Promise<JsonSource[]> {
    logs = [];
    expect(await adfMigrateCommand({ ...baseOptions, format: 'json' }, args)).toBe(0);
    return (JSON.parse(logs.join('\n')) as { sources: JsonSource[] }).sources;
  }

  it('registers a new module ON_DEMAND, before the pointer index is written (INV-2)', async () => {
    fs.writeFileSync('CLAUDE.md', DEPLOY_MD);
    expect(await adfMigrateCommand(baseOptions, [])).toBe(0);

    expect(fs.existsSync(path.join('.ai', 'infra.adf'))).toBe(true);
    const infra = onDemand().find(m => m.path === 'infra.adf');
    expect(infra?.triggers).toEqual(['deployment']);
    expect(logs).toContain(`    REGISTER ${MANIFEST_PATH}  (infra.adf → ON_DEMAND: deployment)`);

    // The hybrid pointer's module index was generated after the manifest write.
    const claude = fs.readFileSync('CLAUDE.md', 'utf-8');
    expect(claude).toContain('| infra.adf | deployment | ON_DEMAND |');
  });

  it('registers a new core.adf under DEFAULT_LOAD with no triggers', async () => {
    fs.writeFileSync(MANIFEST_PATH, MANIFEST.replace('  - core.adf\n', ''));
    fs.rmSync(path.join('.ai', 'core.adf'));
    fs.writeFileSync('CLAUDE.md', GENERAL_MD);

    const [src] = await migrateJson();
    expect(src.registrations).toEqual([
      expect.objectContaining({ module: 'core.adf', loadPolicy: 'DEFAULT_LOAD', triggers: [], status: 'added' }),
    ]);
    const manifest = parseManifest(parseAdf(fs.readFileSync(MANIFEST_PATH, 'utf-8')));
    expect(manifest.defaultLoad).toEqual(['state.adf', 'core.adf']);
  });

  it('leaves a scaffold-listed module and a registered module untouched', async () => {
    fs.writeFileSync('CLAUDE.md', '# P\n\n## React components\n\n- Always use function components.\n\n## General\n\n- Always write a changelog entry.\n');

    const [src] = await migrateJson();
    expect(fs.existsSync(path.join('.ai', 'frontend.adf'))).toBe(true);
    expect(src.registrations.map(r => [r.module, r.status])).toEqual([
      ['frontend.adf', 'already-registered'],
      ['core.adf', 'already-registered'],
    ]);
    // Existing entries are reported as the manifest has them, not as inferred.
    expect(src.actions.filter(a => a.type === 'REGISTER').map(a => a.detail)).toEqual([
      'frontend.adf → ON_DEMAND: React, CSS, UI [already registered]',
      'core.adf → DEFAULT_LOAD [already registered]',
    ]);
    expect(readManifestWithoutVendors()).toBe(MANIFEST);
  });

  it('registers an orphan this run routes content to, and leaves other orphans alone', async () => {
    fs.writeFileSync(path.join('.ai', 'infra.adf'), 'ADF: 0.1\n\nCONTEXT:\n  - Existing infra notes\n');
    fs.writeFileSync(path.join('.ai', 'legacy.adf'), 'ADF: 0.1\n\nCONTEXT:\n  - Old\n');
    fs.writeFileSync('CLAUDE.md', DEPLOY_MD);

    await migrateJson();
    const paths = onDemand().map(m => m.path);
    expect(paths).toContain('infra.adf');
    expect(paths).not.toContain('legacy.adf');
  });

  it('does not move core.adf out of ON_DEMAND, and names the remedy', async () => {
    const manifest = 'ADF: 0.1\n\n\u{1F4E6} DEFAULT_LOAD:\n  - state.adf\n\n\u{1F4C2} ON_DEMAND:\n  - core.adf (Triggers on: core)\n';
    fs.writeFileSync(MANIFEST_PATH, manifest);
    fs.writeFileSync('CLAUDE.md', GENERAL_MD);

    expect(await adfMigrateCommand(baseOptions, [])).toBe(0);
    expect(readManifestWithoutVendors()).toBe(manifest);
    expect(logs.some(l => l.includes('core.adf is listed under ON_DEMAND') && l.includes('Move core.adf from ON_DEMAND to DEFAULT_LOAD'))).toBe(true);
    expect(logs).toContain(`    REGISTER ${MANIFEST_PATH}  (core.adf → ON_DEMAND: core [already registered])`);
  });

  it('registers a module that two sources route to exactly once', async () => {
    fs.writeFileSync('CLAUDE.md', DEPLOY_MD);
    fs.writeFileSync('AGENTS.md', '# Agents\n\n## Deployment\n\n- Always run the deploy checklist.\n');

    const sources = await migrateJson();
    expect(sources.map(s => s.registrations.find(r => r.module === 'infra.adf')?.status)).toEqual(['added', 'already-registered']);
    expect(onDemand().filter(m => m.path === 'infra.adf')).toHaveLength(1);
  });

  it('refreshes the CLAUDE.md index when a later source adds a module (INV-3)', async () => {
    fs.writeFileSync('CLAUDE.md', GENERAL_MD);
    fs.writeFileSync('AGENTS.md', '# Agents\n\n## Deployment\n\n- Always run the deploy checklist.\n');

    await migrateJson();
    const claude = fs.readFileSync('CLAUDE.md', 'utf-8');
    expect(claude).toContain('| infra.adf | deployment | ON_DEMAND |');
  });

  it('a re-run writes nothing and adds no entries (INV-1)', async () => {
    fs.writeFileSync('CLAUDE.md', DEPLOY_MD);
    await migrateJson(['--no-backup']);
    const before = snapshot(tempDir);

    const sources = await migrateJson(['--no-backup']);
    expect(sources.every(s => s.skipped)).toBe(true);
    expect(snapshot(tempDir)).toEqual(before);
    expect(onDemand().filter(m => m.path === 'infra.adf')).toHaveLength(1);
  });

  it('never merges new triggers into an existing entry (INV-5)', async () => {
    fs.writeFileSync('CLAUDE.md', DEPLOY_MD);
    await migrateJson();
    const manifestBefore = readManifestWithoutVendors();

    fs.writeFileSync('GEMINI.md', '# Gemini\n\n## Docker deployment\n\n- Always pin base images.\n');
    const [src] = await migrateJson(['--source', 'GEMINI.md']);
    expect(src.registrations.find(r => r.module === 'infra.adf')?.status).toBe('already-registered');
    expect(readManifestWithoutVendors(['CLAUDE.md: pointer', 'GEMINI.md: pointer'])).toBe(manifestBefore);
    expect(onDemand().find(m => m.path === 'infra.adf')?.triggers).toEqual(['deployment']);
  });

  it('--dry-run writes nothing and reports the planned registration (INV-6)', async () => {
    fs.writeFileSync('CLAUDE.md', DEPLOY_MD);
    const before = snapshot(tempDir);

    expect(await adfMigrateCommand(baseOptions, ['--dry-run'])).toBe(0);
    expect(logs).toContain(`    REGISTER ${MANIFEST_PATH}  (infra.adf → ON_DEMAND: deployment [planned])`);
    const [src] = await migrateJson(['--dry-run']);
    expect(src.registrations).toEqual([
      expect.objectContaining({ module: 'infra.adf', loadPolicy: 'ON_DEMAND', triggers: ['deployment'], status: 'planned' }),
    ]);
    expect(snapshot(tempDir)).toEqual(before);
  });

  it('--dry-run with several sources plans each module once', async () => {
    fs.writeFileSync('CLAUDE.md', DEPLOY_MD);
    fs.writeFileSync('AGENTS.md', '# Agents\n\n## Deployment\n\n- Always run the deploy checklist.\n');

    const sources = await migrateJson(['--dry-run']);
    expect(sources.map(s => s.registrations.find(r => r.module === 'infra.adf')?.status)).toEqual(['planned', 'already-registered']);
    const action = sources[1].actions.find(a => a.type === 'REGISTER' && a.module === 'infra.adf');
    expect(action).toMatchObject({ status: 'already-registered', detail: 'infra.adf → ON_DEMAND: deployment [already registered]' });
  });

  it('--format json carries registrations and REGISTER actions', async () => {
    fs.writeFileSync('CLAUDE.md', DEPLOY_MD);
    const [src] = await migrateJson();
    const [reg] = src.registrations;
    expect(Object.keys(reg).sort()).toEqual(['loadPolicy', 'module', 'reason', 'status', 'triggerSources', 'triggers']);
    expect(reg).toMatchObject({ module: 'infra.adf', loadPolicy: 'ON_DEMAND', triggers: ['deployment'], status: 'added', triggerSources: ['heading-keyword'] });
    expect(reg.reason).toContain('can load ON_DEMAND');
    const types = src.actions.map(a => a.type);
    expect(types.indexOf('REGISTER')).toBeGreaterThan(types.indexOf('MERGE'));
    expect(types.indexOf('REGISTER')).toBeLessThan(types.indexOf('KEEP'));
    expect(src.actions.find(a => a.type === 'REGISTER')).toEqual({
      type: 'REGISTER', target: MANIFEST_PATH, detail: 'infra.adf → ON_DEMAND: deployment', module: 'infra.adf', loadPolicy: 'ON_DEMAND', status: 'added',
    });
  });

  it('--replace still updates the manifest', async () => {
    fs.writeFileSync('CLAUDE.md', DEPLOY_MD);
    await migrateJson(['--replace']);
    expect(onDemand().map(m => m.path)).toContain('infra.adf');
    expect(fs.readFileSync('CLAUDE.md', 'utf-8')).not.toContain('charter:module-index');
  });

  it('skips registration and warns when manifest.adf is missing', async () => {
    fs.rmSync(MANIFEST_PATH);
    fs.writeFileSync('CLAUDE.md', DEPLOY_MD);

    const [src] = await migrateJson();
    expect(fs.existsSync(path.join('.ai', 'infra.adf'))).toBe(true);
    expect(fs.existsSync(MANIFEST_PATH)).toBe(false);
    expect(src.registrations).toEqual([expect.objectContaining({ module: 'infra.adf', status: 'skipped', skipReason: 'manifest-missing' })]);
    expect(warns).toEqual([
      `Warning: ${MANIFEST_PATH} not found; 1 module(s) were written but not registered. Run: charter adf init`,
      `Warning: ${MANIFEST_PATH} not found; vendor modes cannot be recorded. Run: charter adf init`,
    ]);
  });

  it('honours --ai-dir', async () => {
    fs.mkdirSync('ctx');
    fs.writeFileSync(path.join('ctx', 'manifest.adf'), MANIFEST);
    fs.writeFileSync('CLAUDE.md', DEPLOY_MD);

    const [src] = await migrateJson(['--ai-dir', 'ctx']);
    expect(src.registrations[0]).toMatchObject({ module: 'infra.adf', status: 'added' });
    expect(onDemand(path.join('ctx', 'manifest.adf')).map(m => m.path)).toContain('infra.adf');
    expect(fs.readFileSync(MANIFEST_PATH, 'utf-8')).toBe(MANIFEST);
    expect(fs.readFileSync('CLAUDE.md', 'utf-8')).toContain('| infra.adf | deployment | ON_DEMAND |');
  });
});

describe('bootstrap --yes — migrate registers its own modules (INV-4)', () => {
  let originalCwd: string;
  let tempDir: string;
  let logs: string[];

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-bootstrap-register-'));
    process.chdir(tempDir);
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const args = ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'];

  it('registers each migrated module once, and a re-run finds no orphans', async () => {
    fs.writeFileSync('CLAUDE.md', DEPLOY_MD);

    expect(await bootstrapCommand({ ...baseOptions, yes: true }, args)).toBe(0);
    expect(onDemand().filter(m => m.path === 'infra.adf')).toHaveLength(1);
    const manifestAfterFirst = fs.readFileSync(MANIFEST_PATH, 'utf-8');

    logs = [];
    expect(await bootstrapCommand({ ...baseOptions, yes: true }, args)).toBe(0);
    expect(logs.some(l => l.includes('unregistered .adf module'))).toBe(false);
    expect(fs.readFileSync(MANIFEST_PATH, 'utf-8')).toBe(manifestAfterFirst);
  });

  it('orphan registration leaves a hand-edited manifest byte-identical apart from the new line', async () => {
    fs.mkdirSync('.ai');
    const manifest = [
      '# Team manifest: keep RULES last, ping @platform before editing',
      'ADF: 0.1',
      '',
      '\u{1F4E6} DEFAULT_LOAD:',
      '  - core.adf',
      '  - state.adf',
      '',
      '\u{1F4C2} ON_DEMAND:',
      '  - frontend.adf (Triggers on: React, CSS, UI)',
      '  - backend.adf (Triggers on: API, Node, DB)',
      '',
      '\u{1F4CB} CONTEXT:',
      '  Routing notes <!-- TODO: revisit after Q3 -->',
      '  | module | owner |',
      '  |--------|-------|',
      '',
      '\u{1F4D0} RULES:',
      '  - Prefer smallest relevant module set.',
      '',
    ].join('\n');
    fs.writeFileSync(MANIFEST_PATH, manifest);
    fs.writeFileSync(path.join('.ai', 'Observability.adf'), 'ADF: 0.1\n\nCONTEXT:\n  - Old tracing notes\n');

    expect(await bootstrapCommand({ ...baseOptions, yes: true }, args)).toBe(0);
    const after = readManifestWithoutVendors(
      ['CLAUDE.md', '.cursorrules', 'AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md'].map(f => `${f}: pointer`),
    );
    expect(after).toBe(manifest.replace('DB)\n', 'DB)\n  - Observability.adf (Triggers on: observability)\n'));
  });

  it('bootstrap --format json carries writer warnings in the phase 3 step', async () => {
    fs.mkdirSync('.ai');
    fs.writeFileSync(MANIFEST_PATH, 'ADF: 0.1\n\n\u{1F4E6} DEFAULT_LOAD:\n  - core.adf\n  - state.adf\n\n\u{1F4C2} ON_DEMAND: load modules lazily\n');
    fs.writeFileSync(path.join('.ai', 'ops.adf'), 'ADF: 0.1\n\nCONTEXT:\n  - Ops notes\n');

    expect(await bootstrapCommand({ ...baseOptions, format: 'json', yes: true }, args)).toBe(0);
    const out = JSON.parse(logs.join('\n')) as { steps: Array<{ name: string; warnings: string[] }> };
    const all = out.steps.flatMap(s => s.warnings);
    expect(all.some(w => w.includes('ON_DEMAND in') && w.includes('is not a list; ops.adf was not registered'))).toBe(true);
  });

  it('orphan registration goes through the shared writer: lowercase stem triggers, idempotent', async () => {
    fs.mkdirSync('.ai');
    // Mixed-case stem: the fallback trigger must still be lowercase.
    fs.writeFileSync(path.join('.ai', 'Observability.adf'), 'ADF: 0.1\n\nCONTEXT:\n  - Old tracing notes\n');

    expect(await bootstrapCommand({ ...baseOptions, yes: true }, args)).toBe(0);
    const entry = onDemand().find(m => m.path === 'Observability.adf');
    expect(entry?.triggers).toEqual(['observability']);
    expect(logs.some(l => l.includes('Registered 1 module(s) as ON_DEMAND'))).toBe(true);

    const manifestAfterFirst = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    expect(await bootstrapCommand({ ...baseOptions, yes: true }, args)).toBe(0);
    expect(fs.readFileSync(MANIFEST_PATH, 'utf-8')).toBe(manifestAfterFirst);
  });
});

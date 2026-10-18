import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyElement, parseAdf, parseManifest } from '@stackbilt/adf';
import type { MigrationItem } from '@stackbilt/adf';
import {
  ALLOWED_SHORT_TOKENS,
  MAX_TRIGGERS,
  dedupePlannedRegistrations,
  formatRegisterDetail,
  inferTriggers,
  isCaseInsensitiveDir,
  planModuleRegistration,
  registerManifestModules,
  registerModules,
  tokenizeTriggerText,
  toRegisterAction,
} from '../commands/adf-manifest-register';
import type { ModuleRegistration } from '../commands/adf-manifest-register';
import { NAMED_MODULE_DEFAULT_TRIGGERS } from '../commands/adf-named-scaffolds';
import { findMissingDefaultLoad } from '../commands/adf-wiring';

// #239: the shared manifest writer and the ON_DEMAND trigger inference.

const TRIGGER_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?: [a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

function item(heading: string, content = 'Always do the thing.'): MigrationItem {
  const element = { type: 'rule' as const, content, strength: 'imperative' as const };
  return { element, sourceHeading: heading, classification: classifyElement(element, heading) };
}

function routedTo(module: string, heading: string): MigrationItem {
  const it = item(heading);
  it.classification.targetModule = module;
  return it;
}

const MANIFEST = `ADF: 0.1

\u{1F4E6} DEFAULT_LOAD:
  - core.adf
  - state.adf

\u{1F4C2} ON_DEMAND:
  - frontend.adf (Triggers on: React, CSS, UI)
`;

describe('tokenizeTriggerText', () => {
  it('lowercases, strips markdown, and keeps internal . - _', () => {
    expect(tokenizeTriggerText('**Next.js** and `wasm-pack` (auth_scoped)')).toEqual(['next.js', 'and', 'wasm-pack', 'auth_scoped']);
  });

  it('splits on repeated separators and trims edge separators', () => {
    expect(tokenizeTriggerText('foo--bar _baz_ .qux.')).toEqual(['foo', 'bar', 'baz', 'qux']);
  });
});

describe('inferTriggers', () => {
  it('weights the heading keyword above plain heading tokens', () => {
    const items = [item('Deployment checklist'), item('Rollback checklist')].map(i => {
      i.classification.targetModule = 'infra.adf';
      return i;
    });
    const result = inferTriggers('infra.adf', items);
    // deployment: keyword (2); checklist: 1 + 1; rollback: 1 — ties break by first appearance.
    expect(result.triggers).toEqual(['deployment', 'checklist', 'rollback']);
    expect(result.triggerSources).toEqual(['heading-keyword', 'heading-token', 'heading-token']);
  });

  it('ignores the heading keyword when the heading route chose another module', () => {
    const result = inferTriggers('ops.adf', [routedTo('ops.adf', 'Deployment')]);
    expect(result.triggerSources).toEqual(['heading-token']);
  });

  it('drops stopwords, generic heading words, and short tokens outside the allowlist', () => {
    const result = inferTriggers('infra.adf', [item('Project rules for the CI and Go notes')]);
    expect(result.triggers).toEqual(['ci']);
  });

  it('drops tokens that already trigger another ON_DEMAND module', () => {
    const manifest = { onDemand: [{ path: 'frontend.adf', triggers: ['React', 'CSS'], loadPolicy: 'ON_DEMAND' as const }] };
    const result = inferTriggers('infra.adf', [routedTo('infra.adf', 'Deployment of React services')], manifest);
    expect(result.triggers).toEqual(['deployment', 'services']);
  });

  // Headings as they appear in real CLAUDE.md / AGENTS.md files (#349).
  it.each([
    ['Build & Test Commands', ['build', 'test']],
    ['Development Workflow', ['ops']],
    ['Release Process (v2.1)', ['ops']],
    ['Step 1: Install Dependencies', ['install', 'dependencies']],
    ['Images and Components', ['ops']],
    ['Apps via Turborepo', ['turborepo']],
    ['Database Migrations', ['database', 'migrations']],
    ['Code Style Guidelines', ['style']],
    ['Testing with Vitest', ['testing', 'vitest']],
    ['Deploying to Cloudflare Workers (2024)', ['deploying', 'cloudflare', 'workers']],
    ['Things to Avoid', ['ops']],
    ['Common Commands', ['ops']],
    ['API Routes & Auth', ['api', 'routes', 'auth']],
    ['Key Files and Project Structure', ['ops']],
    ['Node 20 / pnpm 9 Setup', ['node', 'pnpm']],
    ['Getting Started: Docker Compose', ['docker', 'compose']],
  ])('heading %j yields %j', (heading, expected) => {
    expect(inferTriggers('ops.adf', [routedTo('ops.adf', heading)]).triggers).toEqual(expected);
  });

  it('drops all-digit and version-number tokens', () => {
    const result = inferTriggers('ops.adf', [routedTo('ops.adf', '2024 roadmap: 1.2 to v3 via kubernetes 1-2')]);
    expect(result.triggers).toEqual(['roadmap', 'kubernetes']);
    const versions = inferTriggers('ops.adf', [routedTo('ops.adf', 'Node.js v20.x, 1.x, v2.0-beta, v2.1.0-rc.1, ES2022')]);
    expect(versions.triggers).toEqual(['node.js', 'es2022']);
  });

  it("keeps a generic word that is the module's own stem", () => {
    const items = [routedTo('release.adf', 'Release Process'), routedTo('release.adf', 'Changelog')];
    expect(inferTriggers('release.adf', items).triggers).toEqual(['release', 'changelog']);
    expect(inferTriggers('release-workflow.adf', [routedTo('release-workflow.adf', 'Release workflow')]).triggers)
      .toEqual(['release', 'workflow']);
    expect(inferTriggers('ops.adf', items.map(i => ({ ...i, classification: { ...i.classification, targetModule: 'ops.adf' } }))).triggers)
      .toEqual(['changelog']);
  });

  it('caps at MAX_TRIGGERS', () => {
    const result = inferTriggers('infra.adf', [routedTo('infra.adf', 'alpha bravo charlie delta echo foxtrot golf hotel')]);
    expect(result.triggers).toHaveLength(MAX_TRIGGERS);
    expect(result.triggers).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']);
  });

  it('falls back to the lowercased stem when nothing usable is left', () => {
    expect(inferTriggers('Frontend.adf', [])).toEqual({ triggers: ['frontend'], triggerSources: ['stem-fallback'] });
    expect(inferTriggers('sub/Infra.adf', [routedTo('sub/Infra.adf', 'Notes')])).toEqual({
      triggers: ['infra'],
      triggerSources: ['stem-fallback'],
    });
  });

  it('seeds a named module from NAMED_MODULE_DEFAULT_TRIGGERS', () => {
    const result = inferTriggers('typed-data-access.adf', []);
    expect(result.triggers).toEqual(NAMED_MODULE_DEFAULT_TRIGGERS['typed-data-access'].slice(0, MAX_TRIGGERS));
    expect(result.triggerSources.every(s => s === 'named-seed')).toBe(true);
  });

  it('is deterministic and always yields valid, unique triggers', () => {
    const items = [routedTo('infra.adf', 'Deployment: Docker & `wrangler.toml`'), routedTo('infra.adf', 'CI/CD')];
    const a = inferTriggers('infra.adf', items);
    const b = inferTriggers('infra.adf', items);
    expect(a).toEqual(b);
    expect(new Set(a.triggers).size).toBe(a.triggers.length);
    expect(a.triggers.every(t => TRIGGER_PATTERN.test(t))).toBe(true);
    expect(a.triggerSources).toHaveLength(a.triggers.length);
  });

  it('allows exactly the 2-letter tokens the heading routes recognise', () => {
    for (const token of ALLOWED_SHORT_TOKENS) {
      const result = classifyElement({ type: 'rule', content: 'x', strength: 'neutral' }, token);
      expect(result.routingTrace?.headingKeyword).toBe(token);
      expect(result.targetModule).not.toBe('core.adf');
    }
  });
});

describe('planModuleRegistration', () => {
  it('plans core.adf and state.adf as DEFAULT_LOAD with no triggers', () => {
    const reg = planModuleRegistration('core.adf', [item('General')]);
    expect(reg).toMatchObject({ module: 'core.adf', loadPolicy: 'DEFAULT_LOAD', triggers: [], triggerSources: [], status: 'planned' });
    expect(reg.reason).toContain('DEFAULT_LOAD');
  });

  it('plans other modules as ON_DEMAND and explains the triggers', () => {
    const reg = planModuleRegistration('./infra.adf', [item('Deployment')]);
    expect(reg).toMatchObject({ module: 'infra.adf', loadPolicy: 'ON_DEMAND', triggers: ['deployment'], status: 'planned' });
    expect(reg.reason).toContain('triggers inferred from 1 heading keyword(s)');
  });
});

describe('registerManifestModules', () => {
  let tempDir: string;
  let manifestPath: string;
  let warnings: string[];
  const onWarning = (w: string) => { warnings.push(w); };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-register-'));
    manifestPath = path.join(tempDir, 'manifest.adf');
    warnings = [];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const plan = (module: string, heading = 'Deployment'): ModuleRegistration =>
    planModuleRegistration(module, [routedTo(module, heading)]);

  it('appends entries and is idempotent on a second call', () => {
    fs.writeFileSync(manifestPath, MANIFEST);
    const first = registerManifestModules(manifestPath, [plan('infra.adf')], { onWarning });
    expect(first.written).toBe(true);
    expect(first.registrations[0].status).toBe('added');
    const after = fs.readFileSync(manifestPath, 'utf-8');
    expect(parseManifest(parseAdf(after)).onDemand.map(m => m.path)).toEqual(['frontend.adf', 'infra.adf']);
    expect(after).toContain('infra.adf (Triggers on: deployment)');

    const second = registerManifestModules(manifestPath, [plan('infra.adf')], { onWarning });
    expect(second.written).toBe(false);
    expect(second.registrations[0].status).toBe('already-registered');
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(after);
  });

  it('never rewrites an existing entry, matching by normalized parsed path', () => {
    fs.writeFileSync(manifestPath, MANIFEST.replace('frontend.adf (Triggers', './frontend.adf (Triggers'));
    const before = fs.readFileSync(manifestPath, 'utf-8');
    const result = registerManifestModules(manifestPath, [plan('frontend.adf', 'Storybook')], { onWarning });
    expect(result.registrations[0].status).toBe('already-registered');
    expect(result.written).toBe(false);
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(before);
  });

  it('reports core.adf under ON_DEMAND as it is, warns, and does not move it', () => {
    fs.writeFileSync(manifestPath, 'ADF: 0.1\n\n\u{1F4C2} ON_DEMAND:\n  - core.adf (Triggers on: Core)\n');
    const before = fs.readFileSync(manifestPath, 'utf-8');
    const result = registerManifestModules(manifestPath, [plan('core.adf')], { onWarning });
    expect(result.registrations[0]).toMatchObject({
      status: 'already-registered', loadPolicy: 'ON_DEMAND', triggers: ['Core'], triggerSources: [],
    });
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(before);
    expect(warnings).toEqual([
      `core.adf is listed under ON_DEMAND in ${manifestPath}; not moved. Move core.adf from ON_DEMAND to DEFAULT_LOAD in .ai/manifest.adf`,
    ]);
  });

  it('reports an existing entry with its own triggers, not inferred ones', () => {
    fs.writeFileSync(manifestPath, MANIFEST);
    const [reg] = registerManifestModules(manifestPath, [plan('frontend.adf', 'React components')], { onWarning }).registrations;
    expect(reg).toMatchObject({ module: 'frontend.adf', loadPolicy: 'ON_DEMAND', triggers: ['React', 'CSS', 'UI'], triggerSources: [], status: 'already-registered' });
    expect(reg.reason).not.toContain('inferred from');
    expect(formatRegisterDetail(reg)).toBe('frontend.adf → ON_DEMAND: React, CSS, UI [already registered]');
  });

  it('appends a missing section at the end of the file without reordering', () => {
    const original = 'ADF: 0.1\n\n\u{1F4D0} RULES:\n  - Keep it small.\n\n\u{1F4C2} ON_DEMAND:\n  - frontend.adf (Triggers on: React)\n';
    fs.writeFileSync(manifestPath, original);
    registerManifestModules(manifestPath, [plan('core.adf')], { onWarning });
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(`${original}\n\u{1F4E6} DEFAULT_LOAD:\n  - core.adf\n`);
  });

  it('registers into an empty section header (an empty list)', () => {
    for (const [header, module, line] of [
      ['\u{1F4C2} ON_DEMAND:', 'infra.adf', '  - infra.adf (Triggers on: deployment)'],
      ['\u{1F4E6} DEFAULT_LOAD:', 'core.adf', '  - core.adf'],
    ] as const) {
      const original = `ADF: 0.1\n\n${header}\n\n\u{1F4D0} RULES:\n  - Keep it small.\n`;
      fs.writeFileSync(manifestPath, original);
      const [reg] = registerManifestModules(manifestPath, [plan(module)], { onWarning }).registrations;
      expect(reg.status).toBe('added');
      expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(original.replace(`${header}\n`, `${header}\n${line}\n`));
    }
    expect(warnings).toEqual([]);
  });
  it('skips with manifest-missing and warns', () => {
    const result = registerManifestModules(manifestPath, [plan('infra.adf'), plan('core.adf')], { onWarning });
    expect(result.written).toBe(false);
    expect(result.registrations.map(r => [r.status, r.skipReason])).toEqual([
      ['skipped', 'manifest-missing'],
      ['skipped', 'manifest-missing'],
    ]);
    expect(warnings).toEqual([`${manifestPath} not found; 2 module(s) were written but not registered. Run: charter adf init`]);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it('skips with manifest-unparseable', () => {
    fs.writeFileSync(manifestPath, 'ADF: 9.9\n');
    const result = registerManifestModules(manifestPath, [plan('infra.adf')], { onWarning });
    expect(result.registrations[0]).toMatchObject({ status: 'skipped', skipReason: 'manifest-unparseable' });
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe('ADF: 9.9\n');
    expect(warnings).toEqual([
      `${manifestPath} could not be parsed; 1 module(s) were not registered. Fix the manifest or run: charter doctor`,
    ]);
  });

  it('says "would be written" for a missing manifest under dryRun', () => {
    registerManifestModules(manifestPath, [plan('infra.adf')], { dryRun: true, onWarning });
    expect(warnings).toEqual([`${manifestPath} not found; 1 module(s) would be written but not registered. Run: charter adf init`]);
  });

  it('skips with section-not-list and warns', () => {
    fs.writeFileSync(manifestPath, 'ADF: 0.1\n\n\u{1F4C2} ON_DEMAND: load everything lazily\n');
    const before = fs.readFileSync(manifestPath, 'utf-8');
    expect(parseAdf(before).sections[0].content.type).not.toBe('list');
    const result = registerManifestModules(manifestPath, [plan('infra.adf')], { onWarning });
    expect(result.registrations[0]).toMatchObject({ status: 'skipped', skipReason: 'section-not-list' });
    expect(warnings).toEqual([`ON_DEMAND in ${manifestPath} is not a list; infra.adf was not registered`]);
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(before);
  });

  it('writes nothing under dryRun and keeps additions planned', () => {
    fs.writeFileSync(manifestPath, MANIFEST);
    const result = registerManifestModules(manifestPath, [plan('infra.adf'), plan('frontend.adf')], { dryRun: true, onWarning });
    expect(result.written).toBe(false);
    expect(result.registrations.map(r => r.status)).toEqual(['planned', 'already-registered']);
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(MANIFEST);
  });

  it('reports one registration per module', () => {
    fs.writeFileSync(manifestPath, MANIFEST);
    const result = registerManifestModules(manifestPath, [plan('infra.adf'), plan('infra.adf', 'Docker')], { onWarning });
    expect(result.registrations).toHaveLength(1);
    expect(parseManifest(parseAdf(fs.readFileSync(manifestPath, 'utf-8'))).onDemand.filter(m => m.path === 'infra.adf')).toHaveLength(1);
  });

  describe('module path case (#349)', () => {
    const ci = { onWarning, caseInsensitive: true };
    const cs = { onWarning, caseInsensitive: false };

    it('on a case-insensitive filesystem, matches an existing entry and reports its spelling', () => {
      fs.writeFileSync(manifestPath, MANIFEST);
      const before = fs.readFileSync(manifestPath, 'utf-8');
      const result = registerManifestModules(manifestPath, [plan('Frontend.adf', 'Storybook')], ci);
      expect(result.written).toBe(false);
      expect(result.registrations.map(r => [r.module, r.status, r.loadPolicy, r.triggers])).toEqual([
        ['Frontend.adf', 'already-registered', 'ON_DEMAND', ['React', 'CSS', 'UI']],
      ]);
      expect(result.registrations[0].reason).toContain('already registered as frontend.adf under ON_DEMAND');
      expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(before);
    });

    it('on a case-insensitive filesystem, adds one entry for two spellings in a single call', () => {
      fs.writeFileSync(manifestPath, MANIFEST);
      const result = registerManifestModules(manifestPath, [plan('Infra.adf'), plan('infra.adf', 'Docker')], ci);
      expect(result.registrations.map(r => [r.module, r.status])).toEqual([['Infra.adf', 'added']]);
      const paths = parseManifest(parseAdf(fs.readFileSync(manifestPath, 'utf-8'))).onDemand.map(m => m.path);
      expect(paths).toEqual(['frontend.adf', 'Infra.adf']);
      const again = registerManifestModules(manifestPath, [plan('infra.adf', 'Docker')], ci);
      expect(again.registrations[0].status).toBe('already-registered');
      expect(again.written).toBe(false);
    });

    it('on a case-sensitive filesystem, registers the other spelling as its own module', () => {
      fs.writeFileSync(manifestPath, MANIFEST);
      const result = registerManifestModules(manifestPath, [plan('Frontend.adf', 'Storybook')], cs);
      expect(result.registrations.map(r => [r.module, r.status])).toEqual([['Frontend.adf', 'added']]);
      const paths = parseManifest(parseAdf(fs.readFileSync(manifestPath, 'utf-8'))).onDemand.map(m => m.path);
      expect(paths).toEqual(['frontend.adf', 'Frontend.adf']);
    });

    it('always adds a required DEFAULT_LOAD module under its exact name, as doctor checks it', () => {
      for (const opts of [ci, cs]) {
        fs.writeFileSync(manifestPath, MANIFEST.replace('  - core.adf\n', '  - Core.adf\n'));
        const result = registerManifestModules(manifestPath, [plan('core.adf')], opts);
        expect(result.registrations.map(r => [r.module, r.status])).toEqual([['core.adf', 'added']]);
        const manifest = parseManifest(parseAdf(fs.readFileSync(manifestPath, 'utf-8')));
        expect(findMissingDefaultLoad(manifest)).toEqual([]);
      }
    });

    it('registerModules plans two spellings once, from the items of both, on a case-insensitive filesystem', () => {
      fs.writeFileSync(manifestPath, MANIFEST);
      const items = [routedTo('Ops.adf', 'Terraform'), routedTo('ops.adf', 'Kubernetes')];
      const result = registerModules(manifestPath, ['Ops.adf', 'ops.adf'], items, ci);
      expect(result.registrations.map(r => [r.module, r.status, r.triggers])).toEqual([['Ops.adf', 'added', ['terraform', 'kubernetes']]]);
      fs.writeFileSync(manifestPath, MANIFEST);
      const separate = registerModules(manifestPath, ['Ops.adf', 'ops.adf'], items, cs);
      expect(separate.registrations.map(r => [r.module, r.status, r.triggers])).toEqual([
        ['Ops.adf', 'added', ['terraform']],
        ['ops.adf', 'added', ['kubernetes']],
      ]);
    });

    it('isCaseInsensitiveDir agrees with the filesystem', () => {
      fs.writeFileSync(manifestPath, MANIFEST);
      expect(isCaseInsensitiveDir(tempDir)).toBe(fs.existsSync(path.join(tempDir, 'MANIFEST.ADF')));
      expect(isCaseInsensitiveDir(path.join(tempDir, 'missing'))).toBe(false);
    });
  });

  it('registerModules gives orphans the stem trigger', () => {
    fs.writeFileSync(manifestPath, MANIFEST);
    const result = registerModules(manifestPath, ['Ops.adf', 'state.adf'], [], { onWarning });
    expect(result.registrations.map(r => [r.module, r.status, r.triggers])).toEqual([
      ['Ops.adf', 'added', ['ops']],
      ['state.adf', 'already-registered', []],
    ]);
    expect(fs.readFileSync(manifestPath, 'utf-8')).toContain('Ops.adf (Triggers on: ops)');
  });
});

/**
 * Assert `after` is `before` plus inserted lines only (every original byte kept,
 * in order) and return the inserted lines.
 */
function insertedLines(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const inserted: string[] = [];
  let i = 0;
  for (const line of b) {
    if (i < a.length && line === a[i]) i++;
    else inserted.push(line);
  }
  expect(i).toBe(a.length);
  return inserted;
}

describe('registerManifestModules — byte preservation', () => {
  let tempDir: string;
  let manifestPath: string;
  let warnings: string[];
  const onWarning = (w: string) => { warnings.push(w); };
  const infra = () => planModuleRegistration('infra.adf', [routedTo('infra.adf', 'Deployment')]);

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-register-bytes-'));
    manifestPath = path.join(tempDir, 'manifest.adf');
    warnings = [];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function register(original: string, entries = [infra()]): string {
    fs.writeFileSync(manifestPath, original);
    const result = registerManifestModules(manifestPath, entries, { onWarning });
    expect(result.registrations.every(r => r.status === 'added')).toBe(true);
    return fs.readFileSync(manifestPath, 'utf-8');
  }

  const LINE = '  - infra.adf (Triggers on: deployment)';

  it('keeps comment lines above the first section', () => {
    const original = '# Team manifest: keep RULES last, ping @platform before editing\nADF: 0.1\n\n\u{1F4C2} ON_DEMAND:\n  - frontend.adf (Triggers on: React)\n\n\u{1F4D0} RULES:\n  - Keep it small.\n';
    const after = register(original);
    expect(after).toBe(original.replace('React)\n', `React)\n${LINE}\n`));
  });

  it('keeps HTML comments and markdown tables in text sections', () => {
    const original = [
      'ADF: 0.1',
      '',
      '\u{1F4CB} CONTEXT:',
      '  Routing notes <!-- TODO: revisit after Q3 -->',
      '  | module | owner |',
      '  |--------|-------|',
      '  | infra  | ops   |',
      '',
      '\u{1F4C2} ON_DEMAND:',
      '  - frontend.adf (Triggers on: React)',
      '',
    ].join('\n');
    const after = register(original);
    expect(insertedLines(original, after)).toEqual([LINE]);
    expect(after).toContain('<!-- TODO: revisit after Q3 -->');
  });

  it('keeps CRLF line endings, both when inserting and when appending a section', () => {
    const original = 'ADF: 0.1\r\n\r\n\u{1F4E6} DEFAULT_LOAD:\r\n  - core.adf\r\n\r\n\u{1F4C2} ON_DEMAND:\r\n  - frontend.adf (Triggers on: React)\r\n';
    expect(register(original)).toBe(original.replace('React)\r\n', `React)\r\n${LINE}\r\n`));

    const noOnDemand = 'ADF: 0.1\r\n\r\n\u{1F4E6} DEFAULT_LOAD:\r\n  - core.adf\r\n';
    expect(register(noOnDemand)).toBe(`${noOnDemand}\r\n\u{1F4C2} ON_DEMAND:\r\n${LINE}\r\n`);
  });

  it('keeps blank lines inside a list and inserts after its last item', () => {
    const original = 'ADF: 0.1\n\n\u{1F4C2} ON_DEMAND:\n  - a.adf (Triggers on: alpha)\n\n  - b.adf (Triggers on: bravo)\n\n\u{1F4D0} RULES:\n  - Keep it small.\n';
    expect(register(original)).toBe(original.replace('bravo)\n', `bravo)\n${LINE}\n`));
  });

  it('copies tab indentation from the existing items', () => {
    const original = 'ADF: 0.1\n\n\u{1F4C2} ON_DEMAND:\n\t- frontend.adf (Triggers on: React)\n';
    expect(register(original)).toBe(`${original}\t- infra.adf (Triggers on: deployment)\n`);
  });

  it('keeps a missing trailing newline missing', () => {
    const original = 'ADF: 0.1\n\n\u{1F4C2} ON_DEMAND:\n  - frontend.adf (Triggers on: React)';
    expect(register(original)).toBe(`${original}\n${LINE}`);
  });

  it("leaves this repo's own manifest byte-identical apart from the new lines", () => {
    const original = fs.readFileSync(path.join(__dirname, 'fixtures', 'charter-manifest.adf'), 'utf-8');
    const core = planModuleRegistration('state.adf', []);
    const after = register(original, [infra(), { ...core, module: 'session.adf', loadPolicy: 'DEFAULT_LOAD' }]);
    expect(insertedLines(original, after)).toEqual(['  - session.adf', LINE]);
    const lines = after.split('\n');
    expect(lines[lines.indexOf(LINE) - 1]).toMatch(/^ {2}- typed-data-access\.adf /);
    expect(lines[lines.indexOf('  - session.adf') - 1]).toBe('  - state.adf');
  });

  it('refuses to write when the edit would change anything else', () => {
    // Lone-CR line endings: the parser splits them, a line-based edit cannot place
    // the bullet, and the re-parse check catches the mismatch.
    const original = 'ADF: 0.1\r\r\u{1F4C2} ON_DEMAND:\r  - frontend.adf (Triggers on: React)\r';
    fs.writeFileSync(manifestPath, original);
    const result = registerManifestModules(manifestPath, [infra()], { onWarning });
    expect(result.written).toBe(false);
    expect(result.registrations[0]).toMatchObject({ status: 'skipped', skipReason: 'manifest-unparseable' });
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(original);
    expect(warnings).toEqual([
      `${manifestPath} could not be updated without changing its other entries; 1 module(s) were not registered. Fix the manifest or run: charter doctor`,
    ]);
  });
});

describe('REGISTER output helpers', () => {
  const reg = (over: Partial<ModuleRegistration>): ModuleRegistration => ({
    module: 'infra.adf', loadPolicy: 'ON_DEMAND', triggers: ['deploy', 'ci'], reason: 'r', status: 'added', triggerSources: ['heading-keyword', 'heading-keyword'], ...over,
  });

  it('formats the detail for each status', () => {
    expect(formatRegisterDetail(reg({}))).toBe('infra.adf → ON_DEMAND: deploy, ci');
    expect(formatRegisterDetail(reg({ status: 'planned' }))).toBe('infra.adf → ON_DEMAND: deploy, ci [planned]');
    expect(formatRegisterDetail(reg({ status: 'already-registered' }))).toBe('infra.adf → ON_DEMAND: deploy, ci [already registered]');
    expect(formatRegisterDetail(reg({ status: 'skipped', skipReason: 'manifest-missing' }))).toBe('infra.adf → ON_DEMAND: deploy, ci [skipped: manifest-missing]');
    expect(formatRegisterDetail(reg({ module: 'core.adf', loadPolicy: 'DEFAULT_LOAD', triggers: [], triggerSources: [] }))).toBe('core.adf → DEFAULT_LOAD');
  });

  it('dedupes planned registrations across sources', () => {
    const seen = new Set<string>();
    const first = { registrations: [reg({ status: 'planned' })], actions: [] as Array<{ type: string }> };
    first.actions.push(toRegisterAction(first.registrations[0], '.ai/manifest.adf'));
    const second = { registrations: [reg({ status: 'planned' })], actions: [] as Array<{ type: string }> };
    second.actions.push(toRegisterAction(second.registrations[0], '.ai/manifest.adf'));

    dedupePlannedRegistrations(first, seen);
    dedupePlannedRegistrations(second, seen);
    expect(first.registrations[0].status).toBe('planned');
    expect(second.registrations[0].status).toBe('already-registered');
    expect(second.actions[0]).toMatchObject({ status: 'already-registered', detail: 'infra.adf → ON_DEMAND: deploy, ci [already registered]' });
  });
});

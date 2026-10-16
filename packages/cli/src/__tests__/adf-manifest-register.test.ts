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
  planModuleRegistration,
  registerManifestModules,
  registerModules,
  tokenizeTriggerText,
  toRegisterAction,
} from '../commands/adf-manifest-register';
import type { ModuleRegistration } from '../commands/adf-manifest-register';
import { NAMED_MODULE_DEFAULT_TRIGGERS } from '../commands/adf-named-scaffolds';

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
    const items = [item('Deployment workflow'), item('Release workflow')].map(i => {
      i.classification.targetModule = 'infra.adf';
      return i;
    });
    const result = inferTriggers('infra.adf', items);
    // deployment: keyword (2); workflow: 1 + 1; release: 1 — ties break by first appearance.
    expect(result.triggers).toEqual(['deployment', 'workflow', 'release']);
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
    const result = inferTriggers('infra.adf', [routedTo('infra.adf', 'Deployment of React apps')], manifest);
    expect(result.triggers).toEqual(['deployment', 'apps']);
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

  it('warns and does not move a DEFAULT_LOAD module listed under ON_DEMAND', () => {
    fs.writeFileSync(manifestPath, 'ADF: 0.1\n\n\u{1F4C2} ON_DEMAND:\n  - core.adf (Triggers on: core)\n');
    const before = fs.readFileSync(manifestPath, 'utf-8');
    const result = registerManifestModules(manifestPath, [plan('core.adf')], { onWarning });
    expect(result.registrations[0]).toMatchObject({ status: 'already-registered', loadPolicy: 'DEFAULT_LOAD' });
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(before);
    expect(warnings).toEqual([
      `core.adf is listed under ON_DEMAND in ${manifestPath}; not moved. Move core.adf from ON_DEMAND to DEFAULT_LOAD in .ai/manifest.adf`,
    ]);
  });

  it('creates missing sections in canonical order', () => {
    fs.writeFileSync(manifestPath, 'ADF: 0.1\n\n\u{1F4C2} ON_DEMAND:\n  - frontend.adf (Triggers on: React)\n');
    registerManifestModules(manifestPath, [plan('core.adf')], { onWarning });
    let doc = parseAdf(fs.readFileSync(manifestPath, 'utf-8'));
    expect(doc.sections.map(s => s.key)).toEqual(['DEFAULT_LOAD', 'ON_DEMAND']);

    fs.writeFileSync(manifestPath, 'ADF: 0.1\n\n\u{1F4E6} DEFAULT_LOAD:\n  - core.adf\n\n\u{1F4D0} RULES:\n  - Keep it small.\n');
    registerManifestModules(manifestPath, [plan('infra.adf')], { onWarning });
    doc = parseAdf(fs.readFileSync(manifestPath, 'utf-8'));
    // formatAdf applies the canonical key order; DEFAULT_LOAD stays ahead of ON_DEMAND.
    const keys = doc.sections.map(s => s.key);
    expect(keys.indexOf('ON_DEMAND')).toBeGreaterThan(keys.indexOf('DEFAULT_LOAD'));
    expect(keys).toContain('RULES');
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

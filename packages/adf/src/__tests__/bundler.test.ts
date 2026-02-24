import { describe, it, expect } from 'vitest';
import { parseManifest, resolveModules, bundleModules } from '../bundler';
import { parseAdf } from '../parser';

const MANIFEST_ADF = `ADF: 0.1
ROLE: Repo context router

DEFAULT_LOAD:
  - core.adf
  - state.adf

ON_DEMAND:
  - frontend.adf (Triggers on: React, CSS, UI)
  - backend.adf (Triggers on: API, Node, DB)

RULES:
  - Prefer smallest relevant module set.
  - Never assume unseen modules were loaded.
`;

describe('parseManifest', () => {
  it('extracts defaultLoad modules', () => {
    const doc = parseAdf(MANIFEST_ADF);
    const manifest = parseManifest(doc);
    expect(manifest.defaultLoad).toEqual(['core.adf', 'state.adf']);
  });

  it('extracts onDemand modules with triggers', () => {
    const doc = parseAdf(MANIFEST_ADF);
    const manifest = parseManifest(doc);
    expect(manifest.onDemand).toHaveLength(2);
    expect(manifest.onDemand[0].path).toBe('frontend.adf');
    expect(manifest.onDemand[0].triggers).toEqual(['React', 'CSS', 'UI']);
    expect(manifest.onDemand[1].path).toBe('backend.adf');
  });

  it('extracts role', () => {
    const doc = parseAdf(MANIFEST_ADF);
    const manifest = parseManifest(doc);
    expect(manifest.role).toBe('Repo context router');
  });

  it('extracts rules', () => {
    const doc = parseAdf(MANIFEST_ADF);
    const manifest = parseManifest(doc);
    expect(manifest.rules).toHaveLength(2);
  });
});

describe('resolveModules', () => {
  const doc = parseAdf(MANIFEST_ADF);
  const manifest = parseManifest(doc);

  it('always includes defaultLoad modules', () => {
    const resolved = resolveModules(manifest, []);
    expect(resolved).toContain('core.adf');
    expect(resolved).toContain('state.adf');
  });

  it('includes on-demand module when trigger matches', () => {
    const resolved = resolveModules(manifest, ['React']);
    expect(resolved).toContain('frontend.adf');
    expect(resolved).not.toContain('backend.adf');
  });

  it('trigger matching is case-insensitive', () => {
    const resolved = resolveModules(manifest, ['react']);
    expect(resolved).toContain('frontend.adf');
  });

  it('does not false-match partial keywords', () => {
    const resolved = resolveModules(manifest, ['Reactive']);
    expect(resolved).not.toContain('frontend.adf');
  });

  it('resolves multiple on-demand modules', () => {
    const resolved = resolveModules(manifest, ['React', 'API']);
    expect(resolved).toContain('frontend.adf');
    expect(resolved).toContain('backend.adf');
  });
});

describe('bundleModules', () => {
  const FILES: Record<string, string> = {
    '/ai/manifest.adf': MANIFEST_ADF,
    '/ai/core.adf': `ADF: 0.1\nCONSTRAINTS:\n  - No secrets\n`,
    '/ai/state.adf': `ADF: 0.1\nSTATE:\n  CURRENT: Working\n`,
    '/ai/frontend.adf': `ADF: 0.1\nCONSTRAINTS:\n  - Use React hooks\n`,
  };

  const readFile = (p: string): string => {
    const content = FILES[p];
    if (!content) throw new Error(`File not found: ${p}`);
    return content;
  };

  it('merges sections from multiple modules', () => {
    const result = bundleModules('/ai', ['core.adf', 'state.adf', 'frontend.adf'], readFile);
    const constraints = result.mergedDocument.sections.find(s => s.key === 'CONSTRAINTS');
    expect(constraints).toBeDefined();
    if (constraints && constraints.content.type === 'list') {
      expect(constraints.content.items).toEqual(['No secrets', 'Use React hooks']);
    }
  });

  it('returns token estimate > 0', () => {
    const result = bundleModules('/ai', ['core.adf'], readFile);
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it('throws on missing module', () => {
    expect(() =>
      bundleModules('/ai', ['nonexistent.adf'], readFile)
    ).toThrow('Module not found');
  });

  it('includes manifest in result', () => {
    const result = bundleModules('/ai', ['core.adf'], readFile);
    expect(result.manifest.defaultLoad).toEqual(['core.adf', 'state.adf']);
  });
});

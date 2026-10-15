import { describe, expect, it } from 'vitest';
import {
  classifyModuleLoad,
  findMissingDefaultLoad,
  formatMissingDefaultLoad,
  isRequiredDefaultLoad,
  REQUIRED_DEFAULT_LOAD_MODULES,
} from '../commands/adf-wiring';

describe('classifyModuleLoad', () => {
  it.each(['core.adf', 'state.adf'])('requires %s in DEFAULT_LOAD and explains why', (mod) => {
    const result = classifyModuleLoad(mod);
    expect(result).toMatchObject({ module: mod, defaultLoad: true });
    expect(result.reason).toContain(mod);
    expect(result.reason).toContain('DEFAULT_LOAD');
  });

  it('normalizes ./ prefixes and backslashes before classifying', () => {
    expect(classifyModuleLoad('./core.adf')).toMatchObject({ module: 'core.adf', defaultLoad: true });
    expect(classifyModuleLoad(' .\\state.adf ').defaultLoad).toBe(true);
  });

  it.each(['backend.adf', 'frontend.adf', 'core', 'sub/core.adf', 'core.adf.bak', 'CORE.adf'])(
    'routes %s to ON_DEMAND',
    (mod) => {
      const result = classifyModuleLoad(mod);
      expect(result.defaultLoad).toBe(false);
      expect(result.reason).toContain('ON_DEMAND');
    },
  );

  it('isRequiredDefaultLoad mirrors classifyModuleLoad', () => {
    expect(isRequiredDefaultLoad('core.adf')).toBe(true);
    expect(isRequiredDefaultLoad('backend.adf')).toBe(false);
  });

  it('exposes exactly core.adf and state.adf as required', () => {
    expect([...REQUIRED_DEFAULT_LOAD_MODULES]).toEqual(['core.adf', 'state.adf']);
  });
});

describe('findMissingDefaultLoad', () => {
  it('returns nothing when both required modules are in DEFAULT_LOAD', () => {
    expect(findMissingDefaultLoad({ defaultLoad: ['core.adf', 'state.adf'], onDemand: [] })).toEqual([]);
  });

  it('flags modules absent from DEFAULT_LOAD and notes ON_DEMAND misplacement', () => {
    const missing = findMissingDefaultLoad({
      defaultLoad: ['state.adf'],
      onDemand: [{ path: 'core.adf' }, { path: 'backend.adf' }],
    });
    expect(missing).toEqual([{ module: 'core.adf', inOnDemand: true }]);
  });

  it('flags unregistered modules', () => {
    expect(findMissingDefaultLoad({ defaultLoad: [], onDemand: [] })).toEqual([
      { module: 'core.adf', inOnDemand: false },
      { module: 'state.adf', inOnDemand: false },
    ]);
  });
});

describe('formatMissingDefaultLoad', () => {
  it('names a move for ON_DEMAND entries and an add for unregistered ones', () => {
    const details = formatMissingDefaultLoad([
      { module: 'core.adf', inOnDemand: true },
      { module: 'state.adf', inOnDemand: false },
    ]);
    expect(details).toBe(
      'Missing from DEFAULT_LOAD: core.adf, state.adf — '
      + 'move core.adf from ON_DEMAND to DEFAULT_LOAD in .ai/manifest.adf; '
      + 'add state.adf to DEFAULT_LOAD in .ai/manifest.adf (or run: charter adf create state.adf --load default)',
    );
  });
});

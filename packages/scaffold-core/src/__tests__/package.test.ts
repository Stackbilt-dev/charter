/**
 * package.test.ts — package metadata tests for @stackbilt/scaffold-core
 *
 * Verifies that the published package.json has the expected name and version.
 */

import { describe, it, expect } from 'vitest';
import pkg from '../../package.json';

describe('@stackbilt/scaffold-core package metadata', () => {
  it('name is @stackbilt/scaffold-core', () => {
    expect(pkg.name).toBe('@stackbilt/scaffold-core');
  });

  it('version is 1.0.0', () => {
    expect(pkg.version).toBe('1.0.0');
  });

  it('license is Apache-2.0', () => {
    expect(pkg.license).toBe('Apache-2.0');
  });

  it('author is Stackbilt LLC', () => {
    expect(pkg.author).toBe('Stackbilt LLC');
  });

  it('main points to dist/index.js', () => {
    expect(pkg.main).toBe('./dist/index.js');
  });

  it('types points to dist/index.d.ts', () => {
    expect(pkg.types).toBe('./dist/index.d.ts');
  });

  it('publishConfig.access is public', () => {
    expect(pkg.publishConfig.access).toBe('public');
  });

  it('publishConfig.provenance is true', () => {
    expect(pkg.publishConfig.provenance).toBe(true);
  });
});

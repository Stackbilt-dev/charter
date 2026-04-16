import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildGraph,
  blastRadius,
  extractImports,
  topHotFiles,
  analyze,
  BlastInputSchema,
  BlastOutputSchema,
  DEFAULT_MAX_DEPTH,
} from '../index';

let tmpRoot: string;

function write(rel: string, contents: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
  return full;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blast-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('extractImports', () => {
  it('extracts ES module imports', () => {
    const src = `import foo from './foo';\nimport { bar } from './bar';`;
    expect(extractImports(src)).toEqual(['./foo', './bar']);
  });

  it('extracts require() calls', () => {
    const src = `const foo = require('./foo');`;
    expect(extractImports(src)).toEqual(['./foo']);
  });

  it('extracts dynamic imports', () => {
    const src = `const mod = await import('./lazy');`;
    expect(extractImports(src)).toEqual(['./lazy']);
  });

  it('extracts re-exports', () => {
    const src = `export { foo } from './foo';\nexport * from './bar';`;
    expect(extractImports(src)).toEqual(['./foo', './bar']);
  });

  it('ignores imports inside block comments', () => {
    const src = `/* import foo from './nope'; */\nimport bar from './bar';`;
    expect(extractImports(src)).toEqual(['./bar']);
  });
});

describe('buildGraph', () => {
  it('builds forward and reverse edges for a trivial graph', () => {
    write('a.ts', `import b from './b';\nexport default 1;`);
    write('b.ts', `export default 2;`);

    const graph = buildGraph(tmpRoot);
    expect(graph.fileCount).toBe(2);

    const aPath = path.join(tmpRoot, 'a.ts');
    const bPath = path.join(tmpRoot, 'b.ts');

    expect(graph.imports.get(aPath)?.has(bPath)).toBe(true);
    expect(graph.importedBy.get(bPath)?.has(aPath)).toBe(true);
  });

  it('resolves index files in directories', () => {
    write('consumer.ts', `import { x } from './lib';`);
    write('lib/index.ts', `export const x = 1;`);

    const graph = buildGraph(tmpRoot);
    const consumerPath = path.join(tmpRoot, 'consumer.ts');
    const libIndex = path.join(tmpRoot, 'lib', 'index.ts');

    expect(graph.imports.get(consumerPath)?.has(libIndex)).toBe(true);
  });

  it('resolves alias to package dir via src/index.ts fallback', () => {
    // Simulates monorepo layout: @stackbilt/types → packages/types
    write('packages/types/src/index.ts', `export type X = number;`);
    write('packages/cli/src/index.ts', `import type { X } from '@stackbilt/types';`);

    const graph = buildGraph(tmpRoot, { aliases: { '@stackbilt/types': 'packages/types' } });
    const consumerPath = path.join(tmpRoot, 'packages', 'cli', 'src', 'index.ts');
    const libPath = path.join(tmpRoot, 'packages', 'types', 'src', 'index.ts');

    expect(graph.imports.get(consumerPath)?.has(libPath)).toBe(true);
  });

  it('resolves alias to package dir via package.json main', () => {
    write('packages/lib/package.json', `{"main":"./lib/entry.ts"}`);
    write('packages/lib/lib/entry.ts', `export const x = 1;`);
    write('consumer.ts', `import { x } from '@scope/lib';`);

    const graph = buildGraph(tmpRoot, { aliases: { '@scope/lib': 'packages/lib' } });
    const consumerPath = path.join(tmpRoot, 'consumer.ts');
    const entryPath = path.join(tmpRoot, 'packages', 'lib', 'lib', 'entry.ts');

    expect(graph.imports.get(consumerPath)?.has(entryPath)).toBe(true);
  });

  it('resolves path aliases', () => {
    write('src/consumer.ts', `import { x } from '@/lib';`);
    write('src/lib.ts', `export const x = 1;`);

    const graph = buildGraph(tmpRoot, { aliases: { '@/': 'src/' } });
    const consumerPath = path.join(tmpRoot, 'src', 'consumer.ts');
    const libPath = path.join(tmpRoot, 'src', 'lib.ts');

    expect(graph.imports.get(consumerPath)?.has(libPath)).toBe(true);
  });

  it('handles ESM .js extension in TS imports (rewrites .js → .ts)', () => {
    write('consumer.ts', `import { x } from './lib.js';`);
    write('lib.ts', `export const x = 1;`);

    const graph = buildGraph(tmpRoot);
    const consumerPath = path.join(tmpRoot, 'consumer.ts');
    const libPath = path.join(tmpRoot, 'lib.ts');

    expect(graph.imports.get(consumerPath)?.has(libPath)).toBe(true);
    expect(graph.importedBy.get(libPath)?.has(consumerPath)).toBe(true);
  });

  it('ignores bare specifiers (external packages)', () => {
    write('a.ts', `import fs from 'fs';\nimport { z } from 'zod';`);

    const graph = buildGraph(tmpRoot);
    const aPath = path.join(tmpRoot, 'a.ts');
    expect(graph.imports.get(aPath)?.size).toBe(0);
  });

  it('skips ignored directories', () => {
    write('src/a.ts', `export const x = 1;`);
    write('node_modules/bad.ts', `export const y = 1;`);
    write('dist/built.ts', `export const z = 1;`);

    const graph = buildGraph(tmpRoot);
    expect(graph.fileCount).toBe(1);
  });
});

describe('blastRadius', () => {
  it('finds direct importers at depth 1', () => {
    write('leaf.ts', `export const x = 1;`);
    write('mid.ts', `import { x } from './leaf';\nexport const y = x;`);
    write('top.ts', `import { y } from './mid';\nexport const z = y;`);

    const graph = buildGraph(tmpRoot);
    const result = blastRadius(graph, [path.join(tmpRoot, 'leaf.ts')]);

    expect(result.affected).toContain('mid.ts');
    expect(result.affected).toContain('top.ts');
    expect(result.summary.totalAffected).toBe(2);
  });

  it('respects maxDepth', () => {
    write('a.ts', `export const a = 1;`);
    write('b.ts', `import { a } from './a';\nexport const b = a;`);
    write('c.ts', `import { b } from './b';\nexport const c = b;`);
    write('d.ts', `import { c } from './c';\nexport const d = c;`);

    const graph = buildGraph(tmpRoot);
    const result = blastRadius(graph, [path.join(tmpRoot, 'a.ts')], { maxDepth: 1 });

    expect(result.affected).toContain('b.ts');
    expect(result.affected).not.toContain('c.ts');
    expect(result.affected).not.toContain('d.ts');
  });

  it('excludes seed files from affected list', () => {
    write('a.ts', `export const x = 1;`);
    write('b.ts', `import { x } from './a';`);

    const graph = buildGraph(tmpRoot);
    const result = blastRadius(graph, [path.join(tmpRoot, 'a.ts')]);

    expect(result.affected).not.toContain('a.ts');
    expect(result.affected).toContain('b.ts');
  });

  it('handles multiple seeds', () => {
    write('a.ts', `export const a = 1;`);
    write('b.ts', `export const b = 1;`);
    write('consumer.ts', `import { a } from './a';\nimport { b } from './b';`);

    const graph = buildGraph(tmpRoot);
    const result = blastRadius(graph, [
      path.join(tmpRoot, 'a.ts'),
      path.join(tmpRoot, 'b.ts'),
    ]);

    expect(result.summary.seedCount).toBe(2);
    expect(result.affected).toContain('consumer.ts');
  });

  it('handles cycles without infinite looping', () => {
    write('a.ts', `import './b';\nexport const a = 1;`);
    write('b.ts', `import './a';\nexport const b = 1;`);

    const graph = buildGraph(tmpRoot);
    const result = blastRadius(graph, [path.join(tmpRoot, 'a.ts')]);

    expect(result.affected).toContain('b.ts');
  });
});

describe('topHotFiles', () => {
  it('ranks files by importer count', () => {
    write('shared.ts', `export const x = 1;`);
    write('a.ts', `import { x } from './shared';`);
    write('b.ts', `import { x } from './shared';`);
    write('c.ts', `import { x } from './shared';`);

    const graph = buildGraph(tmpRoot);
    const hot = topHotFiles(graph, 5);

    expect(hot[0].file).toBe(path.join(tmpRoot, 'shared.ts'));
    expect(hot[0].importers).toBe(3);
  });

  it('breaks ties deterministically by filename', () => {
    // Three leaves, each with exactly one importer — all tied at importers=1.
    // Filenames are crafted to test sort stability: z > m > a lexicographically.
    write('leaf_z.ts', `export const z = 1;`);
    write('leaf_m.ts', `export const m = 1;`);
    write('leaf_a.ts', `export const a = 1;`);
    write('use_z.ts', `import { z } from './leaf_z';`);
    write('use_m.ts', `import { m } from './leaf_m';`);
    write('use_a.ts', `import { a } from './leaf_a';`);

    const graph = buildGraph(tmpRoot);
    const hot = topHotFiles(graph, 10);

    // Only the leaf files have importers > 0. Ties break by filename ascending.
    const tiedLeaves = hot.filter((h) => h.importers === 1).map((h) => path.basename(h.file));
    expect(tiedLeaves).toEqual(['leaf_a.ts', 'leaf_m.ts', 'leaf_z.ts']);
  });
});

// ============================================================================
// Zod schemas + analyze — Core-Out contract
// ============================================================================

describe('BlastInputSchema', () => {
  it('applies default maxDepth when omitted', () => {
    const parsed = BlastInputSchema.parse({ seeds: ['src/x.ts'] });
    expect(parsed.maxDepth).toBe(DEFAULT_MAX_DEPTH);
    expect(parsed.root).toBe('.');
    expect(parsed.aliases).toEqual({});
  });

  it('rejects maxDepth < 1', () => {
    expect(() => BlastInputSchema.parse({ seeds: ['x'], maxDepth: 0 })).toThrow();
    expect(() => BlastInputSchema.parse({ seeds: ['x'], maxDepth: -2 })).toThrow();
  });

  it('rejects non-integer maxDepth', () => {
    expect(() => BlastInputSchema.parse({ seeds: ['x'], maxDepth: 1.5 })).toThrow();
  });

  it('rejects empty seeds array', () => {
    expect(() => BlastInputSchema.parse({ seeds: [] })).toThrow();
  });
});

describe('analyze', () => {
  it('returns a shape that matches BlastOutputSchema', () => {
    write('leaf.ts', `export const x = 1;`);
    write('importer.ts', `import { x } from './leaf';`);

    const input = BlastInputSchema.parse({
      seeds: [path.join(tmpRoot, 'leaf.ts')],
      root: tmpRoot,
    });
    const result = analyze(input);

    // Structural assertion — no snapshot flakiness.
    expect(() => BlastOutputSchema.parse(result)).not.toThrow();
    expect(result.summary.totalAffected).toBe(1);
    expect(result.affected).toContain('importer.ts');
  });

  it('throws a descriptive error when a seed is missing', () => {
    expect(() =>
      analyze(
        BlastInputSchema.parse({
          seeds: [path.join(tmpRoot, 'does-not-exist.ts')],
          root: tmpRoot,
        }),
      ),
    ).toThrow(/Seed file\(s\) not found/);
  });

  it('agrees with buildGraph + blastRadius on affected files', () => {
    write('a.ts', `export const a = 1;`);
    write('b.ts', `import { a } from './a';\nexport const b = a;`);
    write('c.ts', `import { b } from './b';\nexport const c = b;`);

    const input = BlastInputSchema.parse({
      seeds: [path.join(tmpRoot, 'a.ts')],
      root: tmpRoot,
      maxDepth: 2,
    });
    const fromAnalyze = analyze(input);

    const graph = buildGraph(tmpRoot);
    const fromLowLevel = blastRadius(graph, [path.join(tmpRoot, 'a.ts')], { maxDepth: 2 });

    expect(fromAnalyze.affected.sort()).toEqual(fromLowLevel.affected.sort());
    expect(fromAnalyze.summary.totalAffected).toBe(fromLowLevel.summary.totalAffected);
  });
});

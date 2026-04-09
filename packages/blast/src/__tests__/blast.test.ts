import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildGraph, blastRadius, extractImports, topHotFiles } from '../index';

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
});

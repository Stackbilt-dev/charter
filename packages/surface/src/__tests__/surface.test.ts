import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractRoutes, extractSchema, extractSurface, formatSurfaceMarkdown } from '../index';

let tmpRoot: string;

function write(rel: string, contents: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
  return full;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('extractRoutes', () => {
  it('extracts Hono routes', () => {
    const src = `
import { Hono } from 'hono';
const app = new Hono();
app.get('/users', handler);
app.post('/users', createHandler);
app.get('/users/:id', getOne);
`;
    const routes = extractRoutes(src, 'app.ts');
    expect(routes.length).toBe(3);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/users', framework: 'hono' });
    expect(routes[1]).toMatchObject({ method: 'POST', path: '/users' });
    expect(routes[2].path).toBe('/users/:id');
  });

  it('extracts Express routes', () => {
    const src = `
const express = require('express');
const app = express();
app.get('/health', (req, res) => res.send('ok'));
app.delete('/sessions/:id', cleanup);
`;
    const routes = extractRoutes(src, 'server.js');
    expect(routes.length).toBe(2);
    expect(routes[0].framework).toBe('express');
    expect(routes[1].method).toBe('DELETE');
  });

  it('detects basePath prefix', () => {
    const src = `
import { Hono } from 'hono';
const app = new Hono().basePath('/api/v1');
app.get('/users', h);
`;
    const routes = extractRoutes(src, 'api.ts');
    expect(routes[0].prefix).toBe('/api/v1');
  });

  it('ignores route patterns inside comments', () => {
    const src = `
import { Hono } from 'hono';
const app = new Hono();
// Example usage: app.get('/fake-from-comment', handler)
/* Another example:
 *   app.post('/also-fake', h);
 *   router.delete('/nope', h);
 */
app.get('/real', handler);
`;
    const routes = extractRoutes(src, 'app.ts');
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/real');
  });

  it('handles router. prefix', () => {
    const src = `
const router = new Hono();
router.post('/login', authHandler);
`;
    const routes = extractRoutes(src, 'auth.ts');
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/login');
  });
});

describe('extractSchema', () => {
  it('parses simple CREATE TABLE', () => {
    const sql = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
    const tables = extractSchema(sql, 'schema.sql');
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('users');
    expect(tables[0].columns).toHaveLength(3);

    const idCol = tables[0].columns.find((c) => c.name === 'id')!;
    expect(idCol.primaryKey).toBe(true);
    expect(idCol.type).toBe('TEXT');

    const emailCol = tables[0].columns.find((c) => c.name === 'email')!;
    expect(emailCol.nullable).toBe(false);
    expect(emailCol.unique).toBe(true);

    const createdCol = tables[0].columns.find((c) => c.name === 'created_at')!;
    expect(createdCol.defaultValue).toBeDefined();
  });

  it('handles IF NOT EXISTS', () => {
    const sql = `CREATE TABLE IF NOT EXISTS widgets (id INTEGER PRIMARY KEY, name TEXT);`;
    const tables = extractSchema(sql, 'schema.sql');
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('widgets');
    expect(tables[0].columns).toHaveLength(2);
  });

  it('skips table-level constraints', () => {
    const sql = `
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  FOREIGN KEY (author_id) REFERENCES users(id)
);
`;
    const tables = extractSchema(sql, 'schema.sql');
    expect(tables[0].columns).toHaveLength(2); // FK clause is not a column
    expect(tables[0].columns.map((c) => c.name)).toEqual(['id', 'author_id']);
  });

  it('parses multiple tables', () => {
    const sql = `
CREATE TABLE a (id INTEGER PRIMARY KEY);
CREATE TABLE b (id INTEGER PRIMARY KEY);
CREATE TABLE c (id INTEGER PRIMARY KEY);
`;
    const tables = extractSchema(sql, 'schema.sql');
    expect(tables.map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('handles parameterized types', () => {
    const sql = `CREATE TABLE t (id INTEGER PRIMARY KEY, name VARCHAR(255) NOT NULL);`;
    const tables = extractSchema(sql, 'schema.sql');
    const nameCol = tables[0].columns.find((c) => c.name === 'name')!;
    expect(nameCol.type).toBe('VARCHAR(255)');
  });
});

describe('extractSurface (integration)', () => {
  it('combines routes and schema from a mock project', () => {
    write(
      'src/app.ts',
      `import { Hono } from 'hono';
const app = new Hono();
app.get('/health', () => new Response('ok'));
app.post('/api/users', createUser);
`
    );
    write(
      'schema.sql',
      `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);`
    );

    const surface = extractSurface({ root: tmpRoot });
    expect(surface.summary.routeCount).toBe(2);
    expect(surface.summary.schemaTableCount).toBe(1);
    expect(surface.summary.routesByFramework.hono).toBe(2);
    expect(surface.schemas[0].name).toBe('users');
  });

  it('ignores test/spec files and __tests__ dirs', () => {
    write('src/app.ts', `import { Hono } from 'hono';\napp.get('/real', h);`);
    write('src/app.test.ts', `app.get('/fake-from-test', h);`);
    write('src/__tests__/fixtures.ts', `app.get('/fake-from-tests-dir', h);`);
    write('src/handler.spec.ts', `app.post('/fake-from-spec', h);`);

    const surface = extractSurface({ root: tmpRoot });
    expect(surface.summary.routeCount).toBe(1);
    expect(surface.routes[0].path).toBe('/real');
  });

  it('ignores node_modules and dist', () => {
    write('src/app.ts', `app.get('/a', h);`);
    write('node_modules/bad/src/x.ts', `app.get('/evil', h);`);
    write('dist/bundle.js', `app.get('/compiled', h);`);

    const surface = extractSurface({ root: tmpRoot });
    expect(surface.summary.routeCount).toBe(1);
    expect(surface.routes[0].path).toBe('/a');
  });

  it('formats markdown output', () => {
    write('src/app.ts', `import { Hono } from 'hono';\napp.get('/x', h);`);
    write('schema.sql', `CREATE TABLE t (id TEXT PRIMARY KEY);`);

    const surface = extractSurface({ root: tmpRoot });
    const md = formatSurfaceMarkdown(surface);
    expect(md).toContain('# API Surface');
    expect(md).toContain('GET /x');
    expect(md).toContain('### t');
  });
});

/**
 * @stackbilt/surface — API Surface Extraction
 *
 * Extracts two things from a project:
 *   1. HTTP routes (Hono, Express, itty-router) via regex matching
 *   2. Database schema (D1 schema.sql CREATE TABLE statements)
 *
 * Zero dependencies. Pure heuristic — no TypeScript compiler API, no AST.
 *
 * Trade-off: misses exotic patterns (dynamic route registration,
 * programmatic middleware chains). Captures the 95% case for Cloudflare
 * Worker projects, which is the primary use case for Charter.
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface Route {
  method: string;
  path: string;
  file: string;
  line: number;
  framework: 'hono' | 'express' | 'itty' | 'unknown';
  /** Router prefix if detected (e.g. '/api') */
  prefix?: string;
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  file: string;
  line: number;
}

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  defaultValue?: string;
}

export interface Surface {
  root: string;
  routes: Route[];
  schemas: SchemaTable[];
  summary: {
    routeCount: number;
    schemaTableCount: number;
    routesByMethod: Record<string, number>;
    routesByFramework: Record<string, number>;
  };
}

export interface ExtractOptions {
  /** root directory (default: cwd) */
  root?: string;
  /** file extensions to scan for routes (default: ts, tsx, js, jsx, mjs) */
  extensions?: string[];
  /** directories to ignore */
  ignoreDirs?: string[];
  /** explicit schema file path(s); default: auto-detect schema.sql anywhere under root */
  schemaPaths?: string[];
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.next',
  '.turbo',
  '.wrangler',
  'coverage',
  '__tests__',
  '__mocks__',
  '__fixtures__',
]);

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all'];

// ============================================================================
// File walking
// ============================================================================

function walkFiles(
  dir: string,
  extensions: Set<string>,
  ignoreDirs: Set<string>,
  out: string[] = []
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (ignoreDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, extensions, ignoreDirs, out);
    } else if (entry.isFile()) {
      if (extensions.has(path.extname(entry.name))) out.push(full);
    }
  }
  return out;
}

// ============================================================================
// Route extraction
// ============================================================================

/**
 * Extract HTTP routes from a source file.
 *
 * Detects:
 *   - Hono / Express: `app.get('/path', handler)`, `router.post('/path', ...)`
 *   - Route prefix via `app.route('/api', subRouter)` or `.basePath('/api')`
 *   - itty-router: same pattern as Hono
 *
 * Returns routes with the source file path and line number.
 */
export function extractRoutes(source: string, filePath: string): Route[] {
  const routes: Route[] = [];
  // Strip block comments and line comments before scanning.
  // Preserves line numbers by replacing comment bodies with spaces.
  const stripped = stripComments(source);
  const lines = stripped.split('\n');

  // Detect basePath (applies to this router within the file)
  let basePath: string | undefined;
  const basePathMatch = stripped.match(/\.basePath\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/);
  if (basePathMatch) basePath = basePathMatch[1];

  // Framework detection from import statements (use original source —
  // detectFramework only looks at import lines which aren't commented out)
  const framework = detectFramework(source);

  // Pattern: <identifier>.METHOD('/path', ...)
  // Requires the path to start with '/' to avoid matching arbitrary method calls
  // like obj.get(key) or list.post(item) that happen to share method names.
  const routePattern = new RegExp(
    `\\b([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\.\\s*(${HTTP_METHODS.join('|')})\\s*\\(\\s*['"\`](/[^'"\`]*)['"\`]`,
    'gi'
  );

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    routePattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = routePattern.exec(line)) !== null) {
      const method = match[2].toUpperCase();
      const routePath = match[3];
      routes.push({
        method,
        path: routePath,
        file: filePath,
        line: i + 1,
        framework,
        prefix: basePath,
      });
    }
  }

  return routes;
}

/**
 * Strip block and line comments from source, preserving line numbers
 * by replacing stripped content with equivalent whitespace.
 */
function stripComments(source: string): string {
  let result = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    // Block comment
    if (ch === '/' && next === '*') {
      result += '  ';
      i += 2;
      while (i < n - 1 && !(source[i] === '*' && source[i + 1] === '/')) {
        result += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      result += '  ';
      i += 2;
      continue;
    }
    // Line comment
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        result += ' ';
        i++;
      }
      continue;
    }
    // String literal — preserve contents (contains real route paths)
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      result += ch;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          result += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        result += source[i];
        i++;
      }
      if (i < n) {
        result += source[i];
        i++;
      }
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

function detectFramework(source: string): Route['framework'] {
  if (/from\s+['"`]hono['"`]/.test(source) || /require\s*\(\s*['"`]hono['"`]/.test(source)) {
    return 'hono';
  }
  if (/from\s+['"`]express['"`]/.test(source) || /require\s*\(\s*['"`]express['"`]/.test(source)) {
    return 'express';
  }
  if (/from\s+['"`]itty-router['"`]/.test(source)) return 'itty';
  return 'unknown';
}

// ============================================================================
// Schema extraction (D1 / SQLite CREATE TABLE)
// ============================================================================

/**
 * Extract tables and columns from a schema.sql file.
 * Parses CREATE TABLE statements, including column definitions and constraints.
 *
 * Handles:
 *   - Basic column types (TEXT, INTEGER, REAL, BLOB)
 *   - NOT NULL, PRIMARY KEY, UNIQUE, DEFAULT
 *   - Multi-column PRIMARY KEY, FOREIGN KEY clauses (flagged but not parsed as columns)
 */
export function extractSchema(source: string, filePath: string): SchemaTable[] {
  const tables: SchemaTable[] = [];
  // Match CREATE TABLE (with IF NOT EXISTS) ... ( ... );
  // Use a simple bracket-matching approach since SQL parens can nest.
  const stmtRegex = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+[`"']?(\w+)[`"']?\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = stmtRegex.exec(source)) !== null) {
    const tableName = match[1];
    const bodyStart = match.index + match[0].length;
    const body = extractBalancedParens(source, bodyStart);
    if (body === null) continue;
    const lineNumber = source.slice(0, match.index).split('\n').length;
    const columns = parseColumns(body);
    tables.push({
      name: tableName,
      columns,
      file: filePath,
      line: lineNumber,
    });
  }
  return tables;
}

/**
 * Given a position just after an opening paren, return the content up to
 * the matching closing paren (inclusive of nesting).
 */
function extractBalancedParens(source: string, start: number): string | null {
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0) return source.slice(start, i);
    i++;
  }
  return null;
}

/**
 * Parse column definitions from a CREATE TABLE body.
 * Splits on commas at the top level (not inside parens) and filters out
 * table-level constraints.
 */
function parseColumns(body: string): SchemaColumn[] {
  const defs = splitTopLevelCommas(body);
  const columns: SchemaColumn[] = [];

  for (const rawDef of defs) {
    const def = rawDef.trim();
    if (!def) continue;

    // Skip table-level constraints
    const upper = def.toUpperCase();
    if (
      upper.startsWith('PRIMARY KEY') ||
      upper.startsWith('FOREIGN KEY') ||
      upper.startsWith('UNIQUE') ||
      upper.startsWith('CHECK') ||
      upper.startsWith('CONSTRAINT')
    ) {
      continue;
    }

    // Column name and type
    const tokenMatch = def.match(/^[`"']?(\w+)[`"']?\s+(\w+(?:\s*\([^)]*\))?)/);
    if (!tokenMatch) continue;
    const name = tokenMatch[1];
    const type = tokenMatch[2].toUpperCase().replace(/\s+/g, '');

    const rest = def.slice(tokenMatch[0].length).toUpperCase();
    const nullable = !/\bNOT\s+NULL\b/.test(rest);
    const primaryKey = /\bPRIMARY\s+KEY\b/.test(rest);
    const unique = /\bUNIQUE\b/.test(rest);
    const defaultMatch = def
      .slice(tokenMatch[0].length)
      .match(/\bDEFAULT\s+((?:\([^)]*\))|'[^']*'|"[^"]*"|\S+)/i);
    const defaultValue = defaultMatch ? defaultMatch[1] : undefined;

    columns.push({
      name,
      type,
      nullable,
      primaryKey,
      unique,
      defaultValue,
    });
  }

  return columns;
}

function splitTopLevelCommas(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

// ============================================================================
// Top-level extraction
// ============================================================================

/**
 * Scan a project directory and return its full API surface (routes + schemas).
 */
export function extractSurface(options: ExtractOptions = {}): Surface {
  const root = path.resolve(options.root ?? '.');
  const extensions = new Set(options.extensions ?? DEFAULT_EXTENSIONS);
  const ignoreDirs = new Set([...DEFAULT_IGNORE_DIRS, ...(options.ignoreDirs ?? [])]);

  // Routes
  const sourceFiles = walkFiles(root, extensions, ignoreDirs);
  const routes: Route[] = [];
  for (const file of sourceFiles) {
    // Skip test/spec files — their route strings are fixtures, not real routes
    const base = path.basename(file);
    if (/\.(test|spec)\.[mc]?[tj]sx?$/i.test(base)) continue;

    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Skip files that obviously don't contain route registrations
    if (!/\.(get|post|put|delete|patch|options|head|all)\s*\(/i.test(content)) continue;
    const fileRoutes = extractRoutes(content, path.relative(root, file));
    routes.push(...fileRoutes);
  }

  // Schemas
  const schemaFiles =
    options.schemaPaths ??
    walkFiles(root, new Set(['.sql']), ignoreDirs).filter((f) =>
      path.basename(f).toLowerCase().includes('schema')
    );
  const schemas: SchemaTable[] = [];
  for (const schemaFile of schemaFiles) {
    let content: string;
    try {
      content = fs.readFileSync(schemaFile, 'utf8');
    } catch {
      continue;
    }
    const tables = extractSchema(content, path.relative(root, schemaFile));
    schemas.push(...tables);
  }

  // Summary
  const routesByMethod: Record<string, number> = {};
  const routesByFramework: Record<string, number> = {};
  for (const r of routes) {
    routesByMethod[r.method] = (routesByMethod[r.method] ?? 0) + 1;
    routesByFramework[r.framework] = (routesByFramework[r.framework] ?? 0) + 1;
  }

  return {
    root,
    routes,
    schemas,
    summary: {
      routeCount: routes.length,
      schemaTableCount: schemas.length,
      routesByMethod,
      routesByFramework,
    },
  };
}

/**
 * Format a surface as a compact markdown summary suitable for AI context
 * injection or an auto-generated `.ai/surface.adf` module.
 */
export function formatSurfaceMarkdown(surface: Surface): string {
  const lines: string[] = [];
  lines.push('# API Surface');
  lines.push('');
  lines.push(`**Routes:** ${surface.summary.routeCount}`);
  lines.push(`**Tables:** ${surface.summary.schemaTableCount}`);
  lines.push('');

  if (surface.routes.length > 0) {
    lines.push('## Routes');
    lines.push('');
    // Group by framework for readability
    const byFramework = new Map<string, Route[]>();
    for (const r of surface.routes) {
      if (!byFramework.has(r.framework)) byFramework.set(r.framework, []);
      byFramework.get(r.framework)!.push(r);
    }
    for (const [framework, routes] of byFramework) {
      lines.push(`### ${framework}`);
      for (const r of routes) {
        const fullPath = r.prefix ? `${r.prefix}${r.path}` : r.path;
        lines.push(`- \`${r.method} ${fullPath}\` — ${r.file}:${r.line}`);
      }
      lines.push('');
    }
  }

  if (surface.schemas.length > 0) {
    lines.push('## Schema');
    lines.push('');
    for (const t of surface.schemas) {
      lines.push(`### ${t.name}`);
      for (const c of t.columns) {
        const flags: string[] = [];
        if (c.primaryKey) flags.push('pk');
        if (c.unique) flags.push('unique');
        if (!c.nullable) flags.push('not null');
        const flagsStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
        lines.push(`- \`${c.name}\` ${c.type}${flagsStr}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

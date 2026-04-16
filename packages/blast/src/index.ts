/**
 * @stackbilt/blast — Blast Radius Analysis
 *
 * Builds a reverse dependency graph from TypeScript/JavaScript source files
 * and performs BFS traversal to determine which files are affected by
 * changes to a given set of seed files.
 *
 * AST-free: uses regex-based import extraction, which trades some accuracy
 * for universality and speed. Runtime dependency on Zod only — the schemas
 * below are the authoritative input/output contract shared by the CLI and
 * MCP tool adapters.
 *
 * Inspired by the CodeSight project's blast-radius algorithm, adapted for
 * the Charter governance workflow.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

// ============================================================================
// Types
// ============================================================================

export interface DependencyGraph {
  /** file -> files it imports */
  imports: Map<string, Set<string>>;
  /** file -> files that import it */
  importedBy: Map<string, Set<string>>;
  /** root directory the graph was built from */
  root: string;
  /** total files scanned */
  fileCount: number;
}

export interface BlastRadiusResult {
  /** seed files the analysis started from */
  seeds: string[];
  /** files affected (transitive importers of seeds), excluding seeds themselves */
  affected: string[];
  /** max depth reached during BFS */
  maxDepth: number;
  /** files ranked by how many *other* files depend on them (top 20) */
  hotFiles: Array<{ file: string; importers: number }>;
  /** summary: total affected + depth histogram */
  summary: {
    totalAffected: number;
    seedCount: number;
    depthHistogram: Record<number, number>;
  };
}

export interface BuildGraphOptions {
  /** glob-like extensions to include (default: ts, tsx, js, jsx, mjs, cjs) */
  extensions?: string[];
  /** directory names to skip (default: node_modules, dist, build, .git, .next) */
  ignoreDirs?: string[];
  /** optional path alias map, e.g. { '@/': 'src/' } */
  aliases?: Record<string, string>;
}

export interface BlastOptions {
  /** max BFS depth (default: 3) */
  maxDepth?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Default BFS traversal depth. Referenced by both the schema default and
 * blastRadius's in-function default so they cannot drift. */
export const DEFAULT_MAX_DEPTH = 3;

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.wrangler',
  '.claude',
]);

// Matches: import X from '...', import { X } from '...', import '...', export ... from '...', require('...')
const IMPORT_PATTERNS = [
  /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

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
    if (entry.name.startsWith('.') && entry.name !== '.') {
      // Skip dotfiles/dotdirs except explicit root
      if (ignoreDirs.has(entry.name)) continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name)) continue;
      walkFiles(full, extensions, ignoreDirs, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (extensions.has(ext)) {
        out.push(full);
      }
    }
  }
  return out;
}

// ============================================================================
// Import extraction
// ============================================================================

/**
 * Extract all import specifiers from source code.
 * Returns raw specifier strings — resolution happens separately.
 */
export function extractImports(source: string): string[] {
  const specifiers: string[] = [];
  // Strip line comments and block comments conservatively to reduce false positives
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  for (const pattern of IMPORT_PATTERNS) {
    // Reset lastIndex since /g patterns are stateful
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stripped)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

// ============================================================================
// Specifier resolution
// ============================================================================

/**
 * Resolve an import specifier to an absolute file path within the project.
 * Returns null for external modules (bare specifiers without alias match).
 */
export function resolveSpecifier(
  specifier: string,
  fromFile: string,
  root: string,
  extensions: string[],
  aliases: Record<string, string>
): string | null {
  // Alias match (longest prefix wins)
  const aliasKeys = Object.keys(aliases).sort((a, b) => b.length - a.length);
  for (const key of aliasKeys) {
    if (specifier === key.replace(/\/$/, '') || specifier.startsWith(key)) {
      const rel = specifier.slice(key.length);
      const base = path.join(root, aliases[key], rel);
      return resolveWithExtensions(base, extensions);
    }
  }

  // Relative import
  if (specifier.startsWith('.')) {
    const base = path.resolve(path.dirname(fromFile), specifier);
    return resolveWithExtensions(base, extensions);
  }

  // Absolute path (rare)
  if (path.isAbsolute(specifier)) {
    return resolveWithExtensions(specifier, extensions);
  }

  // Bare specifier (external package) — not a graph edge
  return null;
}

function resolveWithExtensions(base: string, extensions: string[]): string | null {
  // Exact file
  if (hasExtension(base, extensions) && fs.existsSync(base)) return base;

  // ESM convention: TypeScript source uses .js extension in imports even
  // though the source file is .ts/.tsx. Rewrite .js → .ts/.tsx.
  const jsExt = /\.(js|mjs|cjs)$/;
  if (jsExt.test(base)) {
    const stem = base.replace(jsExt, '');
    for (const replacement of ['.ts', '.tsx', '.mts', '.cts']) {
      const candidate = stem + replacement;
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Try appending each extension
  for (const ext of extensions) {
    const candidate = base + ext;
    if (fs.existsSync(candidate)) return candidate;
  }
  // Directory resolution. Source-first, then package.json as fallback.
  // Rationale: in monorepos with TS workspaces, we want dep-graph edges
  // pointing at .ts source files, not compiled .d.ts declarations.
  try {
    if (fs.statSync(base).isDirectory()) {
      // 1. src/index.* — standard monorepo source layout
      for (const ext of extensions) {
        const srcIndex = path.join(base, 'src', 'index' + ext);
        if (fs.existsSync(srcIndex)) return srcIndex;
      }
      // 2. bare index.*
      for (const ext of extensions) {
        const candidate = path.join(base, 'index' + ext);
        if (fs.existsSync(candidate)) return candidate;
      }
      // 3. package.json source/types/main (for packages without src/)
      const pkgPath = path.join(base, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
            main?: string;
            types?: string;
            source?: string;
          };
          const candidates = [pkg.source, pkg.types, pkg.main].filter(Boolean) as string[];
          for (const c of candidates) {
            const resolved = resolveWithExtensions(path.join(base, c), extensions);
            if (resolved) return resolved;
          }
        } catch {
          /* malformed package.json */
        }
      }
    }
  } catch {
    /* not a directory */
  }
  return null;
}

function hasExtension(file: string, extensions: string[]): boolean {
  const ext = path.extname(file);
  return extensions.includes(ext);
}

// ============================================================================
// Graph building
// ============================================================================

/**
 * Build a dependency graph by scanning all source files under `root`.
 * Returns forward (imports) and reverse (importedBy) adjacency maps.
 */
export function buildGraph(root: string, options: BuildGraphOptions = {}): DependencyGraph {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const extSet = new Set(extensions);
  const ignoreDirs = new Set([...DEFAULT_IGNORE_DIRS, ...(options.ignoreDirs ?? [])]);
  const aliases = options.aliases ?? {};

  const absRoot = path.resolve(root);
  const files = walkFiles(absRoot, extSet, ignoreDirs);

  const imports = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();

  for (const file of files) {
    imports.set(file, new Set());
    if (!importedBy.has(file)) importedBy.set(file, new Set());
  }

  for (const file of files) {
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const specifiers = extractImports(source);
    for (const spec of specifiers) {
      const resolved = resolveSpecifier(spec, file, absRoot, extensions, aliases);
      if (!resolved) continue;
      if (!imports.get(file)!.has(resolved)) {
        imports.get(file)!.add(resolved);
      }
      if (!importedBy.has(resolved)) importedBy.set(resolved, new Set());
      importedBy.get(resolved)!.add(file);
    }
  }

  return {
    imports,
    importedBy,
    root: absRoot,
    fileCount: files.length,
  };
}

// ============================================================================
// Blast radius (BFS on reverse graph)
// ============================================================================

/**
 * Compute blast radius: the set of files that transitively depend on the
 * given seed files, up to a configurable depth.
 */
export function blastRadius(
  graph: DependencyGraph,
  seeds: string[],
  options: BlastOptions = {}
): BlastRadiusResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const absSeeds = seeds.map((s) => path.resolve(s));
  const seedSet = new Set(absSeeds);

  const visited = new Map<string, number>(); // file -> depth
  const queue: Array<{ file: string; depth: number }> = [];
  for (const seed of absSeeds) {
    queue.push({ file: seed, depth: 0 });
    visited.set(seed, 0);
  }

  let reachedDepth = 0;
  while (queue.length > 0) {
    const { file, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    const parents = graph.importedBy.get(file) ?? new Set();
    for (const parent of parents) {
      if (!visited.has(parent)) {
        visited.set(parent, depth + 1);
        reachedDepth = Math.max(reachedDepth, depth + 1);
        queue.push({ file: parent, depth: depth + 1 });
      }
    }
  }

  const affected: string[] = [];
  const depthHistogram: Record<number, number> = {};
  for (const [file, depth] of visited) {
    depthHistogram[depth] = (depthHistogram[depth] ?? 0) + 1;
    if (!seedSet.has(file)) affected.push(file);
  }
  affected.sort();

  const hotFiles = topHotFiles(graph, 20);

  return {
    seeds: absSeeds.map((s) => path.relative(graph.root, s)),
    affected: affected.map((a) => path.relative(graph.root, a)),
    maxDepth: reachedDepth,
    hotFiles: hotFiles.map((h) => ({
      file: path.relative(graph.root, h.file),
      importers: h.importers,
    })),
    summary: {
      totalAffected: affected.length,
      seedCount: absSeeds.length,
      depthHistogram,
    },
  };
}

/**
 * Identify the N most-imported files ("hot files").
 * Useful for surfacing architectural bottlenecks.
 */
export function topHotFiles(
  graph: DependencyGraph,
  limit: number
): Array<{ file: string; importers: number }> {
  const ranked: Array<{ file: string; importers: number }> = [];
  for (const [file, parents] of graph.importedBy) {
    if (parents.size === 0) continue;
    ranked.push({ file, importers: parents.size });
  }
  // Primary: descending importer count. Secondary: ascending filename, so
  // ties are deterministic across Node majors and filesystem scan order.
  ranked.sort((a, b) => b.importers - a.importers || a.file.localeCompare(b.file));
  return ranked.slice(0, limit);
}

// ============================================================================
// Zod schemas — authoritative input/output contract
// ============================================================================

export const BlastInputSchema = z.object({
  seeds: z
    .array(z.string().min(1))
    .min(1)
    .describe('One or more file paths whose blast radius should be computed. Paths may be absolute or relative to the process cwd.'),
  root: z
    .string()
    .optional()
    .default('.')
    .describe('Directory to scan for the dependency graph. Defaults to the current working directory.'),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .optional()
    .default(DEFAULT_MAX_DEPTH)
    .describe('Maximum BFS depth when traversing reverse dependencies. 1 = direct importers only.'),
  aliases: z
    .record(z.string(), z.string())
    .optional()
    .default({})
    .describe('Optional tsconfig-style path alias map (e.g. { "@/": "src/" }). The CLI auto-detects these from tsconfig.json; programmatic callers must supply them explicitly.'),
});

export type BlastInput = z.infer<typeof BlastInputSchema>;

export const BlastOutputSchema = z.object({
  root: z.string().describe('Resolved absolute root directory the graph was built from.'),
  fileCount: z.number().int().nonnegative().describe('Total source files scanned under root.'),
  seeds: z.array(z.string()).describe('Seed files, as paths relative to root.'),
  affected: z.array(z.string()).describe('Files that transitively import any seed, excluding seeds themselves, as paths relative to root.'),
  maxDepth: z.number().int().nonnegative().describe('Deepest BFS level actually reached.'),
  hotFiles: z
    .array(
      z.object({
        file: z.string(),
        importers: z.number().int().nonnegative(),
      }),
    )
    .describe('Top 20 most-imported files in the whole graph (not just the blast radius). Sorted by importer count descending, with filename as deterministic tie-breaker.'),
  summary: z.object({
    totalAffected: z.number().int().nonnegative(),
    seedCount: z.number().int().nonnegative(),
    depthHistogram: z.record(z.string(), z.number().int().nonnegative())
      .describe('Count of files reached at each BFS depth. Keys are stringified depths.'),
  }),
});

export type BlastOutput = z.infer<typeof BlastOutputSchema>;

// ============================================================================
// High-level analyze — the Core-Out entry point for CLI and MCP adapters
// ============================================================================

/**
 * Compose buildGraph + blastRadius from a validated input.
 *
 * This is the function both the CLI and the MCP tool adapter call. Low-level
 * consumers can still use buildGraph and blastRadius directly.
 */
export function analyze(input: BlastInput): BlastOutput {
  const absRoot = path.resolve(input.root);
  const graph = buildGraph(absRoot, { aliases: input.aliases });

  const absSeeds = input.seeds.map((s) => path.resolve(s));
  const missing = absSeeds.filter((s) => !fs.existsSync(s));
  if (missing.length > 0) {
    throw new Error(`Seed file(s) not found: ${missing.join(', ')}`);
  }
  const result = blastRadius(graph, absSeeds, { maxDepth: input.maxDepth });

  return {
    root: absRoot,
    fileCount: graph.fileCount,
    seeds: result.seeds,
    affected: result.affected,
    maxDepth: result.maxDepth,
    hotFiles: result.hotFiles,
    summary: result.summary,
  };
}

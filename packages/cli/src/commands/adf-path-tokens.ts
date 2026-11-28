/**
 * Path-token derivation for `charter adf context --files`.
 *
 * Splits a file path into its own name tokens
 * (`packages/adf/src/manifest.ts` -> `adf`, `manifest`) so the existing
 * trigger matcher can route modules from what the file is actually called,
 * not only from generic extension and directory signals.
 *
 * Over-triggering is the main risk, so two guards apply:
 * - Each path is first made relative to the repo root. The directories the
 *   checkout happens to sit in (`C:\Users\...`, `/home/...`) never become
 *   keywords, and a path outside the repo contributes no tokens at all.
 * - Generic scaffolding segments (packages, src, lib, dist, index, test dirs,
 *   extensions, ...) are dropped.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Generic path segments that say nothing about the domain of a file.
 * Kept deliberately small: anything listed here can never route a module
 * from a path, so only add words that appear in most repos' layouts.
 * Relativizing to the repo root is the main guard against checkout-root
 * words; the few listed under "checkout roots" are a backstop. Words that
 * are also common domain names (users, projects, workspace, code) are left
 * out on purpose, since `src/users/` is a real signal inside a repo.
 */
export const GENERIC_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  // layout roots
  'packages', 'package', 'apps', 'src', 'lib', 'libs', 'dist', 'build', 'out',
  'bin', 'vendor', 'internal', 'pkg',
  // checkout roots
  'home', 'documents', 'desktop', 'repo', 'repos',
  // entry points
  'index', 'main', 'mod',
  // test scaffolding
  'test', 'tests', 'spec', 'specs', 'e2e', 'fixtures', 'fixture', 'mocks', 'mock',
  // extensions and declaration markers
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'd', 'json', 'md', 'mdx',
  'yml', 'yaml', 'toml', 'txt', 'map',
]);

export interface PathTokenOptions {
  /** Repo root that paths are made relative to. Defaults to `cwd`. */
  root?: string;
  /** Directory relative paths are resolved against. Defaults to `process.cwd()`. */
  cwd?: string;
}

const WIN_DRIVE = /^[a-zA-Z]:([\\/]|$)/;

function isWindowsStyle(p: string): boolean {
  return WIN_DRIVE.test(p) || p.includes('\\');
}

/**
 * Make one file path relative to the repo root, with `/` separators.
 * Returns null when the path lies outside the root (it then contributes no
 * tokens). Handles Windows drive letters, backslashes, `./` and `../`.
 *
 * A relative path is resolved against `cwd`. If `cwd` itself is outside the
 * root, the relative path is taken as already repo-relative (unless it
 * climbs out with `../`).
 */
export function relativizeFilePath(filePath: string, root: string, cwd: string = root): string | null {
  const flavor = isWindowsStyle(filePath) || isWindowsStyle(root) || isWindowsStyle(cwd) ? path.win32 : path.posix;
  const inside = (rel: string): boolean =>
    rel !== '' && rel !== '.' && rel !== '..' &&
    !rel.startsWith('../') && !rel.startsWith('..\\') && !flavor.isAbsolute(rel);

  let rel: string;
  if (flavor.isAbsolute(filePath)) {
    rel = flavor.relative(root, filePath);
    if (!inside(rel)) return null;
  } else {
    rel = flavor.relative(root, flavor.resolve(cwd, filePath));
    if (!inside(rel)) {
      const cwdRel = flavor.relative(root, cwd);
      if (cwdRel === '' || inside(cwdRel)) return null;
      // cwd is outside the root: take the path as already repo-relative.
      rel = flavor.normalize(filePath);
      if (!inside(rel)) return null;
    }
  }
  return rel.split(/[\\/]+/).filter(s => s && s !== '.').join('/');
}

/**
 * The repo root for path relativizing: `git rev-parse --show-toplevel` run
 * from the directory that holds the `.ai/` dir, falling back to that
 * directory itself.
 */
export function resolvePathTokenRoot(aiDir: string, cwd: string = process.cwd()): string {
  const aiParent = path.dirname(path.resolve(cwd, aiDir));
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: aiParent,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    if (top) return path.resolve(top);
  } catch {
    // Not a git checkout (or git is missing): the .ai/ dir's parent is the root.
  }
  return aiParent;
}

/** Split one path segment into lowercase word tokens (kebab, snake, dot, camelCase). */
function splitSegment(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length > 1 && !/^\d+$/.test(t));
}

/**
 * Derive routing tokens from the file paths' own segments, after making each
 * path relative to the repo root (see `relativizeFilePath`).
 * Returns deduplicated lowercase tokens with generic segments removed.
 */
export function filePathToTokens(filePaths: string[], options: PathTokenOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const root = options.root ?? cwd;
  const tokens: string[] = [];
  for (const fp of filePaths) {
    const rel = relativizeFilePath(fp, root, cwd);
    if (rel === null) continue;
    for (const segment of rel.split('/')) {
      if (segment === 'node_modules') continue;
      for (const token of splitSegment(segment)) {
        if (!GENERIC_PATH_SEGMENTS.has(token)) tokens.push(token);
      }
    }
  }
  return [...new Set(tokens)];
}

/**
 * Extract keywords from file paths using extension and directory signals.
 * Maps file system structure to domain keywords for module resolution.
 *
 * Lives in this leaf module (no CLI imports) so MCP `getProjectContext` can use
 * it without importing adf-context.ts; adf-context.ts re-exports it unchanged.
 */
export function filePathToKeywords(filePaths: string[]): string[] {
  const keywords: string[] = [];
  for (const fp of filePaths) {
    const ext = path.extname(fp).slice(1).toLowerCase();
    const dir = path.dirname(fp).toLowerCase();

    // Extension signals
    if (['tsx', 'jsx'].includes(ext)) keywords.push('react', 'ui', 'frontend');
    if (['css', 'scss', 'sass', 'less'].includes(ext)) keywords.push('css', 'ui', 'frontend');
    if (['prisma'].includes(ext)) keywords.push('db', 'backend');
    if (['sql'].includes(ext)) keywords.push('db', 'migration');
    if (ext === 'toml' && fp.includes('wrangler')) keywords.push('deploy', 'cloudflare');

    // Directory signals
    if (/\b(component|ui|widget|page|layout|view)\b/.test(dir)) keywords.push('frontend', 'ui');
    if (/\b(api|server|handler|route|middleware|controller)\b/.test(dir)) keywords.push('api', 'backend');
    if (/\b(test|spec|__tests__|e2e)\b/.test(dir)) keywords.push('test', 'qa');
    if (/\b(deploy|infra|docker|ci|\.github)\b/.test(dir)) keywords.push('deploy', 'infra');
    if (/\b(auth|session|permission)\b/.test(dir)) keywords.push('auth', 'security');
  }
  return [...new Set(keywords)];
}

/**
 * All routing keywords for `--files` (CLI) and `files` (MCP), in one order so
 * both transports resolve the same modules: extension and directory signals,
 * then path tokens. Both see repo-relative paths, so the directories the
 * checkout sits in (`C:\Users\...`) never become signals. A path outside the
 * repo keeps only its file name, so extension signals still apply.
 */
export function fileRoutingKeywords(filePaths: string[], aiDir: string, cwd: string = process.cwd()): string[] {
  const root = resolvePathTokenRoot(aiDir, cwd);
  const relPaths = filePaths.map(fp => relativizeFilePath(fp, root, cwd) ?? baseName(fp));
  return [...new Set([...filePathToKeywords(relPaths), ...filePathToTokens(filePaths, { root, cwd })])];
}

function baseName(fp: string): string {
  return fp.split(/[\\/]+/).filter(Boolean).pop() ?? fp;
}

/**
 * Path-token derivation for `charter adf context --files`.
 *
 * Splits a file path into its own name tokens
 * (`packages/adf/src/manifest.ts` -> `adf`, `manifest`) so the existing
 * trigger matcher can route modules from what the file is actually called,
 * not only from generic extension and directory signals.
 *
 * Over-triggering is the main risk, so two guards apply:
 * - Each path is first made relative to the repo root, for path tokens and
 *   for the extension/directory signals alike. The directories the checkout
 *   happens to sit in (`C:\Users\...`, `/home/...`, an `api/` or `test/`
 *   folder above the repo) never become keywords, and a path outside the
 *   repo contributes no tokens and no directory signals.
 * - Generic scaffolding segments (packages, src, lib, dist, index, test dirs,
 *   extensions, ...) are dropped.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
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
 * Resolve symlinks and junctions so a checkout
 * reached through a link compares equal to the real path git reports. A path
 * that does not exist keeps its missing tail on top of its deepest existing
 * ancestor's real path.
 */
function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail);
    } catch {
      try {
        return path.join(fs.realpathSync(cur), ...tail);
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return abs;
        tail.unshift(path.basename(cur));
        cur = parent;
      }
    }
  }
}

/**
 * Make one file path relative to the repo root, with `/` separators.
 * Returns null when the path lies outside the root (it then contributes no
 * tokens or directory signals). Handles Windows drive letters, backslashes,
 * `./`, `../`, and roots reached through a symlink or junction.
 *
 * A relative path is resolved against `cwd`. When that file does not exist
 * but the same path does exist under the root (an agent passing a
 * repo-relative path from a subdirectory), it is taken as repo-relative. If
 * `cwd` itself is outside the root, the relative path is taken as already
 * repo-relative (unless it climbs out with `../`).
 */
export function relativizeFilePath(filePath: string, root: string, cwd: string = root): string | null {
  const flavor = isWindowsStyle(filePath) || isWindowsStyle(root) || isWindowsStyle(cwd) ? path.win32 : path.posix;
  // Only touch the filesystem when the paths are in this host's own format.
  const native = (flavor === path.win32) === (process.platform === 'win32');
  const inside = (rel: string): boolean =>
    rel !== '' && rel !== '.' && rel !== '..' &&
    !rel.startsWith('../') && !rel.startsWith('..\\') && !flavor.isAbsolute(rel);
  /** `abs` relative to the root: '' for the root itself, null when outside. */
  const fromRoot = (abs: string): string | null => {
    const rel = flavor.relative(root, abs);
    if (rel === '' || inside(rel)) return rel;
    if (!native) return null;
    const real = path.relative(canonicalPath(root), canonicalPath(abs));
    return real === '' || inside(real) ? real : null;
  };
  const clean = (rel: string | null): string | null =>
    rel === null || !inside(rel) ? null : rel.split(/[\\/]+/).filter(s => s && s !== '.').join('/');

  if (flavor.isAbsolute(filePath)) return clean(fromRoot(filePath));

  const fromCwd = flavor.resolve(cwd, filePath);
  if (native && !fs.existsSync(fromCwd)) {
    const underRoot = flavor.resolve(root, filePath);
    if (fs.existsSync(underRoot)) {
      const rel = clean(fromRoot(underRoot));
      if (rel !== null) return rel;
    }
  }
  const rel = fromRoot(fromCwd);
  if (rel !== null) return clean(rel);
  // Resolved outside the root. From a cwd inside the root that is a real
  // escape; from a cwd outside it, take the path as already repo-relative.
  if (fromRoot(cwd) !== null) return null;
  return clean(flavor.normalize(filePath));
}

/** `relativizeFilePath` over a list, null for each path outside the root. */
export function relativizeFilePaths(filePaths: string[], options: PathTokenOptions = {}): Array<string | null> {
  const cwd = options.cwd ?? process.cwd();
  const root = options.root ?? cwd;
  return filePaths.map(fp => relativizeFilePath(fp, root, cwd));
}

const rootCache = new Map<string, string>();

/**
 * The repo root for path relativizing: `git rev-parse --show-toplevel` run
 * from the directory that holds the `.ai/` dir, falling back to that
 * directory itself. Memoized per directory, so git is spawned at most once
 * per `.ai/` location in a process (including a long-running `charter serve`).
 */
export function resolvePathTokenRoot(aiDir: string, cwd: string = process.cwd()): string {
  const aiParent = path.dirname(path.resolve(cwd, aiDir));
  const cached = rootCache.get(aiParent);
  if (cached !== undefined) return cached;
  let root = aiParent;
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: aiParent,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    if (top) root = path.resolve(top);
  } catch {
    // Not a git checkout (or git is missing): the .ai/ dir's parent is the root.
  }
  rootCache.set(aiParent, root);
  return root;
}

/** Test hook: forget memoized repo roots. */
export function clearPathTokenRootCache(): void {
  rootCache.clear();
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

/** Path tokens from already repo-relative paths; null entries are skipped. */
export function tokensFromRelativePaths(relPaths: Array<string | null>): string[] {
  const tokens: string[] = [];
  for (const rel of relPaths) {
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
 * Derive routing tokens from the file paths' own segments, after making each
 * path relative to the repo root (see `relativizeFilePath`).
 * Returns deduplicated lowercase tokens with generic segments removed.
 */
export function filePathToTokens(filePaths: string[], options: PathTokenOptions = {}): string[] {
  return tokensFromRelativePaths(relativizeFilePaths(filePaths, options));
}

/**
 * Extract keywords from file paths using extension and directory signals.
 * Maps file system structure to domain keywords for module resolution.
 * Callers pass repo-relative paths (see `filePathRoutingKeywords`) so the
 * directories above the checkout never produce signals.
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
 * Every routing keyword `--files` contributes: extension and directory
 * signals plus path tokens, all taken from the repo-relative path. A path
 * outside the repo keeps only its extension signals (its file name alone).
 * Each path is relativized once.
 */
export function filePathRoutingKeywords(filePaths: string[], options: PathTokenOptions = {}): string[] {
  const relPaths = relativizeFilePaths(filePaths, options);
  const forSignals = relPaths.map((rel, i) => rel ?? (filePaths[i].split(/[\\/]+/).pop() ?? ''));
  return [...new Set([...filePathToKeywords(forSignals), ...tokensFromRelativePaths(relPaths)])];
}

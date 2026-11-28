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

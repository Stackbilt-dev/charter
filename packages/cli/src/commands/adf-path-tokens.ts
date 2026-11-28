/**
 * Path-token derivation for `charter adf context --files`.
 *
 * Splits a file path into its own name tokens
 * (`packages/adf/src/manifest.ts` -> `adf`, `manifest`) so the existing
 * trigger matcher can route modules from what the file is actually called,
 * not only from generic extension and directory signals.
 *
 * Over-triggering is the main risk, so generic scaffolding segments
 * (packages, src, lib, dist, index, test dirs, extensions, ...) are dropped.
 */

/**
 * Generic path segments that say nothing about the domain of a file.
 * Kept deliberately small: anything listed here can never route a module
 * from a path, so only add words that appear in most repos' layouts.
 */
export const GENERIC_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  // layout roots
  'packages', 'package', 'apps', 'src', 'lib', 'libs', 'dist', 'build', 'out',
  'bin', 'vendor', 'internal', 'pkg',
  // entry points
  'index', 'main', 'mod',
  // test scaffolding
  'test', 'tests', 'spec', 'specs', 'e2e', 'fixtures', 'fixture', 'mocks', 'mock',
  // extensions and declaration markers
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'd', 'json', 'md', 'mdx',
  'yml', 'yaml', 'toml', 'txt', 'map',
]);

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
 * Derive routing tokens from the file paths' own segments.
 * Returns deduplicated lowercase tokens with generic segments removed.
 */
export function filePathToTokens(filePaths: string[]): string[] {
  const tokens: string[] = [];
  for (const fp of filePaths) {
    for (const segment of fp.split(/[\\/]+/)) {
      if (segment === 'node_modules') continue;
      for (const token of splitSegment(segment)) {
        if (!GENERIC_PATH_SEGMENTS.has(token)) tokens.push(token);
      }
    }
  }
  return [...new Set(tokens)];
}

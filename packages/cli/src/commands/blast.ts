/**
 * charter blast <file> [<file> ...]
 *
 * Computes blast radius for the given seed files: which other files
 * transitively import them, up to a configurable depth.
 *
 * Pure heuristic — no LLM, no runtime type checking. Uses regex-based
 * import extraction (see @stackbilt/blast).
 */

import * as path from 'path';
import * as fs from 'fs';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { buildGraph, blastRadius } from '@stackbilt/blast';

// Flags that consume a value (so the next positional should not be treated as a seed file)
const VALUE_FLAGS = new Set(['--root', '--depth']);

export async function blastCommand(options: CLIOptions, args: string[]): Promise<number> {
  const seedArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) i++; // skip the flag's value
      continue;
    }
    seedArgs.push(a);
  }
  if (seedArgs.length === 0) {
    throw new CLIError(
      'Usage: charter blast <file> [<file> ...] [--root <dir>] [--depth <n>]\n' +
        'Example: charter blast src/kernel/dispatch.ts --depth 4'
    );
  }

  const root = path.resolve(getFlag(args, '--root') || '.');
  const depthStr = getFlag(args, '--depth');
  const maxDepth = depthStr ? parseInt(depthStr, 10) : 3;
  if (!Number.isFinite(maxDepth) || maxDepth < 1) {
    throw new CLIError(`Invalid --depth value: ${depthStr}. Must be a positive integer.`);
  }

  // Validate seeds exist
  const seeds: string[] = [];
  for (const seed of seedArgs) {
    const abs = path.resolve(seed);
    if (!fs.existsSync(abs)) {
      throw new CLIError(`Seed file not found: ${seed}`);
    }
    seeds.push(abs);
  }

  // Auto-detect path aliases from tsconfig.json if present (best-effort)
  const aliases = detectTsconfigAliases(root);

  const graph = buildGraph(root, { aliases });
  const result = blastRadius(graph, seeds, { maxDepth });

  if (options.format === 'json') {
    console.log(
      JSON.stringify(
        {
          root: path.relative(process.cwd(), root),
          fileCount: graph.fileCount,
          ...result,
        },
        null,
        2
      )
    );
    return EXIT_CODE.SUCCESS;
  }

  console.log('');
  console.log(`  Blast radius analysis`);
  console.log(`  root:       ${path.relative(process.cwd(), root) || '.'}`);
  console.log(`  scanned:    ${graph.fileCount} files`);
  console.log(`  seeds:      ${result.seeds.length}`);
  for (const seed of result.seeds) {
    console.log(`    - ${seed}`);
  }
  console.log(`  max depth:  ${maxDepth} (reached: ${result.maxDepth})`);
  console.log(`  affected:   ${result.summary.totalAffected} file(s)`);
  console.log('');

  if (result.affected.length > 0) {
    console.log('  Affected files:');
    const limit = 50;
    for (const file of result.affected.slice(0, limit)) {
      console.log(`    - ${file}`);
    }
    if (result.affected.length > limit) {
      console.log(`    ... (${result.affected.length - limit} more)`);
    }
    console.log('');
  }

  if (result.hotFiles.length > 0) {
    console.log('  Hot files (most imported):');
    for (const hot of result.hotFiles.slice(0, 10)) {
      console.log(`    ${String(hot.importers).padStart(4)}x  ${hot.file}`);
    }
    console.log('');
  }

  // Governance signal: high blast radius = cross-cutting
  if (result.summary.totalAffected >= 20) {
    console.log(
      `  [warn] Blast radius is large (${result.summary.totalAffected} files). ` +
        `Consider classifying this change as CROSS_CUTTING.`
    );
    console.log('');
  }

  return EXIT_CODE.SUCCESS;
}

// ============================================================================
// tsconfig path alias detection
// ============================================================================

function detectTsconfigAliases(root: string): Record<string, string> {
  const tsconfigPath = path.join(root, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return {};
  try {
    const raw = fs.readFileSync(tsconfigPath, 'utf8');
    // Strip JSON comments (tsconfig allows them)
    const cleaned = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const parsed = JSON.parse(cleaned) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const paths = parsed.compilerOptions?.paths;
    const baseUrl = parsed.compilerOptions?.baseUrl ?? '.';
    if (!paths) return {};
    const aliases: Record<string, string> = {};
    for (const [key, targets] of Object.entries(paths)) {
      if (!targets || targets.length === 0) continue;
      // Normalize "@/*" -> "@/", "src/*" -> "src/"
      const aliasKey = key.replace(/\*$/, '');
      const targetPath = targets[0].replace(/\*$/, '');
      aliases[aliasKey] = path.join(baseUrl, targetPath);
    }
    return aliases;
  } catch {
    return {};
  }
}

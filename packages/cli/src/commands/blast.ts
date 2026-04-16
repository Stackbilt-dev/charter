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
import { analyze, BlastInputSchema } from '@stackbilt/blast';
import { z } from 'zod';

// Flags that consume a value (so the next positional should not be treated as a seed file).
// Includes local flags (--root, --depth) and global CLI flags (--format, --config).
const VALUE_FLAGS = new Set(['--root', '--depth', '--format', '--config']);

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

  const rootArg = getFlag(args, '--root') || '.';
  const depthStr = getFlag(args, '--depth');
  const root = path.resolve(rootArg);
  const aliases = detectTsconfigAliases(root);

  // Route argv through the schema. BlastInputSchema owns the depth default
  // and the "positive integer" rule.
  let input;
  try {
    input = BlastInputSchema.parse({
      seeds: seedArgs,
      root: rootArg,
      maxDepth: depthStr !== undefined ? Number(depthStr) : undefined,
      aliases,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const msg = err.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new CLIError(`Invalid arguments: ${msg}`);
    }
    throw err;
  }

  // Pre-flight existence check — matches prior CLI error text.
  for (const seed of input.seeds) {
    if (!fs.existsSync(path.resolve(seed))) {
      throw new CLIError(`Seed file not found: ${seed}`);
    }
  }

  const result = analyze(input);

  if (options.format === 'json') {
    console.log(
      JSON.stringify(
        {
          root: path.relative(process.cwd(), result.root),
          fileCount: result.fileCount,
          seeds: result.seeds,
          affected: result.affected,
          maxDepth: result.maxDepth,
          hotFiles: result.hotFiles,
          summary: result.summary,
        },
        null,
        2
      )
    );
    return EXIT_CODE.SUCCESS;
  }

  console.log('');
  console.log(`  Blast radius analysis`);
  console.log(`  root:       ${path.relative(process.cwd(), result.root) || '.'}`);
  console.log(`  scanned:    ${result.fileCount} files`);
  console.log(`  seeds:      ${result.seeds.length}`);
  for (const seed of result.seeds) {
    console.log(`    - ${seed}`);
  }
  console.log(`  max depth:  ${input.maxDepth} (reached: ${result.maxDepth})`);
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

interface MinimalTsconfig {
  extends?: string | string[];
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

function readTsconfig(tsconfigPath: string): MinimalTsconfig | null {
  if (!fs.existsSync(tsconfigPath)) return null;
  try {
    const raw = fs.readFileSync(tsconfigPath, 'utf8');
    // Strip JSON comments (tsconfig allows them)
    const cleaned = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(cleaned) as MinimalTsconfig;
  } catch {
    return null;
  }
}

/**
 * Walk the tsconfig `extends` chain and merge compilerOptions.paths from
 * parents into the child. Shallower (closer to the child) wins on conflicts.
 */
function loadTsconfigChain(tsconfigPath: string, seen = new Set<string>()): MinimalTsconfig {
  const abs = path.resolve(tsconfigPath);
  if (seen.has(abs)) return {};
  seen.add(abs);

  const parsed = readTsconfig(abs);
  if (!parsed) return {};

  const merged: MinimalTsconfig = { compilerOptions: { baseUrl: '.', paths: {} } };

  // Resolve extends first, then overlay current file's options on top
  const extendsRaw = parsed.extends;
  const extendsList = Array.isArray(extendsRaw) ? extendsRaw : extendsRaw ? [extendsRaw] : [];
  for (const ext of extendsList) {
    let extPath = ext;
    if (!extPath.endsWith('.json')) extPath += '.json';
    if (!path.isAbsolute(extPath)) extPath = path.resolve(path.dirname(abs), extPath);
    const parent = loadTsconfigChain(extPath, seen);
    if (parent.compilerOptions?.paths) {
      Object.assign(merged.compilerOptions!.paths!, parent.compilerOptions.paths);
    }
    if (parent.compilerOptions?.baseUrl) {
      // baseUrl is relative to the tsconfig that declared it
      merged.compilerOptions!.baseUrl = path.resolve(
        path.dirname(extPath),
        parent.compilerOptions.baseUrl
      );
    }
  }

  if (parsed.compilerOptions?.paths) {
    Object.assign(merged.compilerOptions!.paths!, parsed.compilerOptions.paths);
  }
  if (parsed.compilerOptions?.baseUrl) {
    merged.compilerOptions!.baseUrl = path.resolve(
      path.dirname(abs),
      parsed.compilerOptions.baseUrl
    );
  }

  return merged;
}

export function detectTsconfigAliases(root: string): Record<string, string> {
  const tsconfigPath = path.join(root, 'tsconfig.json');
  const merged = loadTsconfigChain(tsconfigPath);
  const paths = merged.compilerOptions?.paths;
  const baseUrl = merged.compilerOptions?.baseUrl ?? root;
  if (!paths || Object.keys(paths).length === 0) return {};
  const aliases: Record<string, string> = {};
  for (const [key, targets] of Object.entries(paths)) {
    if (!targets || targets.length === 0) continue;
    // Normalize "@/*" -> "@/", "src/*" -> "src/"
    const aliasKey = key.replace(/\*$/, '');
    const targetPath = targets[0].replace(/\*$/, '');
    // baseUrl is already absolute after loadTsconfigChain; produce an absolute alias target
    const absoluteTarget = path.isAbsolute(targetPath)
      ? targetPath
      : path.resolve(baseUrl, targetPath);
    // Express target as relative to root so buildGraph's resolveSpecifier can join it
    aliases[aliasKey] = path.relative(root, absoluteTarget) || '.';
  }
  return aliases;
}

/**
 * charter adf compile
 *
 * Outbound compiler: renders the modular .ai/*.adf source tree to flat vendor
 * agent-config files (CLAUDE.md, AGENTS.md, .cursorrules, GEMINI.md).
 *
 * "Babel for agent configs" — ADF is the source of truth, vendor files are build
 * artifacts. This is the reverse of `charter adf migrate`.
 *
 * Usage:
 *   charter adf compile --target <claude|agents|cursor|gemini>
 *   charter adf compile --target all --write
 *   charter adf compile --target claude --check
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  compileAdf,
  COMPILE_TARGETS,
  TARGET_FILENAMES,
  COMPILE_BANNER_MARKER,
} from '@stackbilt/adf';
import type { CompileTarget } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';

// ============================================================================
// Zod validation — at the CLI boundary per Zod-core-out architecture
// ============================================================================

const CompileTargetOrAllSchema = z.enum(['claude', 'agents', 'cursor', 'gemini', 'all']);
type CompileTargetOrAll = z.infer<typeof CompileTargetOrAllSchema>;

// ============================================================================
// Entry point
// ============================================================================

export function adfCompileCommand(options: CLIOptions, args: string[]): number {
  const rawTarget = getFlag(args, '--target');
  if (!rawTarget) {
    throw new CLIError(
      'adf compile requires --target. Usage: charter adf compile --target <claude|agents|cursor|gemini|all>',
    );
  }

  // Zod boundary validation
  const targetParsed = CompileTargetOrAllSchema.safeParse(rawTarget);
  if (!targetParsed.success) {
    throw new CLIError(
      `Invalid --target: "${rawTarget}". Must be one of: claude, agents, cursor, gemini, all`,
    );
  }
  const targetOrAll: CompileTargetOrAll = targetParsed.data;

  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const displayAiDir = path.relative(process.cwd(), path.resolve(aiDir)) || aiDir;
  const writeMode = args.includes('--write');
  const checkMode = args.includes('--check');
  const forceWrite = args.includes('--force');

  if (writeMode && checkMode) {
    throw new CLIError('--write and --check are mutually exclusive.');
  }

  const manifestPath = path.join(aiDir, 'manifest.adf');
  if (!fs.existsSync(manifestPath)) {
    throw new CLIError(
      `manifest.adf not found at ${manifestPath}. Run: charter adf init`,
    );
  }

  // Resolve the list of targets to compile
  const targets: CompileTarget[] = targetOrAll === 'all'
    ? [...COMPILE_TARGETS]
    : [targetOrAll as CompileTarget];

  // File reader (real FS)
  const readFile = (p: string): string => fs.readFileSync(p, 'utf-8');

  if (checkMode) {
    return runCheckMode(options, targets, aiDir, displayAiDir, readFile);
  }

  if (writeMode) {
    return runWriteMode(options, targets, aiDir, displayAiDir, readFile, forceWrite);
  }

  // Default: stdout (single target only in non-write/check mode)
  if (targets.length > 1) {
    throw new CLIError(
      '--target all requires --write or --check. Use a single target to print to stdout.',
    );
  }
  return runStdoutMode(options, targets[0], aiDir, displayAiDir, readFile);
}

// ============================================================================
// Modes
// ============================================================================

function runStdoutMode(
  options: CLIOptions,
  target: CompileTarget,
  aiDir: string,
  displayAiDir: string,
  readFile: (p: string) => string,
): number {
  const result = compileAdf({ target, aiDir, displayAiDir, readFile });

  if (options.format === 'json') {
    console.log(JSON.stringify({
      target,
      defaultModules: result.defaultModules,
      onDemandModules: result.onDemandModules.map(m => ({
        path: m.path,
        triggers: m.triggers,
      })),
      output: result.output,
      nextActions: [
        `charter adf compile --target ${target} --write`,
        `charter adf compile --target all --write`,
        `charter adf compile --target ${target} --check`,
      ],
    }, null, 2));
  } else {
    process.stdout.write(result.output);
  }

  return EXIT_CODE.SUCCESS;
}

function runWriteMode(
  options: CLIOptions,
  targets: CompileTarget[],
  aiDir: string,
  displayAiDir: string,
  readFile: (p: string) => string,
  force: boolean,
): number {
  const written: string[] = [];
  const refused: string[] = [];

  for (const target of targets) {
    const filename = TARGET_FILENAMES[target];

    // Overwrite protection: refuse to clobber a hand-written file
    if (fs.existsSync(filename) && !force) {
      const existing = fs.readFileSync(filename, 'utf-8');
      if (!existing.includes(COMPILE_BANNER_MARKER)) {
        refused.push(filename);
        if (options.format !== 'json') {
          console.error(
            `  [warn] Refused to overwrite ${filename} — no compile banner found (hand-written or pointer stub).\n` +
            `         Pass --force to overwrite. This protects hand-authored CLAUDE.md files.\n` +
            `         If migrating from thin pointers, run --force once to convert.`,
          );
        }
        continue;
      }
    }

    const result = compileAdf({ target, aiDir, displayAiDir, readFile });
    fs.writeFileSync(filename, result.output, 'utf-8');
    written.push(filename);

    if (options.format !== 'json') {
      console.log(`  [ok] Written ${filename}`);
    }
  }

  if (options.format === 'json') {
    console.log(JSON.stringify({
      written,
      refused,
      nextActions: refused.length > 0
        ? ['charter adf compile --target all --write --force  # to overwrite protected files']
        : ['charter adf compile --target all --check  # to verify files are up-to-date'],
    }, null, 2));
  }

  // If any targets were refused and we wrote nothing, that's a policy error
  if (refused.length > 0 && written.length === 0) {
    return EXIT_CODE.POLICY_VIOLATION;
  }
  // Partial writes (some refused): report as policy violation so CI can catch it
  if (refused.length > 0) {
    return EXIT_CODE.POLICY_VIOLATION;
  }

  return EXIT_CODE.SUCCESS;
}

function runCheckMode(
  options: CLIOptions,
  targets: CompileTarget[],
  aiDir: string,
  displayAiDir: string,
  readFile: (p: string) => string,
): number {
  const stale: string[] = [];
  const current: string[] = [];
  const missing: string[] = [];

  for (const target of targets) {
    const filename = TARGET_FILENAMES[target];

    if (!fs.existsSync(filename)) {
      missing.push(filename);
      if (options.format !== 'json') {
        console.log(`  [missing] ${filename} — not found on disk`);
      }
      continue;
    }

    const onDisk = fs.readFileSync(filename, 'utf-8');
    const result = compileAdf({ target, aiDir, displayAiDir, readFile });

    if (onDisk === result.output) {
      current.push(filename);
      if (options.format !== 'json') {
        console.log(`  [ok] ${filename} is up-to-date`);
      }
    } else {
      stale.push(filename);
      if (options.format !== 'json') {
        console.log(
          `  [stale] ${filename} — out of date with .ai/ source.\n` +
          `          Run: charter adf compile --target ${target} --write`,
        );
      }
    }
  }

  if (options.format === 'json') {
    const isStale = stale.length > 0 || missing.length > 0;
    console.log(JSON.stringify({
      stale,
      current,
      missing,
      upToDate: !isStale,
      nextActions: isStale
        ? ['charter adf compile --target all --write']
        : [],
    }, null, 2));
  }

  // Exit 1 if any file is stale or missing (CI drift gate)
  return (stale.length > 0 || missing.length > 0)
    ? EXIT_CODE.POLICY_VIOLATION
    : EXIT_CODE.SUCCESS;
}

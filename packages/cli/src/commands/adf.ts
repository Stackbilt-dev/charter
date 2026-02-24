/**
 * charter adf
 *
 * ADF (Attention-Directed Format) subcommands: init, fmt, patch, bundle.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseAdf,
  formatAdf,
  applyPatches,
  parseManifest,
  resolveModules,
  bundleModules,
} from '@stackbilt/adf';
import type { PatchOperation } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';

// ============================================================================
// Scaffold Content
// ============================================================================

const MANIFEST_SCAFFOLD = `ADF: 0.1
\u{1F3AF} ROLE: Repo context router

\u{1F4E6} DEFAULT_LOAD:
  - core.adf
  - state.adf

\u{1F4C2} ON_DEMAND:
  - frontend.adf (Triggers on: React, CSS, UI)
  - backend.adf (Triggers on: API, Node, DB)

\u{1F4D0} RULES:
  - Prefer smallest relevant module set.
  - Never assume unseen modules were loaded.
`;

const CORE_SCAFFOLD = `ADF: 0.1
\u{1F3AF} TASK: Define universal repository rules

\u{2699}\u{FE0F} CONTEXT:
  - This file is loaded by default for every task.
  - Keep it lean — add domain-specific rules to on-demand modules.

\u{26A0}\u{FE0F} CONSTRAINTS:
  - Follow conventional commits.
  - No secrets in source code.
  - Prefer pure functions in library code.
`;

const STATE_SCAFFOLD = `ADF: 0.1
\u{1F9E0} STATE:
  CURRENT: Repository initialized with ADF context system
  NEXT: Configure on-demand modules for your stack
`;

// ============================================================================
// Dispatcher
// ============================================================================

export async function adfCommand(options: CLIOptions, args: string[]): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return EXIT_CODE.SUCCESS;
  }

  const subcommand = args[0];
  const restArgs = args.slice(1);

  switch (subcommand) {
    case 'init':
      return adfInit(options, restArgs);
    case 'fmt':
      return adfFmt(options, restArgs);
    case 'patch':
      return adfPatch(options, restArgs);
    case 'bundle':
      return adfBundle(options, restArgs);
    default:
      throw new CLIError(`Unknown adf subcommand: ${subcommand}. Supported: init, fmt, patch, bundle`);
  }
}

// ============================================================================
// adf init
// ============================================================================

interface AdfInitResult {
  created: boolean;
  aiDir: string;
  files: string[];
}

function adfInit(options: CLIOptions, args: string[]): number {
  const force = options.yes || args.includes('--force');
  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const manifestPath = path.join(aiDir, 'manifest.adf');

  if (fs.existsSync(manifestPath) && !force) {
    const result: AdfInitResult = { created: false, aiDir, files: [] };
    if (options.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`  .ai/ already exists at ${aiDir}/`);
      console.log('  Use --force (or --yes) to overwrite.');
    }
    return EXIT_CODE.SUCCESS;
  }

  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'manifest.adf'), MANIFEST_SCAFFOLD);
  fs.writeFileSync(path.join(aiDir, 'core.adf'), CORE_SCAFFOLD);
  fs.writeFileSync(path.join(aiDir, 'state.adf'), STATE_SCAFFOLD);

  const result: AdfInitResult = {
    created: true,
    aiDir,
    files: ['manifest.adf', 'core.adf', 'state.adf'],
  };

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`  Initialized ADF context at ${aiDir}/`);
    console.log('');
    console.log('  Created:');
    for (const file of result.files) {
      console.log(`    ${file}`);
    }
    console.log('');
    console.log('  Next steps:');
    console.log('    1. Edit core.adf with your universal repo rules');
    console.log('    2. Add on-demand modules (e.g. frontend.adf, backend.adf)');
    console.log('    3. Run: charter adf fmt .ai/core.adf --check');
  }

  return EXIT_CODE.SUCCESS;
}

// ============================================================================
// adf fmt
// ============================================================================

function adfFmt(options: CLIOptions, args: string[]): number {
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) {
    throw new CLIError('adf fmt requires a file path. Usage: charter adf fmt <file> [--check] [--write]');
  }

  if (!fs.existsSync(filePath)) {
    throw new CLIError(`File not found: ${filePath}`);
  }

  const input = fs.readFileSync(filePath, 'utf-8');
  const doc = parseAdf(input);
  const formatted = formatAdf(doc);

  const checkMode = args.includes('--check');
  const writeMode = args.includes('--write');

  if (checkMode) {
    const isCanonical = input === formatted;
    if (options.format === 'json') {
      console.log(JSON.stringify({ file: filePath, canonical: isCanonical }, null, 2));
    } else if (isCanonical) {
      console.log(`  [ok] ${filePath} is canonical.`);
    } else {
      console.log(`  [warn] ${filePath} is not in canonical format.`);
      console.log('  Run: charter adf fmt <file> --write');
    }
    return isCanonical ? EXIT_CODE.SUCCESS : EXIT_CODE.POLICY_VIOLATION;
  }

  if (writeMode) {
    fs.writeFileSync(filePath, formatted);
    if (options.format === 'json') {
      console.log(JSON.stringify({ file: filePath, written: true }, null, 2));
    } else {
      console.log(`  [ok] Reformatted ${filePath}`);
    }
    return EXIT_CODE.SUCCESS;
  }

  // Default: print to stdout
  process.stdout.write(formatted);
  return EXIT_CODE.SUCCESS;
}

// ============================================================================
// adf patch
// ============================================================================

function adfPatch(options: CLIOptions, args: string[]): number {
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) {
    throw new CLIError('adf patch requires a file path. Usage: charter adf patch <file> --ops <json>');
  }

  const opsJson = getFlag(args, '--ops');
  if (!opsJson) {
    throw new CLIError('adf patch requires --ops <json>.');
  }

  if (!fs.existsSync(filePath)) {
    throw new CLIError(`File not found: ${filePath}`);
  }

  let ops: PatchOperation[];
  try {
    ops = JSON.parse(opsJson);
    if (!Array.isArray(ops)) {
      throw new Error('ops must be an array');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new CLIError(`Invalid --ops JSON: ${msg}`);
  }

  const input = fs.readFileSync(filePath, 'utf-8');
  const doc = parseAdf(input);

  try {
    const patched = applyPatches(doc, ops);
    const output = formatAdf(patched);
    fs.writeFileSync(filePath, output);

    if (options.format === 'json') {
      console.log(JSON.stringify({ file: filePath, patched: true, opsApplied: ops.length }, null, 2));
    } else {
      console.log(`  [ok] Applied ${ops.length} patch${ops.length === 1 ? '' : 'es'} to ${filePath}`);
    }
    return EXIT_CODE.SUCCESS;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AdfPatchError') {
      if (options.format === 'json') {
        console.log(JSON.stringify({ file: filePath, patched: false, error: e.message }, null, 2));
      } else {
        console.error(`  [error] ${e.message}`);
      }
      return EXIT_CODE.RUNTIME_ERROR;
    }
    throw e;
  }
}

// ============================================================================
// adf bundle
// ============================================================================

function adfBundle(options: CLIOptions, args: string[]): number {
  const task = getFlag(args, '--task');
  if (!task) {
    throw new CLIError('adf bundle requires --task "<prompt>". Usage: charter adf bundle --task "Fix React component"');
  }

  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const manifestPath = path.join(aiDir, 'manifest.adf');

  if (!fs.existsSync(manifestPath)) {
    throw new CLIError(`manifest.adf not found at ${manifestPath}. Run: charter adf init`);
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  const manifestDoc = parseAdf(manifestContent);
  const manifest = parseManifest(manifestDoc);

  // Tokenize task into keywords (simple word split)
  const keywords = task
    .split(/[\s,;:()[\]{}]+/)
    .filter(w => w.length > 1)
    .map(w => w.replace(/[^a-zA-Z0-9]/g, ''));

  const modulePaths = resolveModules(manifest, keywords);

  const readFile = (p: string): string => fs.readFileSync(p, 'utf-8');

  try {
    const result = bundleModules(aiDir, modulePaths, readFile);

    if (options.format === 'json') {
      console.log(JSON.stringify({
        task,
        keywords,
        resolvedModules: result.resolvedModules,
        tokenEstimate: result.tokenEstimate,
        triggerMatches: result.triggerMatches,
      }, null, 2));
    } else {
      console.log(`  Task: "${task}"`);
      console.log(`  Keywords: ${keywords.join(', ')}`);
      console.log(`  Resolved modules: ${result.resolvedModules.join(', ')}`);
      console.log(`  Token estimate: ~${result.tokenEstimate}`);
      console.log('');

      if (result.triggerMatches.length > 0) {
        console.log('  Trigger report:');
        for (const tm of result.triggerMatches) {
          const icon = tm.matched ? '+' : '-';
          console.log(`    [${icon}] ${tm.module} (${tm.trigger})`);
        }
        console.log('');
      }

      // Output merged document
      const output = formatAdf(result.mergedDocument);
      console.log('  --- Merged Context ---');
      console.log(output);
    }
    return EXIT_CODE.SUCCESS;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AdfBundleError') {
      if (options.format === 'json') {
        console.log(JSON.stringify({ error: e.message }, null, 2));
      } else {
        console.error(`  [error] ${e.message}`);
      }
      return EXIT_CODE.RUNTIME_ERROR;
    }
    throw e;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function printHelp(): void {
  console.log('');
  console.log('  charter adf — Attention-Directed Format tools');
  console.log('');
  console.log('  Usage:');
  console.log('    charter adf init [--ai-dir <dir>] [--force]');
  console.log('      Scaffold .ai/ directory with manifest, core, and state modules.');
  console.log('');
  console.log('    charter adf fmt <file> [--check] [--write]');
  console.log('      Parse and reformat an ADF file to canonical form.');
  console.log('      --check: exit 1 if not canonical (no write)');
  console.log('      --write: reformat file in place');
  console.log('      Default: print formatted output to stdout.');
  console.log('');
  console.log('    charter adf patch <file> --ops <json>');
  console.log('      Apply ADF_PATCH operations to a file.');
  console.log('');
  console.log('    charter adf bundle --task "<prompt>" [--ai-dir <dir>]');
  console.log('      Resolve manifest modules for a task and output merged context.');
  console.log('');
}

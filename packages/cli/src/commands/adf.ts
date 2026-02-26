/**
 * charter adf
 *
 * ADF (Attention-Directed Format) subcommands: init, fmt, patch, bundle, sync, evidence, migrate.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseAdf,
  formatAdf,
  applyPatches,
} from '@stackbilt/adf';
import type { PatchOperation } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { adfMigrateCommand } from './adf-migrate';
import { adfBundle } from './adf-bundle';
import { adfSync } from './adf-sync';
import { adfEvidence } from './adf-evidence';

// ============================================================================
// Scaffold Content
// ============================================================================

export const MANIFEST_SCAFFOLD = `ADF: 0.1
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

export const CORE_SCAFFOLD = `ADF: 0.1

\u{1F4D6} GUIDE [advisory]:
  - Pure runtime/environment? (OS, line endings) \u2192 CLAUDE.md, not ADF
  - Universal architecture constraint? \u2192 core.adf CONSTRAINTS [load-bearing]
  - Stack-specific operational rule? \u2192 domain .adf module (backend.adf, frontend.adf)
  - Agent identity/behavior? \u2192 core.adf CONTEXT
  - Language/tooling discipline? \u2192 core.adf CONSTRAINTS or dedicated section
  - [load-bearing] = violation causes incorrect output
  - [advisory] = best practice, not enforced
  - Section types are open: CONTEXT, CONSTRAINTS, ADVISORY, METRICS, custom

\u26A0\uFE0F CONSTRAINTS [load-bearing]:
  - Use Conventional Commits (feat, fix, docs, chore)
  - Never commit secrets or credentials
  - Pure functions in library code; side effects only in entry points

\uD83D\uDCCA METRICS:
  entry_loc: 0 / 500 [lines]
`;

export const STATE_SCAFFOLD = `ADF: 0.1
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
    case 'sync':
      return adfSync(options, restArgs);
    case 'evidence':
      return adfEvidence(options, restArgs);
    case 'migrate':
      return adfMigrateCommand(options, restArgs);
    default:
      throw new CLIError(`Unknown adf subcommand: ${subcommand}. Supported: init, fmt, patch, bundle, sync, evidence, migrate`);
  }
}

// ============================================================================
// adf init
// ============================================================================

interface AdfInitResult {
  created: boolean;
  aiDir: string;
  files: string[];
  pointers?: string[];
}

// -- Thin pointer file content --

export const POINTER_CLAUDE_MD = `# Project Context

> This project uses [ADF](https://github.com/Stackbilt-dev/charter) for AI agent context management.
> All stack rules, constraints, and architectural guidance live in \`.ai/\`.
> **Do not duplicate ADF rules here.** Only pre-ADF bootstrap content belongs in this file.

See \`.ai/manifest.adf\` for the module routing manifest.

## Environment
<!-- Add runtime/OS/shell-specific notes here (not stack rules) -->
`;

export const POINTER_CURSORRULES = `# Cursor Rules

This project uses ADF (Attention-Directed Format) for context management.
All rules and constraints are in .ai/ \u2014 see .ai/manifest.adf for routing.

Do not add stack rules here. This file exists only as a pointer.
See: .ai/core.adf for universal constraints.
`;

export const POINTER_AGENTS_MD = `# Agent Guidelines

This project uses ADF for structured agent context.
All architectural rules, constraints, and guidance live in \`.ai/\`.

Module manifest: .ai/manifest.adf
Universal rules: .ai/core.adf
Current state: .ai/state.adf

Do not duplicate rules from .ai/ modules into this file or other agent config files.
`;

function adfInit(options: CLIOptions, args: string[]): number {
  const force = options.yes || args.includes('--force');
  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const manifestPath = path.join(aiDir, 'manifest.adf');

  if (fs.existsSync(manifestPath) && !force) {
    const result: AdfInitResult = { created: false, aiDir, files: [] };
    if (options.format === 'json') {
      console.log(JSON.stringify({ ...result, nextActions: ['charter adf fmt .ai/core.adf --check', 'charter adf bundle --task "<prompt>"'] }, null, 2));
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

  // --emit-pointers: generate thin pointer files that redirect to .ai/
  const emitPointers = args.includes('--emit-pointers') || args.includes('--pointers');
  if (emitPointers) {
    const pointerSpecs: Array<{ file: string; content: string; label: string }> = [
      { file: 'CLAUDE.md', content: POINTER_CLAUDE_MD, label: 'CLAUDE.md (thin pointer)' },
      { file: '.cursorrules', content: POINTER_CURSORRULES, label: '.cursorrules (thin pointer)' },
      { file: 'agents.md', content: POINTER_AGENTS_MD, label: 'agents.md (thin pointer)' },
    ];
    const createdPointers: string[] = [];
    const skippedPointers: string[] = [];

    for (const spec of pointerSpecs) {
      if (fs.existsSync(spec.file)) {
        skippedPointers.push(spec.file);
      } else {
        fs.writeFileSync(spec.file, spec.content);
        createdPointers.push(spec.file);
        result.files.push(spec.file);
      }
    }
    result.pointers = createdPointers;

    if (options.format !== 'json') {
      for (const p of createdPointers) {
        const label = pointerSpecs.find(s => s.file === p)?.label ?? p;
        console.log(`  Generated ${label}`);
      }
      for (const p of skippedPointers) {
        console.log(`  Skipped ${p} (already exists)`);
      }
    }
  }

  if (options.format === 'json') {
    console.log(JSON.stringify({
      ...result,
      nextActions: [
        'Edit core.adf with your universal repo rules',
        'charter adf fmt .ai/core.adf --check',
        'charter adf bundle --task "<prompt>"',
      ],
    }, null, 2));
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
  const opsFile = getFlag(args, '--ops-file');
  if (!opsJson && !opsFile) {
    throw new CLIError('adf patch requires --ops <json> or --ops-file <path>.');
  }

  if (!fs.existsSync(filePath)) {
    throw new CLIError(`File not found: ${filePath}`);
  }

  const rawOps = opsFile ? readJsonFlag(opsFile, '--ops-file') : opsJson!;

  let ops: PatchOperation[];
  try {
    ops = JSON.parse(rawOps);
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
// Helpers
// ============================================================================

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function readJsonFlag(filePath: string, flagName: string): string {
  if (!fs.existsSync(filePath)) {
    throw new CLIError(`File not found for ${flagName}: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

function printHelp(): void {
  console.log('');
  console.log('  charter adf — Attention-Directed Format tools');
  console.log('');
  console.log('  Usage:');
  console.log('    charter adf init [--ai-dir <dir>] [--force] [--emit-pointers]');
  console.log('      Scaffold .ai/ directory with manifest, core, and state modules.');
  console.log('      --emit-pointers: also generate thin pointer files (CLAUDE.md, .cursorrules, agents.md)');
  console.log('');
  console.log('    charter adf fmt <file> [--check] [--write]');
  console.log('      Parse and reformat an ADF file to canonical form.');
  console.log('      --check: exit 1 if not canonical (no write)');
  console.log('      --write: reformat file in place');
  console.log('      Default: print formatted output to stdout.');
  console.log('');
  console.log('    charter adf patch <file> --ops <json> | --ops-file <path>');
  console.log('      Apply ADF_PATCH operations to a file.');
  console.log('');
  console.log('    charter adf bundle --task "<prompt>" [--ai-dir <dir>]');
  console.log('      Resolve manifest modules for a task and output merged context.');
  console.log('');
  console.log('    charter adf sync --check [--ai-dir <dir>]');
  console.log('      Verify source .adf files match their locked hashes.');
  console.log('      Exit 1 if any source has changed since last sync.');
  console.log('');
  console.log('    charter adf sync --write [--ai-dir <dir>]');
  console.log('      Update .adf.lock with current source hashes.');
  console.log('');
  console.log('    charter adf sync --explain');
  console.log('      Show .adf.lock schema documentation.');
  console.log('');
  console.log('    charter adf evidence [--task "<prompt>"] [--ai-dir <dir>] [--auto-measure]');
  console.log('                        [--context \'{"key": value}\']');
  console.log('      Validate metric constraints and produce a structured evidence report.');
  console.log('      --task: resolve on-demand modules for task. Omit for defaultLoad only.');
  console.log('      --auto-measure: count lines in files from manifest METRICS section.');
  console.log('      --context: JSON object of external metric overrides (wins over auto).');
  console.log('      --context-file: read --context JSON from a file instead.');
  console.log('      In --ci mode, exit 1 if any constraint fails.');
  console.log('');
  console.log('    charter adf migrate [--dry-run] [--source <file>] [--no-backup]');
  console.log('                        [--merge-strategy append|dedupe|replace] [--ai-dir <dir>]');
  console.log('      Ingest existing agent config files (CLAUDE.md, .cursorrules, etc.) and');
  console.log('      migrate their content into structured ADF modules. Replaces originals');
  console.log('      with thin pointers that retain environment-specific rules.');
  console.log('      --dry-run: preview migration plan without writing files');
  console.log('      --source: migrate a single file instead of scanning all agent configs');
  console.log('      --no-backup: skip creating .pre-adf-migrate.bak backups');
  console.log('      --merge-strategy: append (always add), dedupe (skip duplicates, default), replace');
  console.log('');
}

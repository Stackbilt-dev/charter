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
  CANONICAL_KEY_ORDER,
} from '@stackbilt/adf';
import type { PatchOperation } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag, readFlagFile } from '../flags';
import { adfMigrateCommand } from './adf-migrate';
import { adfBundle } from './adf-bundle';
import { adfSync } from './adf-sync';
import { adfEvidence } from './adf-evidence';
import { adfMetricsCommand } from './adf-metrics';
import { adfTidyCommand } from './adf-tidy';
import { adfPopulateCommand } from './adf-populate';
import { adfContextCommand } from './adf-context';

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

\u{1F4CB} CONTEXT:
  - Project context (run 'charter adf populate' to auto-fill from codebase)

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

export const FRONTEND_SCAFFOLD = `ADF: 0.1
\u{1F4CB} CONTEXT:
  - Frontend module scaffold
  - Add framework-specific constraints and operational rules
`;

export const BACKEND_SCAFFOLD = `ADF: 0.1
\u{1F4CB} CONTEXT:
  - Backend module scaffold
  - Add service/API/database constraints and operational rules
`;

export const DECISIONS_SCAFFOLD = `ADF: 0.1
\u{1F4CB} CONTEXT:
  - Decisions module scaffold
  - Record architectural decision rationale and outcomes
`;

export const PLANNING_SCAFFOLD = `ADF: 0.1
\u{1F4CB} CONTEXT:
  - Planning module scaffold
  - Track project phases, milestones, and sequencing
`;


export const CONTENT_SCAFFOLD = `ADF: 0.1
\u{1F4CB} CONTEXT:
  - Content module scaffold
  - Add Markdown/MDX authoring conventions, frontmatter schema, and doc linting rules

\u26A0\uFE0F CONSTRAINTS [load-bearing]:
  - All pages must include required frontmatter fields (title, description)
  - Use MDX for pages that require interactive components

\u{1F4CB} ADVISORY:
  - Prefer flat URL structures; avoid deep nesting beyond 3 levels
  - Include alt text on all images
`;

export const MANIFEST_FRONTEND_SCAFFOLD = `ADF: 0.1
\u{1F3AF} ROLE: Repo context router

\u{1F4E6} DEFAULT_LOAD:
  - core.adf
  - state.adf

\u{1F4C2} ON_DEMAND:
  - frontend.adf (Triggers on: React, CSS, UI)

\u{1F4D0} RULES:
  - Prefer smallest relevant module set.
  - Never assume unseen modules were loaded.
`;

export const MANIFEST_BACKEND_SCAFFOLD = `ADF: 0.1
\u{1F3AF} ROLE: Repo context router

\u{1F4E6} DEFAULT_LOAD:
  - core.adf
  - state.adf

\u{1F4C2} ON_DEMAND:
  - backend.adf (Triggers on: API, Node, DB)

\u{1F4D0} RULES:
  - Prefer smallest relevant module set.
  - Never assume unseen modules were loaded.
`;

export const MANIFEST_DOCS_SCAFFOLD = `ADF: 0.1
\u{1F3AF} ROLE: Documentation workspace context router

\u{1F4E6} DEFAULT_LOAD:
  - core.adf
  - state.adf

\u{1F4C2} ON_DEMAND:
  - content.adf (Triggers on: Markdown, MDX, frontmatter, content, Astro, navigation, docs, authoring)
  - decisions.adf (Triggers on: ADR, decision, rationale, architecture)
  - planning.adf (Triggers on: plan, milestone, phase, roadmap)

\u{1F4D0} RULES:
  - Prefer smallest relevant module set.
  - Never assume unseen modules were loaded.
`;

/** Return the correct manifest scaffold for a given preset. */
export function manifestForPreset(preset?: string): string {
  switch (preset) {
    case 'docs':
      return MANIFEST_DOCS_SCAFFOLD;
    case 'frontend':
      return MANIFEST_FRONTEND_SCAFFOLD;
    case 'backend':
    case 'worker':
      return MANIFEST_BACKEND_SCAFFOLD;
    default:
      return MANIFEST_SCAFFOLD;
  }
}

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
    case 'create':
      return adfCreate(options, restArgs);
    case 'bundle':
      return adfBundle(options, restArgs);
    case 'sync':
      return adfSync(options, restArgs);
    case 'evidence':
      return adfEvidence(options, restArgs);
    case 'migrate':
      return adfMigrateCommand(options, restArgs);
    case 'tidy':
      return adfTidyCommand(options, restArgs);
    case 'metrics':
      return adfMetricsCommand(options, restArgs);
    case 'populate':
      return adfPopulateCommand(options, restArgs);
    case 'context':
      return adfContextCommand(options, restArgs);
    default:
      throw new CLIError(`Unknown adf subcommand: ${subcommand}. Supported: init, fmt, patch, create, populate, bundle, sync, evidence, migrate, tidy, metrics, context`);
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

// -- Thin pointer detection markers --

/** Strings that identify an agent config file as a thin pointer to .ai/. */
export const POINTER_MARKERS = [
  'Do not duplicate ADF rules here',
  'Do not duplicate rules from .ai/',
  'Do not add stack rules here',
  'DO NOT add rules, constraints, or context to this file',
  'DO NOT modify this file. All project rules are managed in .ai/',
  'DO NOT add instructions to this file',
  'DO NOT add rules or context to this file',
];

// -- Module index sentinels --

export const MODULE_INDEX_START = '<!-- charter:module-index:start -->';
export const MODULE_INDEX_END = '<!-- charter:module-index:end -->';

// -- Thin pointer file content --

export const POINTER_CLAUDE_MD = `# CLAUDE.md

> **DO NOT add rules, constraints, or context to this file.**
> This file is auto-managed by Charter. All project rules live in \`.ai/\`.
> New rules should be added to the appropriate \`.ai/*.adf\` module.
> See \`.ai/manifest.adf\` for the module routing manifest.

## Environment
<!-- Add runtime/OS/shell-specific notes here (not stack rules) -->
`;

export const POINTER_CLAUDE_MD_HYBRID = `# CLAUDE.md

> **DO NOT add rules, constraints, or context to this file.**
> This file is auto-managed by Charter. All project rules live in \`.ai/\`.
> New rules should be added to the appropriate \`.ai/*.adf\` module.
> See \`.ai/manifest.adf\` for the module routing manifest.

## Module Index
<!-- charter:module-index:start -->
<!-- charter:module-index:end -->

## Environment
<!-- Add runtime/OS/shell-specific notes here (not stack rules) -->
`;

export const POINTER_CURSORRULES = `DO NOT modify this file. All project rules are managed in .ai/ by Charter.
See .ai/manifest.adf for the module routing manifest.
`;

export const POINTER_AGENTS_MD = `# agents.md

> **DO NOT add instructions to this file.**
> All agent instructions are managed in \`.ai/\` by Charter.
> See \`.ai/manifest.adf\` for the module routing manifest.
`;

export const POINTER_GEMINI_MD = `# GEMINI.md

> **DO NOT add rules or context to this file.**
> All project rules are managed in \`.ai/\` by Charter.
> See \`.ai/manifest.adf\` for the module routing manifest.
`;

export const POINTER_COPILOT_MD = `DO NOT modify this file. All project rules are managed in .ai/ by Charter.
See .ai/manifest.adf for the module routing manifest.
`;

function adfInit(options: CLIOptions, args: string[]): number {
  const force = options.yes || args.includes('--force');
  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const moduleFlag = getFlag(args, '--module');
  const presetFlag = getFlag(args, '--preset');
  const manifestPath = path.join(aiDir, 'manifest.adf');

  // --module: additive single-module creation — delegate to adf create
  if (moduleFlag) {
    if (!fs.existsSync(manifestPath)) {
      throw new CLIError(
        `manifest.adf not found at ${manifestPath}. Run 'charter adf init' first to scaffold .ai/.`
      );
    }
    return adfCreate(options, [moduleFlag, '--ai-dir', aiDir]);
  }

  if (fs.existsSync(manifestPath) && !force) {
    const result: AdfInitResult = { created: false, aiDir, files: [] };
    if (options.format === 'json') {
      console.log(JSON.stringify({ ...result, nextActions: ['charter adf fmt .ai/core.adf --check', 'charter adf bundle --task "<prompt>"'] }, null, 2));
    } else {
      console.log('');
      console.log('  .ai/ directory already exists. Run \'charter doctor\' to check for issues.');
      console.log('');
      console.log('  Use --force (or --yes) to overwrite.');
      console.log('  To add a single module: charter adf init --module <name>');
    }
    return EXIT_CODE.SUCCESS;
  }

  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'manifest.adf'), manifestForPreset(presetFlag));
  fs.writeFileSync(path.join(aiDir, 'core.adf'), CORE_SCAFFOLD);
  fs.writeFileSync(path.join(aiDir, 'state.adf'), STATE_SCAFFOLD);

  const moduleFiles: string[] = [];
  if (presetFlag === 'docs') {
    fs.writeFileSync(path.join(aiDir, 'content.adf'), CONTENT_SCAFFOLD);
    fs.writeFileSync(path.join(aiDir, 'decisions.adf'), DECISIONS_SCAFFOLD);
    fs.writeFileSync(path.join(aiDir, 'planning.adf'), PLANNING_SCAFFOLD);
    moduleFiles.push('content.adf', 'decisions.adf', 'planning.adf');
  } else if (presetFlag === 'frontend') {
    fs.writeFileSync(path.join(aiDir, 'frontend.adf'), FRONTEND_SCAFFOLD);
    moduleFiles.push('frontend.adf');
  } else if (presetFlag === 'backend' || presetFlag === 'worker') {
    fs.writeFileSync(path.join(aiDir, 'backend.adf'), BACKEND_SCAFFOLD);
    moduleFiles.push('backend.adf');
  } else {
    fs.writeFileSync(path.join(aiDir, 'frontend.adf'), FRONTEND_SCAFFOLD);
    fs.writeFileSync(path.join(aiDir, 'backend.adf'), BACKEND_SCAFFOLD);
    moduleFiles.push('frontend.adf', 'backend.adf');
  }
  fs.writeFileSync(path.join(aiDir, '.adf.lock'), '{}\n');

  const result: AdfInitResult = {
    created: true,
    aiDir,
    files: ['manifest.adf', 'core.adf', 'state.adf', ...moduleFiles, '.adf.lock'],
  };

  // --emit-pointers: generate thin pointer files that redirect to .ai/
  const emitPointers = args.includes('--emit-pointers') || args.includes('--pointers');
  if (emitPointers) {
    const pointerSpecs: Array<{ file: string; content: string; label: string }> = [
      { file: 'CLAUDE.md', content: POINTER_CLAUDE_MD, label: 'CLAUDE.md (thin pointer)' },
      { file: '.cursorrules', content: POINTER_CURSORRULES, label: '.cursorrules (thin pointer)' },
      { file: 'agents.md', content: POINTER_AGENTS_MD, label: 'agents.md (thin pointer)' },
      { file: 'GEMINI.md', content: POINTER_GEMINI_MD, label: 'GEMINI.md (thin pointer)' },
      { file: 'copilot-instructions.md', content: POINTER_COPILOT_MD, label: 'copilot-instructions.md (thin pointer)' },
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
        'charter adf populate  # auto-fill ADF files from codebase signals',
        'Edit core.adf to add project-specific constraints and rules',
        'charter adf fmt .ai/core.adf --check',
        'charter adf bundle --task "<prompt>"',
      ],
    }, null, 2));
  } else {
    console.log('');
    console.log('  \u2713 Created .ai/ directory');
    console.log('');
    console.log('  Your AI governance is ready. Here\'s what was created:');
    console.log('');
    console.log('    .ai/manifest.adf    \u2014 Module router (controls what loads when)');
    console.log('    .ai/core.adf        \u2014 Universal rules (always loaded)');
    console.log('    .ai/state.adf       \u2014 Project state tracking');
    for (const file of moduleFiles) {
      console.log(`    .ai/${file.padEnd(19)}\u2014 Domain-specific rules (on-demand)`);
    }
    console.log('');
    console.log('  Next steps:');
    console.log('    1. Edit .ai/core.adf to add your project\'s constraints');
    console.log('    2. Run \'charter doctor\' to validate your setup');
    console.log('    3. Run \'charter adf bundle --task "<prompt>"\' to see the assembled context');
    console.log('');
    console.log('  Docs: https://github.com/Stackbilt-dev/charter');
  }

  return EXIT_CODE.SUCCESS;
}

// ============================================================================
// adf fmt
// ============================================================================

function adfFmt(options: CLIOptions, args: string[]): number {
  if (args.includes('--explain')) {
    const payload = {
      canonicalSectionOrder: CANONICAL_KEY_ORDER,
      note: 'Known sections are sorted in this order; unknown sections keep insertion order after known sections.',
    };
    if (options.format === 'json') {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log('  Canonical ADF section order:');
      for (const key of CANONICAL_KEY_ORDER) {
        console.log(`    - ${key}`);
      }
      console.log('');
      console.log('  Unknown section keys are preserved after known keys.');
    }
    return EXIT_CODE.SUCCESS;
  }

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

  const rawOps = opsFile ? readFlagFile(opsFile, '--ops-file') : opsJson!;

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
// adf create
// ============================================================================

function adfCreate(options: CLIOptions, args: string[]): number {
  const moduleArg = args.find(a => !a.startsWith('-'));
  if (!moduleArg) {
    throw new CLIError('adf create requires a module path. Usage: charter adf create <module> [--triggers "a,b"] [--load default|on-demand]');
  }

  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const force = options.yes || args.includes('--force');
  const load = (getFlag(args, '--load') || 'on-demand').toLowerCase();
  if (load !== 'default' && load !== 'on-demand') {
    throw new CLIError(`Invalid --load value: ${load}. Use default or on-demand.`);
  }

  const manifestPath = path.join(aiDir, 'manifest.adf');
  if (!fs.existsSync(manifestPath)) {
    throw new CLIError(`manifest.adf not found at ${manifestPath}. Run: charter adf init`);
  }

  const modulePath = moduleArg.endsWith('.adf') ? moduleArg : `${moduleArg}.adf`;
  const moduleRelPath = modulePath.replace(/\\/g, '/');

  // Prevent directory traversal: reject paths that escape the .ai/ directory
  if (moduleRelPath.includes('..') || path.isAbsolute(moduleRelPath)) {
    throw new CLIError(`Invalid module path: "${moduleRelPath}". Path must not contain ".." or be absolute.`);
  }

  const moduleAbsPath = path.join(aiDir, moduleRelPath);
  const resolvedAiDir = path.resolve(aiDir);
  const resolvedModulePath = path.resolve(moduleAbsPath);
  if (!resolvedModulePath.startsWith(resolvedAiDir + path.sep)) {
    throw new CLIError(`Invalid module path: "${moduleRelPath}". Path must stay within ${aiDir}/.`);
  }

  fs.mkdirSync(path.dirname(moduleAbsPath), { recursive: true });

  let fileCreated = false;
  if (!fs.existsSync(moduleAbsPath) || force) {
    fs.writeFileSync(moduleAbsPath, buildModuleScaffold(moduleRelPath));
    fileCreated = true;
  }

  const manifestDoc = parseAdf(fs.readFileSync(manifestPath, 'utf-8'));
  const sectionKey = load === 'default' ? 'DEFAULT_LOAD' : 'ON_DEMAND';
  const triggers = parseTriggers(getFlag(args, '--triggers'));
  const manifestEntry = load === 'on-demand' && triggers.length > 0
    ? `${moduleRelPath} (Triggers on: ${triggers.join(', ')})`
    : moduleRelPath;

  let section = manifestDoc.sections.find(s => s.key === sectionKey);
  if (!section) {
    section = {
      key: sectionKey,
      decoration: null,
      content: { type: 'list', items: [] },
    };
    manifestDoc.sections.push(section);
  }
  if (section.content.type !== 'list') {
    throw new CLIError(`${sectionKey} must be a list section in manifest.adf`);
  }

  const existingIdx = section.content.items.findIndex(item => parseModulePathFromEntry(item) === moduleRelPath);
  let manifestUpdated = false;
  if (existingIdx === -1) {
    section.content.items.push(manifestEntry);
    manifestUpdated = true;
  } else if (section.content.items[existingIdx] !== manifestEntry) {
    section.content.items[existingIdx] = manifestEntry;
    manifestUpdated = true;
  }

  if (manifestUpdated) {
    fs.writeFileSync(manifestPath, formatAdf(manifestDoc));
  }

  const output = {
    aiDir,
    module: moduleRelPath,
    fileCreated,
    manifestUpdated,
    loadPolicy: load === 'default' ? 'DEFAULT_LOAD' : 'ON_DEMAND',
    triggers,
  };

  if (options.format === 'json') {
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (fileCreated) {
      console.log(`  [ok] Created ${path.join(aiDir, moduleRelPath)}`);
    } else {
      console.log(`  [ok] Reused existing ${path.join(aiDir, moduleRelPath)}`);
    }
    if (manifestUpdated) {
      console.log(`  [ok] Registered ${moduleRelPath} in ${sectionKey}`);
    } else {
      console.log(`  [ok] ${moduleRelPath} already registered in ${sectionKey}`);
    }
  }

  return EXIT_CODE.SUCCESS;
}

// ============================================================================
// Helpers
// ============================================================================


function printHelp(): void {
  console.log('');
  console.log('  charter adf — Attention-Directed Format tools');
  console.log('');
  console.log('  Usage:');
  console.log('    charter adf init [--ai-dir <dir>] [--force] [--emit-pointers] [--preset <preset>]');
  console.log('      Scaffold .ai/ directory with manifest, core, and state modules.');
  console.log('      --module <name>: add a single module to an existing .ai/ (additive, no overwrite)');
  console.log('      --preset <preset>: scaffold preset-aware modules (worker|frontend|backend|fullstack|docs)');
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
  console.log('      Valid ops: ADD_BULLET, REPLACE_BULLET, REMOVE_BULLET,');
  console.log('                 ADD_SECTION, REPLACE_SECTION, REMOVE_SECTION, UPDATE_METRIC');
  console.log('      Examples:');
  console.log('        ADD_BULLET:    {"op":"ADD_BULLET","section":"CONSTRAINTS","value":"..."}');
  console.log('        ADD_SECTION:   {"op":"ADD_SECTION","key":"CONTEXT","decoration":"📋","content":{"type":"list","items":["..."]}}');
  console.log('        REPLACE_SECTION: {"op":"REPLACE_SECTION","key":"STATE","content":{"type":"map","entries":[{"key":"CURRENT","value":"..."}]}}');
  console.log('');
  console.log('    charter adf populate [--ai-dir <dir>] [--dry-run] [--force]');
  console.log('      Auto-fill ADF files from codebase signals (package.json, README, stack detection).');
  console.log('      Populates CONTEXT in core/backend/frontend.adf and STATE in state.adf.');
  console.log('      Skips files with existing custom content unless --force.');
  console.log('    charter adf create <module> [--ai-dir <dir>] [--triggers "a,b,c"] [--load default|on-demand] [--force]');
  console.log('      Create a module file and register it in manifest DEFAULT_LOAD or ON_DEMAND.');
  console.log('      --triggers: comma-separated trigger keywords (for ON_DEMAND entries).');
  console.log('');
  console.log('    charter adf bundle --task "<prompt>" [--ai-dir <dir>]');
  console.log('      Resolve manifest modules for a task and output merged context.');
  console.log('');
  console.log('    charter adf fmt --explain');
  console.log('      Show canonical section ordering used by the formatter.');
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
  console.log('    charter adf tidy [--dry-run] [--source <file>] [--ai-dir <dir>] [--ci]');
  console.log('      Scan vendor config files for content added beyond the thin pointer,');
  console.log('      classify and route to ADF modules, restore thin pointer.');
  console.log('      --dry-run: preview without modifying files');
  console.log('      --ci: exit 1 if bloat found (with --dry-run, for pre-commit gating)');
  console.log('');
  console.log('    charter adf metrics recalibrate [--headroom <percent>] [--reason "<text>"|--auto-rationale] [--dry-run]');
  console.log('      Recalibrate metric baselines/ceilings from current LOC with required rationale.');
  console.log('');
}

function parseTriggers(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(v => v.trim())
    .filter(v => v.length > 0);
}

function parseModulePathFromEntry(entry: string): string {
  const withoutBudget = entry.replace(/\s*\[budget\s*:\s*\d+\]\s*$/i, '').trim();
  const triggerMatch = withoutBudget.match(/^(.+?)\s*\(Triggers?\s+on\s*:\s*.+\)\s*$/i);
  return triggerMatch ? triggerMatch[1].trim() : withoutBudget;
}

function buildModuleScaffold(modulePath: string): string {
  const name = path.basename(modulePath, '.adf');
  return `ADF: 0.1
\u{1F3AF} TASK: ${name} module

\u{1F4CB} CONTEXT:
  - Module scaffold
  - Add project-specific rules and constraints
`;
}

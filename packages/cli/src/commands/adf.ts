/**
 * charter adf
 *
 * ADF (Attention-Directed Format) subcommands: init, fmt, patch, bundle, sync.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  parseAdf,
  formatAdf,
  applyPatches,
  parseManifest,
  resolveModules,
  bundleModules,
  validateConstraints,
} from '@stackbilt/adf';
import type { PatchOperation, EvidenceResult } from '@stackbilt/adf';
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

\u{26A0}\u{FE0F} CONSTRAINTS [load-bearing]:
  - Follow conventional commits.
  - No secrets in source code.
  - Prefer pure functions in library code.

\u{1F4CA} METRICS [load-bearing]:
  entry_loc: 0 / 500 [lines]
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
    case 'sync':
      return adfSync(options, restArgs);
    case 'evidence':
      return adfEvidence(options, restArgs);
    default:
      throw new CLIError(`Unknown adf subcommand: ${subcommand}. Supported: init, fmt, patch, bundle, sync, evidence`);
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
      const jsonOut: Record<string, unknown> = {
        task,
        keywords,
        resolvedModules: result.resolvedModules,
        tokenEstimate: result.tokenEstimate,
        tokenBudget: result.tokenBudget,
        tokenUtilization: result.tokenUtilization,
        perModuleTokens: result.perModuleTokens,
        triggerMatches: result.triggerMatches,
      };
      if (result.moduleBudgetOverruns.length > 0) {
        jsonOut.moduleBudgetOverruns = result.moduleBudgetOverruns;
      }
      if (result.advisoryOnlyModules.length > 0) {
        jsonOut.advisoryOnlyModules = result.advisoryOnlyModules;
      }
      if (result.manifest.cadence.length > 0) {
        jsonOut.cadence = result.manifest.cadence;
      }
      console.log(JSON.stringify(jsonOut, null, 2));
    } else {
      console.log(`  Task: "${task}"`);
      console.log(`  Keywords: ${keywords.join(', ')}`);
      console.log(`  Resolved modules: ${result.resolvedModules.join(', ')}`);
      console.log(`  Token estimate: ~${result.tokenEstimate}`);
      if (result.tokenBudget !== null) {
        const pct = result.tokenUtilization !== null
          ? ` (${(result.tokenUtilization * 100).toFixed(0)}%)`
          : '';
        console.log(`  Token budget: ${result.tokenBudget}${pct}`);
      }
      console.log('');

      if (result.moduleBudgetOverruns.length > 0) {
        console.log('  Module budget overruns:');
        for (const o of result.moduleBudgetOverruns) {
          console.log(`    [!] ${o.module}: ~${o.tokens} tokens (budget: ${o.budget})`);
        }
        console.log('');
      }

      if (result.triggerMatches.length > 0) {
        console.log('  Trigger report:');
        for (const tm of result.triggerMatches) {
          const icon = tm.matched ? '+' : '-';
          console.log(`    [${icon}] ${tm.module} (${tm.trigger})`);
        }
        console.log('');
      }

      if (result.advisoryOnlyModules.length > 0) {
        console.log('  Advisory-only modules:');
        for (const m of result.advisoryOnlyModules) {
          console.log(`    [!] ${m}: no load-bearing sections`);
        }
        console.log('');
      }

      if (result.manifest.cadence.length > 0) {
        console.log('  Cadence schedule:');
        for (const c of result.manifest.cadence) {
          console.log(`    ${c.check}: ${c.frequency}`);
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
// adf sync
// ============================================================================

interface SyncStatus {
  source: string;
  target: string;
  sourceHash: string;
  lockedHash: string | null;
  inSync: boolean;
}

interface AdfSyncResult {
  aiDir: string;
  lockFile: string;
  entries: SyncStatus[];
  allInSync: boolean;
  written: boolean;
}

function adfSync(options: CLIOptions, args: string[]): number {
  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const checkMode = args.includes('--check');
  const writeMode = args.includes('--write');

  if (!checkMode && !writeMode) {
    throw new CLIError('adf sync requires --check or --write. Usage: charter adf sync --check');
  }

  const manifestPath = path.join(aiDir, 'manifest.adf');
  if (!fs.existsSync(manifestPath)) {
    throw new CLIError(`manifest.adf not found at ${manifestPath}. Run: charter adf init`);
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  const manifestDoc = parseAdf(manifestContent);
  const manifest = parseManifest(manifestDoc);

  if (manifest.sync.length === 0) {
    const result: AdfSyncResult = {
      aiDir,
      lockFile: path.join(aiDir, '.adf.lock'),
      entries: [],
      allInSync: true,
      written: false,
    };
    if (options.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('  No SYNC entries in manifest. Nothing to check.');
    }
    return EXIT_CODE.SUCCESS;
  }

  const lockFile = path.join(aiDir, '.adf.lock');
  const locked = loadLockFile(lockFile);

  const entries: SyncStatus[] = [];
  for (const entry of manifest.sync) {
    const sourcePath = path.join(aiDir, entry.source);
    if (!fs.existsSync(sourcePath)) {
      throw new CLIError(`Sync source not found: ${sourcePath}`);
    }
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
    const sourceHash = hashContent(sourceContent);
    const lockedHash = locked[entry.source] ?? null;

    entries.push({
      source: entry.source,
      target: entry.target,
      sourceHash,
      lockedHash,
      inSync: lockedHash === sourceHash,
    });
  }

  const allInSync = entries.every(e => e.inSync);

  if (writeMode) {
    const newLock: Record<string, string> = {};
    for (const e of entries) {
      newLock[e.source] = e.sourceHash;
    }
    fs.writeFileSync(lockFile, JSON.stringify(newLock, null, 2) + '\n');

    const result: AdfSyncResult = {
      aiDir,
      lockFile,
      entries,
      allInSync: true,
      written: true,
    };
    if (options.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`  [ok] Updated ${lockFile} with ${entries.length} hash${entries.length === 1 ? '' : 'es'}.`);
    }
    return EXIT_CODE.SUCCESS;
  }

  // --check mode
  const result: AdfSyncResult = {
    aiDir,
    lockFile,
    entries,
    allInSync,
    written: false,
  };

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const e of entries) {
      if (e.inSync) {
        console.log(`  [ok] ${e.source} -> ${e.target} (in sync)`);
      } else if (e.lockedHash === null) {
        console.log(`  [warn] ${e.source} -> ${e.target} (no lock entry — run: charter adf sync --write)`);
      } else {
        console.log(`  [fail] ${e.source} -> ${e.target} (source changed since last sync)`);
      }
    }
    if (!allInSync) {
      console.log('');
      console.log('  Source .adf files have changed. Regenerate targets and run: charter adf sync --write');
    }
  }

  return allInSync ? EXIT_CODE.SUCCESS : EXIT_CODE.POLICY_VIOLATION;
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function loadLockFile(lockFile: string): Record<string, string> {
  if (!fs.existsSync(lockFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
  } catch {
    return {};
  }
}

// ============================================================================
// adf evidence
// ============================================================================

function adfEvidence(options: CLIOptions, args: string[]): number {
  const task = getFlag(args, '--task');
  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const contextJson = getFlag(args, '--context');

  const manifestPath = path.join(aiDir, 'manifest.adf');
  if (!fs.existsSync(manifestPath)) {
    throw new CLIError(`manifest.adf not found at ${manifestPath}. Run: charter adf init`);
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  const manifestDoc = parseAdf(manifestContent);
  const manifest = parseManifest(manifestDoc);

  // Resolve modules
  let modulePaths: string[];
  let keywords: string[] = [];
  if (task) {
    keywords = task
      .split(/[\s,;:()[\]{}]+/)
      .filter(w => w.length > 1)
      .map(w => w.replace(/[^a-zA-Z0-9]/g, ''));
    modulePaths = resolveModules(manifest, keywords);
  } else {
    modulePaths = [...manifest.defaultLoad];
  }

  const readFile = (p: string): string => fs.readFileSync(p, 'utf-8');

  let context: Record<string, number> | undefined;
  if (contextJson) {
    try {
      const parsed = JSON.parse(contextJson);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('must be a JSON object');
      }
      context = parsed as Record<string, number>;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new CLIError(`Invalid --context JSON: ${msg}`);
    }
  }

  try {
    const bundle = bundleModules(aiDir, modulePaths, readFile);
    const evidence: EvidenceResult = validateConstraints(bundle.mergedDocument, context);

    // Check sync status
    const lockFile = path.join(aiDir, '.adf.lock');
    const locked = loadLockFile(lockFile);
    const syncEntries: Array<{ source: string; inSync: boolean }> = [];
    for (const entry of manifest.sync) {
      const sourcePath = path.join(aiDir, entry.source);
      if (fs.existsSync(sourcePath)) {
        const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
        const sourceHash = hashContent(sourceContent);
        const lockedHash = locked[entry.source] ?? null;
        syncEntries.push({ source: entry.source, inSync: lockedHash === sourceHash });
      }
    }
    const allInSync = syncEntries.length === 0 || syncEntries.every(e => e.inSync);
    const staleCount = syncEntries.filter(e => !e.inSync).length;

    if (options.format === 'json') {
      const jsonOut: Record<string, unknown> = {
        aiDir,
        resolvedModules: bundle.resolvedModules,
        tokenEstimate: bundle.tokenEstimate,
        tokenBudget: bundle.tokenBudget,
        tokenUtilization: bundle.tokenUtilization,
        constraints: evidence.constraints,
        weightSummary: evidence.weightSummary,
        allPassing: evidence.allPassing,
        failCount: evidence.failCount,
        warnCount: evidence.warnCount,
        syncStatus: { allInSync, staleCount },
      };
      if (task) {
        jsonOut.task = task;
        jsonOut.keywords = keywords;
      }
      if (bundle.advisoryOnlyModules.length > 0) {
        jsonOut.advisoryOnlyModules = bundle.advisoryOnlyModules;
      }
      console.log(JSON.stringify(jsonOut, null, 2));
    } else {
      console.log('');
      console.log('  ADF Evidence Report');
      console.log('  ===================');
      console.log(`  Modules loaded: ${bundle.resolvedModules.join(', ')}`);
      console.log(`  Token estimate: ~${bundle.tokenEstimate}`);
      if (bundle.tokenBudget !== null) {
        const pct = bundle.tokenUtilization !== null
          ? ` (${(bundle.tokenUtilization * 100).toFixed(0)}%)`
          : '';
        console.log(`  Token budget: ${bundle.tokenBudget}${pct}`);
      }
      console.log('');

      // Weight summary
      console.log('  Section weights:');
      console.log(`    Load-bearing: ${evidence.weightSummary.loadBearing}`);
      console.log(`    Advisory: ${evidence.weightSummary.advisory}`);
      console.log(`    Unweighted: ${evidence.weightSummary.unweighted}`);
      console.log('');

      // Advisory-only module warnings
      if (bundle.advisoryOnlyModules.length > 0) {
        console.log('  Advisory-only modules:');
        for (const m of bundle.advisoryOnlyModules) {
          console.log(`    [!] ${m}: no load-bearing sections`);
        }
        console.log('');
      }

      // Constraints
      if (evidence.constraints.length > 0) {
        console.log('  Constraints:');
        for (const c of evidence.constraints) {
          const icon = c.status === 'pass' ? 'ok' : c.status === 'warn' ? 'WARN' : 'FAIL';
          console.log(`    [${icon}] ${c.message}`);
        }
      } else {
        console.log('  Constraints: (none)');
      }
      console.log('');

      // Sync status
      if (syncEntries.length > 0) {
        if (allInSync) {
          console.log('  Sync: all sources in sync');
        } else {
          console.log(`  Sync: ${staleCount} source${staleCount === 1 ? '' : 's'} out of sync`);
        }
      } else {
        console.log('  Sync: no sync entries configured');
      }
      console.log('');

      // Verdict
      const verdict = evidence.allPassing ? 'PASS' : 'FAIL';
      console.log(`  Verdict: ${verdict}`);
      if (evidence.warnCount > 0) {
        console.log(`  (${evidence.warnCount} warning${evidence.warnCount === 1 ? '' : 's'} — at ceiling boundary)`);
      }
      console.log('');
    }

    // CI mode: exit 1 on constraint failures
    if (options.ciMode && !evidence.allPassing) {
      return EXIT_CODE.POLICY_VIOLATION;
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
  console.log('    charter adf sync --check [--ai-dir <dir>]');
  console.log('      Verify source .adf files match their locked hashes.');
  console.log('      Exit 1 if any source has changed since last sync.');
  console.log('');
  console.log('    charter adf sync --write [--ai-dir <dir>]');
  console.log('      Update .adf.lock with current source hashes.');
  console.log('');
  console.log('    charter adf evidence [--task "<prompt>"] [--ai-dir <dir>] [--context \'{"key": value}\']');
  console.log('      Validate metric constraints and produce a structured evidence report.');
  console.log('      --task: resolve on-demand modules for task. Omit for defaultLoad only.');
  console.log('      --context: JSON object of external metric overrides.');
  console.log('      In --ci mode, exit 1 if any constraint fails.');
  console.log('');
}

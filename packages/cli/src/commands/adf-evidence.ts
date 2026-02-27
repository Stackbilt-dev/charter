/**
 * charter adf evidence
 *
 * Validates metric constraints and produces structured evidence reports.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseAdf,
  parseManifest,
  resolveModules,
  bundleModules,
  validateConstraints,
} from '@stackbilt/adf';
import type { AdfDocument, EvidenceResult } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { hashContent, loadLockFile } from './adf-sync';

interface AutoMeasurement {
  metric: string;
  path: string;
  lines: number | null;
  error?: string;
}

interface StaleBaselineWarning {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  ratio: number;
  recommendedCeiling: number;
  rationaleRequired: boolean;
}

export function adfEvidence(options: CLIOptions, args: string[]): number {
  const task = getFlag(args, '--task');
  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const contextJson = getFlag(args, '--context');
  const contextFile = getFlag(args, '--context-file');
  const autoMeasure = args.includes('--auto-measure');
  const staleThreshold = parseStaleThreshold(getFlag(args, '--stale-threshold') || '1.2');

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
  const rawContext = contextFile ? readJsonFlag(contextFile, '--context-file') : contextJson;
  if (rawContext) {
    try {
      const parsed = JSON.parse(rawContext);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('must be a JSON object');
      }
      context = parsed as Record<string, number>;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new CLIError(`Invalid --context JSON: ${msg}`);
    }
  }

  // Auto-measure: count lines in files referenced by manifest METRICS
  // Manifest keys are UPPERCASE (parser map disambiguation), metric keys are lowercase.
  const autoMeasured: AutoMeasurement[] = [];
  if (autoMeasure && manifest.metrics.length > 0) {
    const measured: Record<string, number> = {};
    for (const ms of manifest.metrics) {
      const metricKey = ms.key.toLowerCase();
      const filePath = path.resolve(ms.path);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').length;
        measured[metricKey] = lines;
        autoMeasured.push({ metric: metricKey, path: ms.path, lines });
      } else {
        autoMeasured.push({ metric: metricKey, path: ms.path, lines: null, error: 'file not found' });
      }
    }
    // Merge: explicit --context wins over auto-measured
    context = { ...measured, ...context };
  }

  try {
    const bundle = bundleModules(aiDir, modulePaths, readFile, keywords);
    const evidence: EvidenceResult = validateConstraints(bundle.mergedDocument, context);
    const staleBaselines = detectStaleBaselines(bundle.mergedDocument, context, staleThreshold);

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
        staleBaselineCount: staleBaselines.length,
        syncStatus: { allInSync, staleCount },
      };
      if (task) {
        jsonOut.task = task;
        jsonOut.keywords = keywords;
      }
      if (bundle.advisoryOnlyModules.length > 0) {
        jsonOut.advisoryOnlyModules = bundle.advisoryOnlyModules;
      }
      if (autoMeasured.length > 0) {
        jsonOut.autoMeasured = autoMeasured;
      }
      if (staleBaselines.length > 0) {
        jsonOut.staleBaselines = staleBaselines;
      }
      // Suggest logical next steps based on results
      const nextActions: string[] = [];
      if (!evidence.allPassing) {
        nextActions.push('Fix failing constraints before merging');
      }
      if (!allInSync) {
        nextActions.push('charter adf sync --write');
      }
      if (evidence.warnCount > 0) {
        nextActions.push('Review metrics at ceiling boundary');
      }
      if (staleBaselines.length > 0) {
        nextActions.push('charter adf metrics recalibrate --headroom 15 --reason "<rationale>" --dry-run');
      }
      if (nextActions.length > 0) {
        jsonOut.nextActions = nextActions;
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

      // Auto-measured metrics
      if (autoMeasured.length > 0) {
        console.log('  Auto-measured:');
        for (const m of autoMeasured) {
          if (m.lines !== null) {
            console.log(`    ${m.metric}: ${m.lines} lines (${m.path})`);
          } else {
            console.log(`    ${m.metric}: [file not found] (${m.path})`);
          }
        }
        console.log('');
      }

      if (staleBaselines.length > 0) {
        console.log('  Stale baseline warnings:');
        for (const s of staleBaselines) {
          console.log(`    [warn] ${s.metric}: baseline ${s.baseline}, current ${s.current}, delta ${s.delta}, recommended ceiling ${s.recommendedCeiling} (rationale required)`);
        }
        console.log('');
      }

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

function parseStaleThreshold(raw: string): number {
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 1.0 || parsed > 10) {
    throw new CLIError(`Invalid --stale-threshold value: ${raw}. Use a number between 1.0 and 10.0.`);
  }
  return parsed;
}

function detectStaleBaselines(
  doc: AdfDocument,
  context: Record<string, number> | undefined,
  staleThreshold: number
): StaleBaselineWarning[] {
  if (!context) return [];
  const warnings: StaleBaselineWarning[] = [];
  for (const section of doc.sections) {
    if (section.key !== 'METRICS' || section.content.type !== 'metric') continue;
    for (const entry of section.content.entries) {
      if (entry.value <= 0) continue;
      const key = entry.key.toLowerCase();
      const current = context[key];
      if (!Number.isFinite(current)) continue;
      const ratio = current / entry.value;
      if (ratio < staleThreshold) continue;
      warnings.push({
        metric: key,
        baseline: entry.value,
        current,
        delta: current - entry.value,
        ratio: Number(ratio.toFixed(2)),
        recommendedCeiling: Math.ceil(current * 1.15),
        rationaleRequired: true,
      });
    }
  }
  return warnings;
}

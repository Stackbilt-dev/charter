/**
 * charter adf metrics
 *
 * Metric budget utilities for recalibration workflows.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatAdf, parseAdf, parseManifest } from '@stackbilt/adf';
import type { AdfDocument } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';

interface MetricUpdate {
  metric: string;
  current: number;
  previousValue: number;
  previousCeiling: number;
  recommendedCeiling: number;
  module: string;
}

interface ModuleUpdate {
  modulePath: string;
  document: AdfDocument;
  updates: MetricUpdate[];
}

export function adfMetricsCommand(options: CLIOptions, args: string[]): number {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return EXIT_CODE.SUCCESS;
  }

  const subcommand = args[0];
  const rest = args.slice(1);
  switch (subcommand) {
    case 'recalibrate':
      return metricsRecalibrate(options, rest);
    default:
      throw new CLIError(`Unknown adf metrics subcommand: ${subcommand}. Supported: recalibrate`);
  }
}

function metricsRecalibrate(options: CLIOptions, args: string[]): number {
  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const manifestPath = path.join(aiDir, 'manifest.adf');
  const headroomPercent = parseHeadroom(getFlag(args, '--headroom') || '15');
  const dryRun = args.includes('--dry-run');
  const autoRationale = args.includes('--auto-rationale');
  const reason = getFlag(args, '--reason');

  if (!fs.existsSync(manifestPath)) {
    throw new CLIError(`manifest.adf not found at ${manifestPath}. Run: charter adf init`);
  }

  if (!autoRationale && !reason) {
    throw new CLIError('metrics recalibrate requires --reason "<rationale>" or --auto-rationale.');
  }

  const manifestDoc = parseAdf(fs.readFileSync(manifestPath, 'utf-8'));
  const manifest = parseManifest(manifestDoc);
  if (manifest.metrics.length === 0) {
    throw new CLIError('No METRICS sources found in manifest.adf; cannot recalibrate.');
  }

  const measured = measureManifestMetrics(manifest.metrics);
  const updateByModule = buildModuleUpdates(aiDir, manifest, measured, headroomPercent);
  const allUpdates = [...updateByModule.values()].flatMap((u) => u.updates);

  if (allUpdates.length === 0) {
    if (options.format === 'json') {
      console.log(JSON.stringify({ aiDir, updated: false, reason: 'no matching metric entries found' }, null, 2));
    } else {
      console.log('  No matching metric entries found in module METRICS sections.');
    }
    return EXIT_CODE.SUCCESS;
  }

  const rationaleText = autoRationale
    ? buildAutoRationale(headroomPercent, allUpdates.length)
    : reason!;

  for (const moduleUpdate of updateByModule.values()) {
    ensureRationaleEntry(moduleUpdate.document, moduleUpdate.updates, rationaleText);
  }

  if (!dryRun) {
    writeModuleUpdatesAtomically(aiDir, [...updateByModule.values()]);
  }

  const output = {
    aiDir,
    dryRun,
    headroomPercent,
    metricsUpdated: allUpdates.length,
    modulesTouched: [...updateByModule.keys()],
    updates: allUpdates.map((u) => ({
      metric: u.metric,
      module: u.module,
      baseline: u.previousValue,
      current: u.current,
      delta: u.current - u.previousValue,
      previousCeiling: u.previousCeiling,
      recommendedCeiling: u.recommendedCeiling,
      rationaleRequired: true,
    })),
    rationale: rationaleText,
  };

  if (options.format === 'json') {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`  Recalibration ${dryRun ? 'preview' : 'complete'} (${allUpdates.length} metric update(s))`);
    console.log(`  Headroom policy: +${headroomPercent}%`);
    for (const update of allUpdates) {
      const delta = update.current - update.previousValue;
      console.log(
        `    - ${update.metric} [${update.module}]: baseline ${update.previousValue}, current ${update.current}, delta ${delta}, ceiling ${update.previousCeiling} -> ${update.recommendedCeiling}`
      );
    }
    console.log(`  Rationale: ${rationaleText}`);
  }

  return EXIT_CODE.SUCCESS;
}

function measureManifestMetrics(metricSources: Array<{ key: string; path: string }>): Record<string, number> {
  const measured: Record<string, number> = {};
  for (const source of metricSources) {
    const metricKey = source.key.toLowerCase();
    const sourcePath = path.resolve(source.path);
    if (!fs.existsSync(sourcePath)) continue;
    const content = fs.readFileSync(sourcePath, 'utf-8');
    measured[metricKey] = content.split('\n').length;
  }
  return measured;
}

function buildModuleUpdates(
  aiDir: string,
  manifest: ReturnType<typeof parseManifest>,
  measured: Record<string, number>,
  headroomPercent: number
): Map<string, ModuleUpdate> {
  const modulePaths = [...new Set([...manifest.defaultLoad, ...manifest.onDemand.map((m) => m.path)])];
  const updates = new Map<string, ModuleUpdate>();

  for (const modulePath of modulePaths) {
    const fullPath = path.join(aiDir, modulePath);
    if (!fs.existsSync(fullPath)) continue;
    const doc = parseAdf(fs.readFileSync(fullPath, 'utf-8'));

    const moduleUpdates: MetricUpdate[] = [];
    for (const section of doc.sections) {
      if (section.key !== 'METRICS' || section.content.type !== 'metric') continue;
      for (const entry of section.content.entries) {
        const key = entry.key.toLowerCase();
        const current = measured[key];
        if (current === undefined) continue;
        const recommendedCeiling = Math.ceil(current * (1 + headroomPercent / 100));
        moduleUpdates.push({
          metric: key,
          current,
          previousValue: entry.value,
          previousCeiling: entry.ceiling,
          recommendedCeiling,
          module: modulePath,
        });
        entry.value = current;
        entry.ceiling = recommendedCeiling;
      }
    }

    if (moduleUpdates.length > 0) {
      updates.set(modulePath, {
        modulePath,
        document: doc,
        updates: moduleUpdates,
      });
    }
  }

  return updates;
}

function ensureRationaleEntry(doc: AdfDocument, updates: MetricUpdate[], rationale: string): void {
  const key = 'BUDGET_RATIONALES';
  let section = doc.sections.find((s) => s.key === key);
  if (!section) {
    section = {
      key,
      decoration: null,
      content: { type: 'map', entries: [] },
    };
    doc.sections.push(section);
  }
  if (section.content.type !== 'map') {
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  for (const update of updates) {
    const rationaleKey = `${update.metric}_${date}`;
    const rationaleValue = `${update.previousValue} -> ${update.current}, ceiling ${update.previousCeiling} -> ${update.recommendedCeiling}; ${rationale}`;
    const existing = section.content.entries.find((entry) => entry.key === rationaleKey);
    if (existing) {
      existing.value = rationaleValue;
    } else {
      section.content.entries.push({ key: rationaleKey, value: rationaleValue });
    }
  }
}

function writeModuleUpdatesAtomically(aiDir: string, updates: ModuleUpdate[]): void {
  const tempFiles: Array<{ temp: string; target: string }> = [];
  for (const update of updates) {
    const target = path.join(aiDir, update.modulePath);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, formatAdf(update.document));
    tempFiles.push({ temp, target });
  }
  for (const entry of tempFiles) {
    fs.renameSync(entry.temp, entry.target);
  }
}

function parseHeadroom(raw: string): number {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
    throw new CLIError(`Invalid --headroom value: ${raw}. Use an integer between 1 and 200.`);
  }
  return parsed;
}

function buildAutoRationale(headroomPercent: number, metricCount: number): string {
  const date = new Date().toISOString().slice(0, 10);
  return `Recalibrated ${metricCount} metric baseline(s) on ${date} using +${headroomPercent}% headroom from current measured LOC.`;
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function printHelp(): void {
  console.log('');
  console.log('  charter adf metrics');
  console.log('');
  console.log('  Usage:');
  console.log('    charter adf metrics recalibrate [--headroom <percent>] [--reason "<text>"|--auto-rationale] [--dry-run] [--ai-dir <dir>]');
  console.log('');
}

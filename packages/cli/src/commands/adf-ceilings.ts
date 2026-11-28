/**
 * Shared metric measurement for manifest METRICS sources.
 *
 * `adf evidence --auto-measure` (the CI gate) and `adf context --files`
 * (pre-edit headroom, #443) both measure through this module, so the number
 * an agent sees before editing is the number the gate enforces.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAdf, validateConstraints } from '@stackbilt/adf';
import type { Manifest, MetricSource, ConstraintStatus } from '@stackbilt/adf';

export interface AutoMeasurement {
  metric: string;
  path: string;
  lines: number | null;
  error?: string;
}

export interface FileCeiling {
  file: string;
  metric: string;
  value: number;
  ceiling: number;
  headroom: number;
  status: ConstraintStatus;
  module: string;
}

/**
 * Line count exactly as the evidence gate counts it: split on '\n', so a
 * trailing newline counts as one extra line. Returns null when the file is missing.
 */
export function measureLines(filePath: string): number | null {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf-8').split('\n').length;
}

/** Measure every manifest METRICS source. Metric keys are lowercased. */
export function measureMetricSources(metrics: MetricSource[]): AutoMeasurement[] {
  return metrics.map((ms) => {
    const metric = ms.key.toLowerCase();
    const lines = measureLines(ms.path);
    return lines === null
      ? { metric, path: ms.path, lines: null, error: 'file not found' }
      : { metric, path: ms.path, lines };
  });
}

/** Normalize a path to repo-relative POSIX form for comparison. */
function normalizePath(p: string): string {
  const posix = p.replace(/\\/g, '/');
  return path.relative(process.cwd(), path.resolve(posix)).split(path.sep).join('/');
}

/**
 * For each requested file that a manifest METRICS source points at, report
 * its live value against the ceiling declared in the owning ADF module.
 * Files with no metric, missing files, and metrics with no declared ceiling
 * produce no entry.
 */
export function computeFileCeilings(
  aiDir: string,
  manifest: Manifest,
  files: string[],
): FileCeiling[] {
  const wanted = new Set(files.map(normalizePath));
  const sources = manifest.metrics.filter((ms) => wanted.has(normalizePath(ms.path)));
  if (sources.length === 0) return [];

  const modules = [...new Set([...manifest.defaultLoad, ...manifest.onDemand.map((m) => m.path)])];
  const docs: Array<{ module: string; doc: ReturnType<typeof parseAdf> }> = [];
  for (const mod of modules) {
    const modPath = path.join(aiDir, mod);
    if (!fs.existsSync(modPath)) continue;
    try {
      docs.push({ module: mod, doc: parseAdf(fs.readFileSync(modPath, 'utf-8')) });
    } catch {
      // An unparseable module cannot declare a ceiling; other commands report the parse error.
    }
  }

  const results: FileCeiling[] = [];
  for (const ms of sources) {
    const metric = ms.key.toLowerCase();
    const value = measureLines(ms.path);
    if (value === null) continue;
    for (const { module, doc } of docs) {
      const hit = validateConstraints(doc, { [metric]: value }, module)
        .constraints.find((c) => c.metric === metric);
      if (!hit) continue;
      results.push({
        file: ms.path,
        metric,
        value,
        ceiling: hit.ceiling,
        headroom: hit.ceiling - value,
        status: hit.status,
        module,
      });
      break;
    }
  }
  return results;
}

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

export interface FileCeilingOptions {
  /** Directory the requested files are resolved against. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Repo root that `file` is shown relative to. When omitted, `file` is the
   * manifest METRICS path as written.
   */
  root?: string;
}

/** Absolute comparison key; case-insensitive on Windows, `\` accepted everywhere. */
function pathKey(base: string, p: string): string {
  const abs = path.resolve(base, process.platform === 'win32' ? p : p.replace(/\\/g, '/'));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * For each requested file that a manifest METRICS source points at, report
 * its live value against the ceiling declared in the owning ADF module.
 * Files with no metric, missing files, and metrics with no declared ceiling
 * produce no entry.
 *
 * METRICS paths are read relative to the directory holding the `.ai/` dir
 * (with the default `--ai-dir .ai` that is cwd, as for `adf evidence`), so
 * the answer does not change when run from a subdirectory with `--ai-dir ../.ai`.
 */
export function computeFileCeilings(
  aiDir: string,
  manifest: Manifest,
  files: string[],
  options: FileCeilingOptions = {},
): FileCeiling[] {
  const cwd = options.cwd ?? process.cwd();
  const metricBase = path.dirname(path.resolve(cwd, aiDir));
  const wanted = new Set(files.map((f) => pathKey(cwd, f)));
  const sources = manifest.metrics.filter((ms) => wanted.has(pathKey(metricBase, ms.path)));
  if (sources.length === 0) return [];

  const modules = [...new Set([...manifest.defaultLoad, ...manifest.onDemand.map((m) => m.path)])];
  const docs: Array<{ module: string; doc: ReturnType<typeof parseAdf> }> = [];
  for (const mod of modules) {
    const modPath = path.resolve(cwd, aiDir, mod);
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
    const abs = path.resolve(metricBase, ms.path);
    const value = measureLines(abs);
    if (value === null) continue;
    const file = options.root ? displayFrom(options.root, abs) : ms.path;
    for (const { module, doc } of docs) {
      const hit = validateConstraints(doc, { [metric]: value }, module)
        .constraints.find((c) => c.metric === metric);
      if (!hit) continue;
      results.push({
        file,
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

/** POSIX path of `abs` relative to `root`; absolute when outside it. */
export function displayFrom(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
  return shown.split(path.sep).join('/');
}

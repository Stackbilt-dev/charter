/**
 * ADF Bundler — orchestrates module resolution, loading, and merging.
 *
 * Reads a manifest.adf to determine which modules to load for a given task,
 * delegates to manifest.ts for resolution and merger.ts for document merging,
 * and assembles the final BundleResult.
 */

import type {
  AdfDocument,
  Manifest,
  BundleResult,
} from './types';
import { AdfBundleError } from './errors';
import { parseAdf } from './parser';
import { parseManifest, resolveModules, buildTriggerReport } from './manifest';
import { mergeDocuments, estimateTokens } from './merger';

// Re-export for backward compatibility
export { parseManifest, resolveModules } from './manifest';

// ============================================================================
// Bundle Orchestration
// ============================================================================

/**
 * Bundle resolved modules into a single merged ADF document.
 *
 * @param basePath - Base directory for resolving module paths
 * @param modulePaths - List of module file paths (relative to basePath)
 * @param readFile - File reader function (allows DI for testing)
 */
export function bundleModules(
  basePath: string,
  modulePaths: string[],
  readFile: (p: string) => string,
  taskKeywords: string[] = [],
  preloadedManifest?: Manifest,
): BundleResult {
  const manifest = preloadedManifest ?? loadAndParseManifest(basePath, readFile);
  const triggerMatches = buildTriggerReport(manifest, modulePaths, taskKeywords);

  const documents: AdfDocument[] = [];
  const perModuleTokens: Record<string, number> = {};
  const advisoryOnlyModules: string[] = [];
  const defaultLoadSet = new Set(manifest.defaultLoad);

  for (const modPath of modulePaths) {
    const fullPath = joinPath(basePath, modPath);
    let content: string;
    try {
      content = readFile(fullPath);
    } catch {
      throw new AdfBundleError(`Module not found: ${modPath}`, modPath);
    }
    const doc = parseAdf(content);
    documents.push(doc);
    perModuleTokens[modPath] = estimateTokens(doc);

    // Flag on-demand modules with no load-bearing sections
    if (!defaultLoadSet.has(modPath)) {
      const hasLoadBearing = doc.sections.some(s => s.weight === 'load-bearing');
      if (!hasLoadBearing) {
        advisoryOnlyModules.push(modPath);
      }
    }
  }

  const merged = mergeDocuments(documents);
  const tokenEstimate = estimateTokens(merged);
  const tokenBudget = manifest.tokenBudget ?? null;
  const tokenUtilization = tokenBudget !== null ? tokenEstimate / tokenBudget : null;

  // Check per-module budget overruns
  const moduleBudgetOverruns: BundleResult['moduleBudgetOverruns'] = [];
  for (const mod of manifest.onDemand) {
    if (mod.tokenBudget !== undefined && modulePaths.includes(mod.path)) {
      const tokens = perModuleTokens[mod.path];
      if (tokens !== undefined && tokens > mod.tokenBudget) {
        moduleBudgetOverruns.push({
          module: mod.path,
          tokens,
          budget: mod.tokenBudget,
        });
      }
    }
  }

  // Unmatched: on-demand modules that were not resolved
  const unmatchedModules = manifest.onDemand
    .filter(mod => !modulePaths.includes(mod.path))
    .map(mod => mod.path);

  return {
    manifest,
    resolvedModules: modulePaths,
    mergedDocument: merged,
    tokenEstimate,
    tokenBudget,
    tokenUtilization,
    perModuleTokens,
    moduleBudgetOverruns,
    triggerMatches,
    unmatchedModules,
    advisoryOnlyModules,
  };
}

function loadAndParseManifest(basePath: string, readFile: (p: string) => string): Manifest {
  const manifestPath = joinPath(basePath, 'manifest.adf');
  let content: string;
  try {
    content = readFile(manifestPath);
  } catch {
    throw new AdfBundleError('manifest.adf not found in AI directory', manifestPath);
  }
  const doc = parseAdf(content);
  return parseManifest(doc);
}

function joinPath(base: string, relative: string): string {
  if (base.endsWith('/')) return base + relative;
  return base + '/' + relative;
}

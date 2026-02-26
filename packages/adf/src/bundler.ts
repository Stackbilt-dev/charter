/**
 * ADF Bundler — manifest parsing, module resolution, and context merging.
 *
 * Reads a manifest.adf to determine which modules to load for a given task,
 * resolves ON_DEMAND modules via keyword matching, and merges into a single
 * ADF document.
 */

import type {
  AdfDocument,
  AdfSection,
  Manifest,
  ManifestModule,
  MetricSource,
  SyncEntry,
  CadenceEntry,
  BundleResult,
} from './types';
import { AdfBundleError } from './errors';
import { parseAdf } from './parser';

// ============================================================================
// Manifest Parsing
// ============================================================================

/**
 * Extract a Manifest from a parsed ADF document (manifest.adf).
 */
export function parseManifest(doc: AdfDocument): Manifest {
  const manifest: Manifest = {
    version: doc.version,
    defaultLoad: [],
    onDemand: [],
    rules: [],
    sync: [],
    cadence: [],
    metrics: [],
  };

  for (const section of doc.sections) {
    switch (section.key) {
      case 'ROLE': {
        if (section.content.type === 'text') {
          manifest.role = section.content.value;
        }
        break;
      }
      case 'DEFAULT_LOAD': {
        if (section.content.type === 'list') {
          manifest.defaultLoad = section.content.items.map(i => i.trim());
        }
        break;
      }
      case 'ON_DEMAND': {
        if (section.content.type === 'list') {
          manifest.onDemand = section.content.items.map(parseTriggerEntry);
        }
        break;
      }
      case 'RULES': {
        if (section.content.type === 'list') {
          manifest.rules = section.content.items.map(i => i.trim());
        }
        break;
      }
      case 'SYNC': {
        if (section.content.type === 'list') {
          manifest.sync = section.content.items.map(parseSyncEntry).filter((e): e is SyncEntry => e !== null);
        }
        break;
      }
      case 'CADENCE': {
        if (section.content.type === 'map') {
          manifest.cadence = section.content.entries.map(e => ({
            check: e.key,
            frequency: e.value,
          }));
        }
        break;
      }
      case 'METRICS': {
        if (section.content.type === 'map') {
          manifest.metrics = section.content.entries.map(e => ({
            key: e.key,
            path: e.value,
          }));
        }
        break;
      }
      case 'BUDGET': {
        if (section.content.type === 'map') {
          const maxTokens = section.content.entries.find(e => e.key === 'MAX_TOKENS');
          if (maxTokens) {
            const parsed = parseInt(maxTokens.value, 10);
            if (!isNaN(parsed)) {
              manifest.tokenBudget = parsed;
            }
          }
        }
        break;
      }
    }
  }

  return manifest;
}

/**
 * Parse a SYNC entry like:
 *   "governance.adf -> src/adf-read.ts"
 */
function parseSyncEntry(entry: string): SyncEntry | null {
  const match = entry.match(/^(.+?)\s*->\s*(.+)$/);
  if (!match) return null;
  return { source: match[1].trim(), target: match[2].trim() };
}

/**
 * Parse a single ON_DEMAND entry like:
 *   "frontend.adf (Triggers on: React, CSS, UI)"
 *   "frontend.adf (Triggers on: React, CSS, UI) [budget: 1200]"
 */
function parseTriggerEntry(entry: string): ManifestModule {
  // Extract optional [budget: N] suffix first
  let remaining = entry;
  let tokenBudget: number | undefined;
  const budgetMatch = remaining.match(/\s*\[budget\s*:\s*(\d+)\]\s*$/i);
  if (budgetMatch) {
    tokenBudget = parseInt(budgetMatch[1], 10);
    remaining = remaining.slice(0, budgetMatch.index!).trim();
  }

  const triggerMatch = remaining.match(/^(.+?)\s*\(Triggers?\s+on\s*:\s*(.+)\)\s*$/i);
  if (triggerMatch) {
    const path = triggerMatch[1].trim();
    const triggers = triggerMatch[2]
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0);
    const mod: ManifestModule = { path, triggers, loadPolicy: 'ON_DEMAND' };
    if (tokenBudget !== undefined) mod.tokenBudget = tokenBudget;
    return mod;
  }

  // No trigger syntax — just a path (possibly with budget)
  const mod: ManifestModule = { path: remaining.trim(), triggers: [], loadPolicy: 'ON_DEMAND' };
  if (tokenBudget !== undefined) mod.tokenBudget = tokenBudget;
  return mod;
}

// ============================================================================
// Module Resolution
// ============================================================================

/**
 * Resolve which modules to load given a manifest and task keywords.
 * Always includes defaultLoad modules; adds ON_DEMAND modules whose
 * triggers match any keyword (case-insensitive).
 */
export function resolveModules(manifest: Manifest, taskKeywords: string[]): string[] {
  const resolved = new Set<string>(manifest.defaultLoad);
  const lowerKeywords = taskKeywords.map(k => k.toLowerCase());

  for (const mod of manifest.onDemand) {
    for (const trigger of mod.triggers) {
      if (matchesTrigger(trigger, lowerKeywords)) {
        resolved.add(mod.path);
        break;
      }
    }
  }

  return [...resolved];
}

/**
 * Match a trigger against task keywords with prefix stemming.
 * Exact match always wins. Prefix match requires:
 *   - minimum 4 chars on the prefix
 *   - the prefix must be at least 75% of the longer string's length
 *     (avoids false positives like React → Reactive)
 */
function matchesTrigger(trigger: string, keywords: string[]): boolean {
  const t = trigger.toLowerCase();
  for (const k of keywords) {
    if (k === t) return true;
    if (t.length >= 4 && k.startsWith(t) && isPrefixStem(t, k)) return true;
    if (k.length >= 4 && t.startsWith(k) && isPrefixStem(k, t)) return true;
  }
  return false;
}

/** Check if prefix is plausibly a stem of the full word (≥66% length ratio). */
function isPrefixStem(prefix: string, full: string): boolean {
  return prefix.length / full.length >= 0.66;
}

// ============================================================================
// Bundle Merging
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
): BundleResult {
  const manifest = loadAndParseManifest(basePath, readFile);
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

function buildTriggerReport(
  manifest: Manifest,
  resolvedPaths: string[],
  taskKeywords: string[],
): BundleResult['triggerMatches'] {
  const matches: BundleResult['triggerMatches'] = [];
  const lowerKeywords = taskKeywords.map(k => k.toLowerCase());
  const defaultLoadSet = new Set(manifest.defaultLoad);

  for (const mod of manifest.onDemand) {
    for (const trigger of mod.triggers) {
      const t = trigger.toLowerCase();
      const matchedKeywords = lowerKeywords.filter(k => {
        if (k === t) return true;
        if (t.length >= 4 && k.startsWith(t) && isPrefixStem(t, k)) return true;
        if (k.length >= 4 && t.startsWith(k) && isPrefixStem(k, t)) return true;
        return false;
      });
      const isResolved = resolvedPaths.includes(mod.path);
      const isDefault = defaultLoadSet.has(mod.path);
      matches.push({
        module: mod.path,
        trigger,
        matched: isResolved,
        matchedKeywords,
        loadReason: isDefault ? 'default' : 'trigger',
      });
    }
  }
  return matches;
}

/**
 * Merge multiple ADF documents into one.
 * Duplicate section keys are merged: lists concatenated, texts joined,
 * maps concatenated, metrics concatenated.
 */
function mergeDocuments(docs: AdfDocument[]): AdfDocument {
  const sectionMap = new Map<string, AdfSection>();

  for (const doc of docs) {
    for (const section of doc.sections) {
      const existing = sectionMap.get(section.key);
      if (!existing) {
        // Deep clone to avoid mutation
        sectionMap.set(section.key, JSON.parse(JSON.stringify(section)));
      } else {
        mergeSectionContent(existing, section);
      }
    }
  }

  return {
    version: '0.1',
    sections: [...sectionMap.values()],
  };
}

function mergeSectionContent(target: AdfSection, source: AdfSection): void {
  if (target.content.type === 'list' && source.content.type === 'list') {
    target.content.items.push(...source.content.items);
  } else if (target.content.type === 'map' && source.content.type === 'map') {
    target.content.entries.push(...source.content.entries);
  } else if (target.content.type === 'text' && source.content.type === 'text') {
    if (target.content.value && source.content.value) {
      target.content.value = target.content.value + '\n' + source.content.value;
    } else if (source.content.value) {
      target.content.value = source.content.value;
    }
  } else if (target.content.type === 'metric' && source.content.type === 'metric') {
    target.content.entries.push(...source.content.entries);
  }
  // Mismatched types: keep target content as-is (first-wins)

  // Promote weight: if either is load-bearing, result is load-bearing
  if (source.weight === 'load-bearing' || target.weight === 'load-bearing') {
    target.weight = 'load-bearing';
  } else if (source.weight === 'advisory' && !target.weight) {
    target.weight = 'advisory';
  }
}

/**
 * Rough token estimate: ~4 chars per token for English text.
 */
function estimateTokens(doc: AdfDocument): number {
  let charCount = 0;
  for (const section of doc.sections) {
    charCount += section.key.length + 2; // key + colon + space
    switch (section.content.type) {
      case 'text':
        charCount += section.content.value.length;
        break;
      case 'list':
        for (const item of section.content.items) {
          charCount += item.length + 4; // dash + space + newline
        }
        break;
      case 'map':
        for (const entry of section.content.entries) {
          charCount += entry.key.length + entry.value.length + 4;
        }
        break;
      case 'metric':
        for (const entry of section.content.entries) {
          // key: value / ceiling [unit]
          charCount += entry.key.length + String(entry.value).length +
            String(entry.ceiling).length + entry.unit.length + 8;
        }
        break;
    }
  }
  return Math.ceil(charCount / 4);
}

function joinPath(base: string, relative: string): string {
  if (base.endsWith('/')) return base + relative;
  return base + '/' + relative;
}

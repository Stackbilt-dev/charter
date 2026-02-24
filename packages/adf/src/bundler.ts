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
    }
  }

  return manifest;
}

/**
 * Parse a single ON_DEMAND entry like:
 *   "frontend.adf (Triggers on: React, CSS, UI)"
 */
function parseTriggerEntry(entry: string): ManifestModule {
  const triggerMatch = entry.match(/^(.+?)\s*\(Triggers?\s+on\s*:\s*(.+)\)\s*$/i);
  if (triggerMatch) {
    const path = triggerMatch[1].trim();
    const triggers = triggerMatch[2]
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0);
    return { path, triggers, loadPolicy: 'ON_DEMAND' };
  }

  // No trigger syntax — just a path
  return { path: entry.trim(), triggers: [], loadPolicy: 'ON_DEMAND' };
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
      if (lowerKeywords.includes(trigger.toLowerCase())) {
        resolved.add(mod.path);
        break;
      }
    }
  }

  return [...resolved];
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
  readFile: (p: string) => string
): BundleResult {
  const manifest = loadAndParseManifest(basePath, readFile);
  const triggerMatches = buildTriggerReport(manifest, modulePaths);

  const documents: AdfDocument[] = [];
  for (const modPath of modulePaths) {
    const fullPath = joinPath(basePath, modPath);
    let content: string;
    try {
      content = readFile(fullPath);
    } catch {
      throw new AdfBundleError(`Module not found: ${modPath}`, modPath);
    }
    documents.push(parseAdf(content));
  }

  const merged = mergeDocuments(documents);
  const tokenEstimate = estimateTokens(merged);

  return {
    manifest,
    resolvedModules: modulePaths,
    mergedDocument: merged,
    tokenEstimate,
    triggerMatches,
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
  resolvedPaths: string[]
): BundleResult['triggerMatches'] {
  const matches: BundleResult['triggerMatches'] = [];
  for (const mod of manifest.onDemand) {
    for (const trigger of mod.triggers) {
      matches.push({
        module: mod.path,
        trigger,
        matched: resolvedPaths.includes(mod.path),
      });
    }
  }
  return matches;
}

/**
 * Merge multiple ADF documents into one.
 * Duplicate section keys are merged: lists concatenated, texts joined, maps concatenated.
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
  }
  // Mismatched types: keep target content as-is (first-wins)
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
    }
  }
  return Math.ceil(charCount / 4);
}

function joinPath(base: string, relative: string): string {
  if (base.endsWith('/')) return base + relative;
  return base + '/' + relative;
}

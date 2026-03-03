/**
 * ADF Manifest — parsing, trigger resolution, and module routing.
 *
 * Extracts structured manifest data from parsed ADF documents, resolves
 * which ON_DEMAND modules to load for a given task, and produces trigger
 * match reports for observability.
 */

import type {
  AdfDocument,
  Manifest,
  ManifestModule,
  SyncEntry,
  BundleResult,
} from './types';

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
 * Check if a single trigger matches a single keyword via exact or prefix stemming.
 * Prefix match requires minimum 4 chars and >=66% length ratio.
 */
export function isKeywordMatch(trigger: string, keyword: string): boolean {
  if (keyword === trigger) return true;
  if (trigger.length >= 4 && keyword.startsWith(trigger) && isPrefixStem(trigger, keyword)) return true;
  if (keyword.length >= 4 && trigger.startsWith(keyword) && isPrefixStem(keyword, trigger)) return true;
  return false;
}

/**
 * Match a trigger against task keywords with prefix stemming.
 */
function matchesTrigger(trigger: string, keywords: string[]): boolean {
  const t = trigger.toLowerCase();
  return keywords.some(k => isKeywordMatch(t, k));
}

/** Check if prefix is plausibly a stem of the full word (>=66% length ratio). */
function isPrefixStem(prefix: string, full: string): boolean {
  return prefix.length / full.length >= 0.66;
}

// ============================================================================
// Trigger Reporting
// ============================================================================

/**
 * Build a trigger match report for observability.
 * Shows which triggers matched which keywords and why each module was loaded.
 */
export function buildTriggerReport(
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
      const matchedKeywords = lowerKeywords.filter(k => isKeywordMatch(t, k));
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

/**
 * Content Classifier — rule-routing decision tree for ADF migration.
 *
 * Classifies markdown elements into ADF sections (CONSTRAINTS, CONTEXT, ADVISORY)
 * with STAY/MIGRATE routing decisions. Uses deterministic heuristics, no LLM calls.
 */

import type { MarkdownSection, MarkdownElement } from './markdown-parser';
import type { AdfDocument } from './types';

// ============================================================================
// Types
// ============================================================================

export type RouteDecision = 'STAY' | 'MIGRATE';

export type AdfTargetSection = 'CONSTRAINTS' | 'CONTEXT' | 'ADVISORY';

export type WeightTag = 'load-bearing' | 'advisory';

/** Module path → lowercase trigger keywords for content-based routing. */
export type TriggerMap = Record<string, string[]>;

/** Optional overrides for classification heuristics. */
export interface ClassifierConfig {
  stayPatterns?: RegExp[];
  headingRoutes?: Array<{ pattern: RegExp; module: string }>;
}

export interface ClassificationResult {
  decision: RouteDecision;
  targetSection: AdfTargetSection;
  targetModule: string;
  weight: WeightTag;
  reason: string;
}

export interface MigrationItem {
  element: MarkdownElement;
  sourceHeading: string;
  classification: ClassificationResult;
}

export interface MigrationPlan {
  items: MigrationItem[];
  stayItems: MigrationItem[];
  migrateItems: MigrationItem[];
  targetModules: string[];
  summary: {
    constraints: number;
    context: number;
    advisory: number;
    stay: number;
    total: number;
  };
}

// ============================================================================
// STAY Patterns — env/runtime content that should remain in vendor file
// ============================================================================

const STAY_PATTERNS: RegExp[] = [
  /\bWSL\b/i,
  /\bline.ending/i,
  /\bcredential.helper/i,
  /\b\/mnt\/c\//i,
  /\bwindows\b/i,
  /\bmingw/i,
  /\bPATH\s+issues?\s+in\s+WSL\b/i,
  /\bos[- ]specific\b/i,
  /\bshell[- ]specific\b/i,
];

// ============================================================================
// Classification Helpers
// ============================================================================

function matchesStayPattern(text: string, patterns: RegExp[] = STAY_PATTERNS): boolean {
  return patterns.some(p => p.test(text));
}

/**
 * Map a heading name to the most appropriate ADF target module.
 */
function headingToModule(heading: string, routes?: ClassifierConfig['headingRoutes']): string {
  const lower = heading.toLowerCase();

  if (routes) {
    for (const route of routes) {
      if (route.pattern.test(lower)) return route.module;
    }
    return 'core.adf';
  }

  if (/\b(design.system|ui|frontend|css|component|react|vue|svelte)\b/.test(lower)) {
    return 'frontend.adf';
  }
  if (/\b(api|backend|deploy|server|database|db|endpoint)\b/.test(lower)) {
    return 'backend.adf';
  }
  return 'core.adf';
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Content-based fallback routing. When heading-based routing returns core.adf,
 * scan element content against ON_DEMAND trigger keywords from the manifest.
 */
function contentToModule(text: string, triggerMap: TriggerMap): string {
  const lower = text.toLowerCase();
  for (const [module, triggers] of Object.entries(triggerMap)) {
    for (const trigger of triggers) {
      if (new RegExp(`\\b${escapeRegex(trigger)}\\b`, 'i').test(lower)) {
        return module;
      }
    }
  }
  return 'core.adf';
}

// ============================================================================
// Element Classification
// ============================================================================

/**
 * Classify a single markdown element into an ADF routing decision.
 */
export function classifyElement(
  element: MarkdownElement,
  heading: string,
  triggerMap?: TriggerMap,
  config?: ClassifierConfig,
): ClassificationResult {
  const text = element.content;
  let module = headingToModule(heading, config?.headingRoutes);

  // Content-based fallback: when heading routes to core.adf, check element
  // content against ON_DEMAND trigger keywords from the manifest.
  if (module === 'core.adf' && triggerMap) {
    module = contentToModule(text, triggerMap);
  }

  // Check STAY patterns first
  if (matchesStayPattern(text, config?.stayPatterns)) {
    return {
      decision: 'STAY',
      targetSection: 'CONTEXT',
      targetModule: module,
      weight: 'advisory',
      reason: 'Environment/runtime-specific (STAY in vendor file)',
    };
  }

  // Route by element type and strength
  switch (element.type) {
    case 'rule': {
      if (element.strength === 'imperative') {
        return {
          decision: 'MIGRATE',
          targetSection: 'CONSTRAINTS',
          targetModule: module,
          weight: 'load-bearing',
          reason: 'Imperative rule (NEVER/ALWAYS/MUST)',
        };
      }
      if (element.strength === 'advisory') {
        return {
          decision: 'MIGRATE',
          targetSection: 'ADVISORY',
          targetModule: module,
          weight: 'advisory',
          reason: 'Advisory rule (prefer/should/bias)',
        };
      }
      // Neutral rules — check heading context for more signal
      if (/\b(convention|style|naming|format)\b/i.test(heading)) {
        return {
          decision: 'MIGRATE',
          targetSection: 'CONSTRAINTS',
          targetModule: module,
          weight: 'advisory',
          reason: 'Naming/style convention',
        };
      }
      if (/\b(git|commit|workflow|hook)\b/i.test(heading)) {
        return {
          decision: 'MIGRATE',
          targetSection: 'CONSTRAINTS',
          targetModule: module,
          weight: 'load-bearing',
          reason: 'Git workflow rule',
        };
      }
      // Default neutral rule → CONSTRAINTS advisory
      return {
        decision: 'MIGRATE',
        targetSection: 'CONSTRAINTS',
        targetModule: module,
        weight: 'advisory',
        reason: 'Rule (neutral strength)',
      };
    }

    case 'code-block': {
      return {
        decision: 'MIGRATE',
        targetSection: 'CONTEXT',
        targetModule: module,
        weight: 'advisory',
        reason: element.language === 'bash' || element.language === 'sh'
          ? 'Build/tool commands'
          : 'Code reference',
      };
    }

    case 'table-row': {
      return {
        decision: 'MIGRATE',
        targetSection: 'CONTEXT',
        targetModule: module,
        weight: 'advisory',
        reason: 'Tabular reference data',
      };
    }

    case 'prose': {
      // Architecture descriptions → CONTEXT
      if (/\b(architect|depend|flow|package|modul|struct|layer)\b/i.test(text)) {
        return {
          decision: 'MIGRATE',
          targetSection: 'CONTEXT',
          targetModule: module,
          weight: 'advisory',
          reason: 'Architecture description',
        };
      }
      // Directory/config descriptions → CONTEXT
      if (/\b(director|config|\.charter|\.ai)\b/i.test(text)) {
        return {
          decision: 'MIGRATE',
          targetSection: 'CONTEXT',
          targetModule: module,
          weight: 'advisory',
          reason: 'Configuration/structure description',
        };
      }
      // Default prose → CONTEXT (never silently dropped)
      return {
        decision: 'MIGRATE',
        targetSection: 'CONTEXT',
        targetModule: module,
        weight: 'advisory',
        reason: 'Informational context',
      };
    }
  }
}

// ============================================================================
// Deduplication
// ============================================================================

/**
 * Check if two text items are duplicates using Jaccard similarity.
 * Threshold: 0.8 (80% word overlap = duplicate).
 */
export function isDuplicateItem(existing: string, candidate: string): boolean {
  const setA = new Set(tokenize(existing));
  const setB = new Set(tokenize(candidate));

  if (setA.size === 0 && setB.size === 0) return true;
  if (setA.size === 0 || setB.size === 0) return false;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 && intersection / union >= 0.8;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
}

// ============================================================================
// Migration Plan Builder
// ============================================================================

/**
 * Build a complete migration plan from parsed markdown sections.
 *
 * If existingAdf is provided, uses Jaccard dedup to skip items already present.
 */
export function buildMigrationPlan(
  sections: MarkdownSection[],
  existingAdf?: AdfDocument,
  triggerMap?: TriggerMap,
  config?: ClassifierConfig,
): MigrationPlan {
  const items: MigrationItem[] = [];

  // Collect existing ADF content for dedup
  const existingItems = new Set<string>();
  if (existingAdf) {
    for (const section of existingAdf.sections) {
      if (section.content.type === 'list') {
        for (const item of section.content.items) {
          existingItems.add(item);
        }
      } else if (section.content.type === 'text') {
        existingItems.add(section.content.value);
      }
    }
  }

  for (const section of sections) {
    for (const element of section.elements) {
      const classification = classifyElement(element, section.heading, triggerMap, config);

      // Dedup against existing ADF
      if (classification.decision === 'MIGRATE' && existingItems.size > 0) {
        const isDup = [...existingItems].some(existing =>
          isDuplicateItem(existing, element.content)
        );
        if (isDup) {
          // Still track as STAY (already migrated)
          items.push({
            element,
            sourceHeading: section.heading,
            classification: {
              ...classification,
              decision: 'STAY',
              reason: 'Already exists in ADF (deduplicated)',
            },
          });
          continue;
        }
      }

      items.push({
        element,
        sourceHeading: section.heading,
        classification,
      });
    }
  }

  const stayItems = items.filter(i => i.classification.decision === 'STAY');
  const migrateItems = items.filter(i => i.classification.decision === 'MIGRATE');
  const targetModules = [...new Set(migrateItems.map(i => i.classification.targetModule))];

  return {
    items,
    stayItems,
    migrateItems,
    targetModules,
    summary: {
      constraints: migrateItems.filter(i => i.classification.targetSection === 'CONSTRAINTS').length,
      context: migrateItems.filter(i => i.classification.targetSection === 'CONTEXT').length,
      advisory: migrateItems.filter(i => i.classification.targetSection === 'ADVISORY').length,
      stay: stayItems.length,
      total: items.length,
    },
  };
}

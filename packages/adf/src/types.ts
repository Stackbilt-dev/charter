/**
 * ADF (Attention-Directed Format) AST types.
 *
 * Defines the canonical data model for ADF documents, patch operations,
 * manifest routing, and bundle output.
 */

// ============================================================================
// AST Types
// ============================================================================

export interface AdfDocument {
  version: '0.1';
  sections: AdfSection[];
}

export interface AdfSection {
  key: string;
  decoration: string | null;
  content: AdfContent;
  weight?: 'load-bearing' | 'advisory';
}

export type AdfContent =
  | { type: 'text'; value: string }
  | { type: 'list'; items: string[] }
  | { type: 'map'; entries: AdfMapEntry[] }
  | { type: 'metric'; entries: AdfMetricEntry[] };

export interface AdfMapEntry {
  key: string;
  value: string;
}

export interface AdfMetricEntry {
  key: string;
  value: number;
  ceiling: number;
  unit: string;
}

// ============================================================================
// Standard Decorations
// ============================================================================

export const STANDARD_DECORATIONS: Record<string, string> = {
  TASK: '\u{1F3AF}',
  ROLE: '\u{1F9D1}',
  CONTEXT: '\u{1F4CB}',
  OUTPUT: '\u{2705}',
  CONSTRAINTS: '\u{26A0}\u{FE0F}',
  RULES: '\u{1F4D0}',
  DEFAULT_LOAD: '\u{1F4E6}',
  ON_DEMAND: '\u{1F4C2}',
  FILES: '\u{1F5C2}\u{FE0F}',
  TOOLS: '\u{1F6E0}\u{FE0F}',
  RISKS: '\u{1F6A8}',
  STATE: '\u{1F9E0}',
  BUDGET: '\u{1F4B0}',
  SYNC: '\u{1F504}',
  CADENCE: '\u{1F4CA}',
};

export const CANONICAL_KEY_ORDER: string[] = [
  'TASK',
  'ROLE',
  'CONTEXT',
  'OUTPUT',
  'CONSTRAINTS',
  'RULES',
  'DEFAULT_LOAD',
  'ON_DEMAND',
  'BUDGET',
  'SYNC',
  'CADENCE',
  'FILES',
  'TOOLS',
  'RISKS',
  'STATE',
];

// ============================================================================
// Patch Operations (Discriminated Union)
// ============================================================================

export interface AddBulletOp {
  op: 'ADD_BULLET';
  section: string;
  value: string;
}

export interface ReplaceBulletOp {
  op: 'REPLACE_BULLET';
  section: string;
  index: number;
  value: string;
}

export interface RemoveBulletOp {
  op: 'REMOVE_BULLET';
  section: string;
  index: number;
}

export interface AddSectionOp {
  op: 'ADD_SECTION';
  key: string;
  decoration?: string | null;
  content: AdfContent;
  weight?: 'load-bearing' | 'advisory';
}

export interface ReplaceSectionOp {
  op: 'REPLACE_SECTION';
  key: string;
  content: AdfContent;
}

export interface RemoveSectionOp {
  op: 'REMOVE_SECTION';
  key: string;
}

export interface UpdateMetricOp {
  op: 'UPDATE_METRIC';
  section: string;
  key: string;
  value: number;
}

export type PatchOperation =
  | AddBulletOp
  | ReplaceBulletOp
  | RemoveBulletOp
  | AddSectionOp
  | ReplaceSectionOp
  | RemoveSectionOp
  | UpdateMetricOp;

// ============================================================================
// Manifest Types
// ============================================================================

export interface Manifest {
  version: '0.1';
  role?: string;
  defaultLoad: string[];
  onDemand: ManifestModule[];
  rules: string[];
  tokenBudget?: number;
  sync: SyncEntry[];
  cadence: CadenceEntry[];
}

export interface SyncEntry {
  source: string;
  target: string;
}

export interface ManifestModule {
  path: string;
  triggers: string[];
  loadPolicy: 'DEFAULT' | 'ON_DEMAND';
  tokenBudget?: number;
}

export interface CadenceEntry {
  check: string;
  frequency: string;
}

// ============================================================================
// Bundle Output
// ============================================================================

export interface BundleResult {
  manifest: Manifest;
  resolvedModules: string[];
  mergedDocument: AdfDocument;
  tokenEstimate: number;
  tokenBudget: number | null;
  tokenUtilization: number | null;
  perModuleTokens: Record<string, number>;
  moduleBudgetOverruns: Array<{
    module: string;
    tokens: number;
    budget: number;
  }>;
  triggerMatches: Array<{
    module: string;
    trigger: string;
    matched: boolean;
  }>;
}

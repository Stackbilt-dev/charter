/**
 * Shared types for the Charter scenario harness.
 */

// ============================================================================
// Scenario Definition
// ============================================================================

export interface ManifestOnDemandEntry {
  path: string;
  triggers: string[];
}

export interface ScenarioManifest {
  onDemand: ManifestOnDemandEntry[];
}

/**
 * A single "session" — one injection of CLAUDE.md content plus the
 * expected routing outcome (module → item count).
 */
export interface Session {
  label: string;
  inject: string;
  /** Expected routing: module filename → number of items that should route there */
  expected: Record<string, number>;
}

export interface Scenario {
  id: string;
  archetype: 'worker' | 'backend' | 'fullstack' | 'frontend';
  description: string;
  manifest: ScenarioManifest;
  sessions: Session[];
}

// ============================================================================
// Tidy Command Output (from `charter adf tidy --dry-run --format json`)
// ============================================================================

export interface TidyFileResult {
  file: string;
  status: 'clean' | 'tidied' | 'not-found';
  itemsExtracted: number;
  routing: Record<string, number>;
}

export interface ModuleSizeWarning {
  module: string;
  section: string;
  itemCount: number;
}

export interface TidyOutput {
  dryRun: boolean;
  files: TidyFileResult[];
  totalExtracted: number;
  modulesModified: string[];
  moduleWarnings: ModuleSizeWarning[];
}

// ============================================================================
// Evaluation
// ============================================================================

export type RouteVerdict = 'correct' | 'under' | 'over' | 'missing';

export interface ModuleEval {
  module: string;
  expected: number;
  actual: number;
  verdict: RouteVerdict;
}

export interface SessionResult {
  sessionLabel: string;
  totalExpected: number;
  totalActual: number;
  moduleEvals: ModuleEval[];
  /** Items extracted but routed to an unexpected module */
  unexpectedModules: string[];
  pass: boolean;
}

export interface ScenarioResult {
  scenarioId: string;
  archetype: string;
  description: string;
  sessions: SessionResult[];
  staticAudit?: StaticScenarioAudit;
  pass: boolean;
}

export interface StaticSessionAudit {
  sessionLabel: string;
  dryRunExtracted: number;
  appliedModulesModified: string[];
  claudeRestored: boolean;
  adfTotalItems: number;
  modulesGrew: string[];
  itemRoutes: StaticItemRoute[];
}

export interface StaticScenarioAudit {
  sessions: StaticSessionAudit[];
  accumulationIssues: string[];
}

export interface StaticItemRoute {
  heading: string;
  content: string;
  headingModule: string;
  targetModule: string;
  targetSection: string;
  decision: 'STAY' | 'MIGRATE';
  reason: string;
  matchedTriggers: string[];
  matchScore: number;
}

// ============================================================================
// Run Report
// ============================================================================

export interface HarnessReport {
  runAt: string;
  cliBin: string;
  totalScenarios: number;
  totalSessions: number;
  passed: number;
  failed: number;
  scenarios: ScenarioResult[];
}

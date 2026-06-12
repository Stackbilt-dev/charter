/**
 * @stackbilt/types — Shared type definitions for the Charter
 *
 * These types are extracted from the Charter Cloud platform and represent
 * the portable governance data model. Cloud-specific types (Env, D1, Durable Objects)
 * are intentionally excluded.
 */

// ============================================================================
// Core Enums & Literals
// ============================================================================

export type AppMode = 'GOVERNANCE' | 'STRATEGY' | 'DRAFTER' | 'RED_TEAM' | 'BRIEF';

export type LedgerEntryType = 'RULING' | 'ADR' | 'POLICY' | 'SOP' | 'STRATEGIC' | 'REVIEW' | 'NOTARY_STAMP';
export type LedgerStatus = 'ACTIVE' | 'SUPERSEDED' | 'ARCHIVED';
export type LedgerSourceMode = 'PRODUCT' | 'UX' | 'RISK' | 'ARCHITECT' | 'TDD' | 'SPRINT';

export type PatternStatus = 'ACTIVE' | 'DEPRECATED' | 'EVALUATING';
export type PatternCategory = 'COMPUTE' | 'DATA' | 'INTEGRATION' | 'SECURITY' | 'ASYNC';

export type RequestStatus = 'SUBMITTED' | 'QUEUED' | 'IN_REVIEW' | 'RESOLVED' | 'BLOCKED' | 'DEFERRED';
export type RequestType = 'FEATURE_APPROVAL' | 'ARCHITECTURE_REVIEW' | 'POLICY_QUESTION' | 'EXCEPTION_REQUEST' | 'TOOL_EVALUATION';
export type Domain = 'ARCHITECTURE' | 'DATA' | 'STANDARDS' | 'SECURITY' | 'STRATEGY';
export type Urgency = 'LOW' | 'STANDARD' | 'ELEVATED' | 'CRITICAL';
export type Complexity = 'TRIVIAL' | 'SIMPLE' | 'MODERATE' | 'COMPLEX' | 'EPIC';

// ============================================================================
// Validation Types
// ============================================================================

export type ValidationStatus = 'PASS' | 'WARN' | 'FAIL';
export type ChangeType = 'ARCHITECTURE' | 'SECURITY' | 'DATA' | 'API' | 'DEPENDENCY';
export type ADRRequirementType = 'MUST_REFERENCE' | 'SHOULD_REFERENCE';
export type PatternAlignmentStatus = 'ALIGNED' | 'REVIEW_NEEDED' | 'VIOLATION';

export interface ValidationRequest {
  service: string;
  change: string;
  context?: string;
  projectId?: string;
  changeType?: ChangeType;
}

export interface RuleEvaluation {
  name: string;
  status: ValidationStatus;
  reason: string;
}

export interface RequiredADR {
  id: string;
  title: string;
  type: ADRRequirementType;
}

export interface PatternEvaluation {
  name: string;
  category: string;
  status: PatternAlignmentStatus;
}

export interface ValidationResult {
  status: ValidationStatus;
  summary: string;
  rules: RuleEvaluation[];
  requiredADRs: RequiredADR[];
  patterns: PatternEvaluation[];
  reasoning: string;
  timestamp: string;
  evaluationId: string;
}

// ============================================================================
// Data Model Interfaces
// ============================================================================

export interface QualityMetadata {
  specificity_score: number;
  rubric_version: string;
}

export interface NotaryStamp {
  stamp_id: string;
  ledger_ids: string[];
  issued_at: string;
  policy_hash: string;
  signature: string;
}

export interface Pattern {
  id: string;
  name: string;
  category: string;
  blessedSolution: string;
  rationale: string | null;
  antiPatterns: string | null;
  documentationUrl: string | null;
  relatedLedgerId: string | null;
  status: PatternStatus;
  createdAt: string;
  projectId: string | null;
}

export interface LedgerEntry {
  id: string;
  entryType: LedgerEntryType;
  sourceMode: LedgerSourceMode;
  title: string;
  summary: string | null;
  inputExcerpt: string | null;
  output: string;
  tags: string[];
  status: LedgerStatus;
  createdAt: string;
  projectId: string | null;
  artifactHash?: string | null;
  qualityMetadata?: QualityMetadata | null;
  stamp?: NotaryStamp | null;
}

export interface GovernanceRequest {
  id: string;
  title: string;
  description: string | null;
  requestType: RequestType;
  domain: Domain;
  status: RequestStatus;
  urgency: Urgency;
  complexity: Complexity;
  requester: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  projectId: string | null;
}

export interface Protocol {
  id: string;
  title: string;
  description: string;
  content: string;
  createdAt: string;
  projectId: string | null;
}

// ============================================================================
// Git Validation Types
// ============================================================================

export type GitValidationStatus = 'PASS' | 'WARN' | 'FAIL';
export type CommitRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface GitCommit {
  sha: string;
  message: string;
  author: string;
  timestamp: string;
  files_changed?: string[];
}

export interface GitPRMetadata {
  number: number;
  title: string;
  base_branch: string;
  head_branch: string;
  html_url: string;
}

export interface GitRepository {
  owner: string;
  name: string;
  full_name: string;
}

export interface GovernedByTrailer {
  commit_sha: string;
  reference: string;
  valid: boolean;
  resolved_id: string | null;
  ledger_entry_id: string | null;
  error?: string;
}

export interface ResolvesRequestTrailer {
  commit_sha: string;
  reference: string;
  valid: boolean;
  resolved_id: string | null;
  request_id: string | null;
  request_status?: string;
  error?: string;
}

export interface UnlinkedCommit {
  sha: string;
  short_sha: string;
  message_first_line: string;
  risk_level: CommitRiskLevel;
  suggestion: string | null;
}

export interface GitValidationTrailers {
  governed_by: GovernedByTrailer[];
  resolves_request: ResolvesRequestTrailer[];
}

export interface GitValidationMetadata {
  commits_analyzed: number;
  trailers_found: number;
  validation_timestamp: string;
  project_id: string;
}

export interface GitValidationResponse {
  status: GitValidationStatus;
  validation_id: string;
  summary: string;
  trailers: GitValidationTrailers;
  unlinked_commits: UnlinkedCommit[];
  suggestions: string[];
  metadata: GitValidationMetadata;
}

// ============================================================================
// Change Classification Types
// ============================================================================

export type ChangeSubjectType = 'PR' | 'SPEC' | 'FEATURE' | 'REFACTOR' | 'MIGRATION';
export type ChangeClass = 'SURFACE' | 'LOCAL' | 'CROSS_CUTTING';
export type GovernanceStatus = 'CLEAR' | 'VIOLATION' | 'NEEDS_REVIEW';
export type ChangeRecommendation = 'APPROVE' | 'APPROVE_WITH_MITIGATIONS' | 'REJECT' | 'ESCALATE';

export interface ChangeClassification {
  id: string;
  subjectType: ChangeSubjectType;
  subjectReference: string | null;
  subjectSummary: string;
  changeClass: ChangeClass;
  affectedSystems: string[];
  affectedCount: number;
  policyViolations: string[];
  governanceStatus: GovernanceStatus;
  temporalAnalysisId: string | null;
  recommendation: ChangeRecommendation;
  mitigations: string[];
  rationale: string | null;
  projectId: string | null;
  createdAt: string;
}

// ============================================================================
// Experiment Types
// ============================================================================

export type ExperimentStatus = 'PROPOSED' | 'APPROVED' | 'RUNNING' | 'REVIEWING' | 'PROMOTED' | 'REJECTED' | 'ARCHIVED';
export type ProductionImpact = 'NONE' | 'READ_ONLY' | 'ISOLATED';

export interface ChangePackage {
  context: string;
  rationale: string;
  proposedChanges: string[];
  acceptanceCriteria: string[];
  rollbackPlan: string;
  affectedSystems: string[];
}

export interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  successCriteria: string | null;
  status: ExperimentStatus;
  sandboxScope: string[] | null;
  productionImpact: ProductionImpact;
  resultsSummary: string | null;
  whatWorked: string | null;
  whatFailed: string | null;
  changePackage: ChangePackage | null;
  rollbackPlan: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string | null;
}

// ============================================================================
// Decision Learning Types
// ============================================================================

export type DecisionBranchType = 'APPROVAL' | 'REJECTION' | 'ALTERNATIVE_CHOSEN' | 'CONSTRAINT_APPLIED' | 'GUARDRAIL_TRIGGERED';

export interface Precedent {
  id: string;
  decisionBranchId: string;
  branchType: DecisionBranchType;
  description: string;
  rationale: string | null;
  constitutionalCitation: string | null;
  toolName: string;
  domain: string | null;
  similarity: number;
  createdAt: string;
}

// ============================================================================
// LLM Provider Interface (Bridge Contract)
// ============================================================================

export interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}

export interface LLMResponse {
  text: string;
  provider: string;
  model: string;
}

export interface LLMProvider {
  name: string;
  generate(request: LLMRequest): Promise<string>;
}

// ============================================================================
// Drift Scanner Types
// ============================================================================

export interface DriftViolation {
  file: string;
  line: number;
  snippet: string;
  patternName: string;
  antiPattern: string;
  severity: 'BLOCKER' | 'CRITICAL' | 'MAJOR' | 'MINOR';
}

export interface DriftReport {
  score: number;
  violations: DriftViolation[];
  scannedFiles: number;
  scannedPatterns: number;
  timestamp: string;
}

// ============================================================================
// Tiered Execution Contract (#201)
//
// Formalizes the tier-system pattern that appears independently across charter
// (CommitRiskLevel, ChangeClass, AppMode, Urgency, Complexity) and colonyos
// (cognitive-law tiers) and llm-providers (model-catalog tiers). Naming and
// contracting it here lets new tier systems be verified at type-check time.
//
// Invariants (TierSelector):
//   1. Deterministic — same input always yields the same tier
//   2. Caller-overridable — an explicit hint takes precedence over inference
//   3. Tier selection occurs before constraint application, never post-hoc
//   4. Transitions are observable (onTransition is emitted on tier change)
//   5. All declared tiers are reachable — no dead tiers in TierDefinition.tiers
//
// DegradationPolicy invariants (opt-in extension for health-signal-driven tiers):
//   1. Degradation is immediate — signal detected → tier applied same tick
//   2. Recovery is asymmetric — one step at a time, recoveryTicks stable ticks
//   3. Ceiling bounded externally — implementations must never self-grant a higher ceiling
// ============================================================================

/** What a tier constrains and the semantic description of that constraint. */
export interface TierConstraint {
  /** Natural language description of what governance behavior this tier constrains. */
  description: string;
}

/**
 * Declares a tier system: its named tiers in ascending severity order,
 * semantic descriptions, per-tier constraints, and composition mode.
 *
 * @typeParam T - The union type of valid tier values (string literals).
 */
export interface TierDefinition<T extends string> {
  /** Human-readable name of this tier system, e.g. 'CommitRiskLevel'. */
  name: string;
  /** Ordered tier values, lowest severity first. All values must be reachable. */
  tiers: readonly T[];
  /** Semantic description for each tier. */
  descriptions: Readonly<Record<T, string>>;
  /** What each tier constrains. */
  constraints: Readonly<Record<T, TierConstraint>>;
  /** 'absolute' — tier overrides; 'additive' — tiers stack cumulatively. */
  mode: 'additive' | 'absolute';
}

/**
 * Selection contract for a tier system.
 * Implementations must be deterministic and caller-overridable.
 *
 * @typeParam T     - The union type of valid tier values.
 * @typeParam Input - The input from which the tier is inferred.
 */
export interface TierSelector<T extends string, Input> {
  /**
   * Select a tier from input. Deterministic: same input → same tier.
   * When hint is provided it takes precedence over inference.
   */
  select(input: Input, hint?: T): T;
  /** Optional observer called when the active tier transitions. */
  onTransition?: (from: T, to: T, reason: string) => void;
}

/**
 * Extension of TierSelector for health-signal-driven degradation.
 * Opt-in — only systems driven by signal counts need this.
 * Reference implementation: colonyos cognitive-law.ts
 */
export interface DegradationPolicy<T extends string> extends TierSelector<T, number> {
  /** Degrade to the tier appropriate for signalCount. Immediate — same tick. */
  degrade(signalCount: number): T;
  /** Consecutive stable ticks required to recover one tier. Asymmetric recovery. */
  readonly recoveryTicks: number;
  /** Externally-configured ceiling — implementations must never self-grant above this. */
  readonly ceiling: T;
  /** Floor — minimum tier regardless of signal count. */
  readonly floor: T;
}

// ============================================================================
// TierDefinition constants for charter's built-in tier systems
// ============================================================================

export const APP_MODE_TIERS: TierDefinition<AppMode> = {
  name: 'AppMode',
  tiers: ['BRIEF', 'DRAFTER', 'STRATEGY', 'RED_TEAM', 'GOVERNANCE'],
  descriptions: {
    BRIEF:      'Executive summary — condensed context, low verbosity',
    DRAFTER:    'Content authoring — proposal and document generation',
    STRATEGY:   'Strategic planning — roadmap and initiative framing',
    RED_TEAM:   'Adversarial review — challenge assumptions and find gaps',
    GOVERNANCE: 'Governance enforcement — policy check and compliance gate',
  },
  constraints: {
    BRIEF:      { description: 'Minimal toolset; response length capped' },
    DRAFTER:    { description: 'Drafting tools enabled; no enforcement gates' },
    STRATEGY:   { description: 'Strategy tools enabled; advisory posture' },
    RED_TEAM:   { description: 'Adversarial tools enabled; challenge posture' },
    GOVERNANCE: { description: 'Full policy toolset; enforcement gates active' },
  },
  mode: 'absolute',
};

export const URGENCY_TIERS: TierDefinition<Urgency> = {
  name: 'Urgency',
  tiers: ['LOW', 'STANDARD', 'ELEVATED', 'CRITICAL'],
  descriptions: {
    LOW:      'Routine — no SLA pressure; batch with next scheduled review',
    STANDARD: 'Standard queue — normal review cadence applies',
    ELEVATED: 'Elevated priority — review within one business day',
    CRITICAL: 'Immediate escalation — blocks release or production safety',
  },
  constraints: {
    LOW:      { description: 'Deferred to next review cycle' },
    STANDARD: { description: 'Normal prioritization queue' },
    ELEVATED: { description: 'Fast-tracked; skip standard queue' },
    CRITICAL: { description: 'Immediate human escalation required' },
  },
  mode: 'absolute',
};

export const COMPLEXITY_TIERS: TierDefinition<Complexity> = {
  name: 'Complexity',
  tiers: ['TRIVIAL', 'SIMPLE', 'MODERATE', 'COMPLEX', 'EPIC'],
  descriptions: {
    TRIVIAL:  'Typo, formatting, or comment change; no logic affected',
    SIMPLE:   'Single-file change; bounded, self-contained logic',
    MODERATE: 'Cross-file change within one package',
    COMPLEX:  'Cross-package change; interface or contract modification',
    EPIC:     'Cross-system or cross-repo change; architecture-level impact',
  },
  constraints: {
    TRIVIAL:  { description: 'Self-review sufficient; no governance trailer needed' },
    SIMPLE:   { description: 'Self-review sufficient; governance trailer recommended' },
    MODERATE: { description: 'Peer review required; governance trailer required' },
    COMPLEX:  { description: 'Committee review required; ADR may be needed' },
    EPIC:     { description: 'Architecture review required; ADR mandatory' },
  },
  mode: 'absolute',
};

export const CHANGE_CLASS_TIERS: TierDefinition<ChangeClass> = {
  name: 'ChangeClass',
  tiers: ['SURFACE', 'LOCAL', 'CROSS_CUTTING'],
  descriptions: {
    SURFACE:      'UI, style, docs, or test-only changes; no business logic affected',
    LOCAL:        'Logic change scoped to a single package or subsystem',
    CROSS_CUTTING: 'Change that crosses package or service boundaries',
  },
  constraints: {
    SURFACE:      { description: 'No governance review gate; self-certify' },
    LOCAL:        { description: 'Standard governance trailer required' },
    CROSS_CUTTING: { description: 'Committee review and ADR required' },
  },
  mode: 'absolute',
};

export const COMMIT_RISK_TIERS: TierDefinition<CommitRiskLevel> = {
  name: 'CommitRiskLevel',
  tiers: ['LOW', 'MEDIUM', 'HIGH'],
  descriptions: {
    LOW:    'Docs, tests, tooling — no production logic changed',
    MEDIUM: 'Feature or dependency change — standard governance applies',
    HIGH:   'Auth, security, schema, or API surface change',
  },
  constraints: {
    LOW:    { description: 'Governance trailer optional' },
    MEDIUM: { description: 'Governance trailer required (Governed-By or Resolves-Request)' },
    HIGH:   { description: 'Governance trailer required; human review mandatory' },
  },
  mode: 'absolute',
};

// ============================================================================
// Authority-Gated Governance Contract (#200)
//
// Formalizes the propose→gate→commit invariant that emerges across governed
// systems. The pattern has appeared independently in charter (dryRun flag on
// applyPolicies) and colonyos (override_decision / autonomy_ceiling). Naming
// and contracting it here makes the invariants enforceable at type-check time.
//
// Invariants:
//   1. propose() is always called before commit() — the gate cannot be bypassed
//   2. propose() is idempotent for the same input state
//   3. commit('dismiss') leaves state unchanged
//   4. Every commit() emits a GovernanceReceipt — auditability is non-optional
//   5. Autonomy ceiling is externally set; implementations must never self-grant
// ============================================================================

export type GovernanceDecision = 'approve' | 'override' | 'dismiss';

export interface GovernanceProposal {
  /** Stable, deterministic ID for the same input state. */
  readonly id: string;
  /** True when the target is already in the desired state — commit would be a no-op. */
  readonly alreadyCompliant: boolean;
  /** Human-readable description of what would change on approve/override. */
  readonly delta: readonly string[];
  /** Optional Unix timestamp (ms) after which the proposal should be re-evaluated. */
  readonly expires?: number;
}

export interface GovernanceReceipt {
  readonly proposalId: string;
  readonly decision: GovernanceDecision;
  /** Unix timestamp (ms) when the commit was executed. */
  readonly committedAt: number;
}

/**
 * Authority-gated governance contract.
 *
 * @typeParam Context - Input to propose() that scopes the evaluation (e.g. a repo path).
 * @typeParam P - Concrete proposal type; defaults to GovernanceProposal. Implementations
 *   may extend GovernanceProposal to carry context needed for the commit phase.
 */
export interface GovernanceGate<Context, P extends GovernanceProposal = GovernanceProposal> {
  /** Phase 1: evaluate without committing. Must be idempotent for the same input state. */
  propose(context: Context): Promise<P>;
  /**
   * Phase 2: authorized actor commits a proposal.
   * - 'approve': apply the proposed changes
   * - 'override': apply despite compliance (force re-stamp)
   * - 'dismiss': leave state unchanged; receipt still emitted
   */
  commit(proposal: P, decision: GovernanceDecision): Promise<GovernanceReceipt>;
}

// ============================================================================
// Package Ecosystem Contract (#90)
//
// Decentralized extension point: each ecosystem package that wants to
// participate in charter init / scaffold / doctor / adf populate ships a
// CharterPackageDescriptor in its own npm package. Charter loads descriptors
// at runtime — it never hard-codes a registry of known packages here.
// ============================================================================

/**
 * Minimal schema-validator shape that CharterPackageDescriptor.configSchema must
 * satisfy. Structurally compatible with z.ZodType<T> (Zod) so callers can pass
 * a Zod schema directly without importing Zod into @stackbilt/types.
 */
export interface SchemaValidator<T = unknown> {
  parse(input: unknown): T;
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown };
}

/**
 * Doctor check registered by a package. Charter runs these during `charter doctor`
 * for every enabled package.
 */
export interface PackageDoctorCheck {
  /** Short display name shown in doctor output. */
  name: string;
  /**
   * Returns null if the check passes, or a human-readable failure message.
   * Receives the validated package-specific config object.
   */
  run(config: unknown, repoPath: string): Promise<string | null>;
}

/**
 * Descriptor that an ecosystem package ships to participate in Charter's
 * orchestration (init, scaffold, doctor, adf populate, serve).
 *
 * Descriptors are authored in the package repo — NOT in Charter. Charter
 * loads them by resolving `require('<npmPackage>/charter-descriptor')` at
 * runtime (when the package is installed in the target project).
 *
 * @typeParam C - Validated config shape. Must match `configSchema`.
 */
export interface CharterPackageDescriptor<C = unknown> {
  /** Canonical npm package name. Used for installation guidance and deduplication. */
  readonly name: string;
  /** One-line description shown in `charter init` package selection UI. */
  readonly description: string;
  /** npm package name (may differ from `name` if scoped). */
  readonly npmPackage: string;
  /**
   * Schema validator for the per-project config block stored in
   * `.charter/config.json` under `packages[name].config`.
   * Use a Zod schema (structurally satisfies SchemaValidator<C>).
   */
  readonly configSchema: SchemaValidator<C>;
  /**
   * Template file paths to generate during `charter scaffold`.
   * Relative to the package's own directory — Charter resolves them at
   * runtime via `require.resolve`.
   */
  readonly scaffoldTemplates?: readonly string[];
  /**
   * Path to an ADF module file within the package to inject during
   * `charter adf populate`. Relative to the package root.
   */
  readonly adfModule?: string;
  /** Doctor checks this package contributes. */
  readonly doctorChecks?: readonly PackageDoctorCheck[];
  /**
   * wrangler.toml binding names this package requires (e.g. `["AI", "MY_KV"]`).
   * Charter reports missing bindings during `charter doctor`.
   */
  readonly wranglerBindings?: readonly string[];
}

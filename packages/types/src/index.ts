/**
 * @charter/types — Shared type definitions for the Charter
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

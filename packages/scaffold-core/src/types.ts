/**
 * @stackbilt/scaffold-core — Shared type definitions
 *
 * Zero-dependency, zero-inference, zero-network. All types used across
 * classify/, knowledge/, governance/, codegen/, and materializer/ live here.
 */

// ============================================================================
// Pattern types
// ============================================================================

export type PatternName =
  | 'worker'
  | 'workers-saas'
  | 'api'
  | 'fullstack'
  | 'scheduled'
  | 'durable-object'
  | 'queue-consumer'
  | 'mcp-server'
  | 'email-worker'
  | 'browser-automation';

export type PatternStatus = 'ACTIVE' | 'DEPRECATED' | 'EVALUATING';
export type PatternCategory = 'COMPUTE' | 'DATA' | 'INTEGRATION' | 'SECURITY' | 'ASYNC';

export interface PatternDef {
  name: PatternName;
  status: PatternStatus;
  category: PatternCategory;
  keywords: string[];
  traits: string[];
}

// ============================================================================
// Classification types
// ============================================================================

export interface ClassifyResult {
  pattern: PatternName;
  confidence: number;
  traits: string[];
  qualityProfile: QualityProfile;
  enrichedIntention: string;
}

export interface QualityProfile {
  testingLevel: 'basic' | 'standard' | 'thorough';
  observability: boolean;
  authentication: boolean;
  rateLimiting: boolean;
  piiHandling: boolean;
  complianceDomains: Array<'PHI' | 'PCI' | 'PII' | 'telephony'>;
}

// ============================================================================
// Scaffold binding types
// ============================================================================

export interface ScaffoldBinding {
  type: 'KV' | 'D1' | 'R2' | 'QUEUE' | 'DO' | 'SERVICE' | 'AI' | 'EMAIL';
  name: string;
  binding: string;
}

// ============================================================================
// Knowledge types
// ============================================================================

export interface ThreatEntry {
  id: string;
  category: string;
  description: string;
  mitigation: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface PatternKnowledge {
  threats: ThreatEntry[];
  adrContext: string;
  adrDecision: string;
  domainThreats: ThreatEntry[];
}

// ============================================================================
// Governance types
// ============================================================================

export interface GovernanceDocs {
  threatModel: string;
  adr001: string;
  adr002?: string;
  testPlan: string;
}

// ============================================================================
// Codegen types
// ============================================================================

export type FileRole = 'entry' | 'config' | 'test' | 'migration' | 'contract' | 'adf' | 'readme';

export interface ScaffoldFile {
  path: string;
  content: string;
  role: FileRole;
}

// ============================================================================
// Materializer types
// ============================================================================

export interface ScaffoldFacts {
  pattern: PatternName;
  projectName: string;
  intention: string;
  bindings: ScaffoldBinding[];
  traits: string[];
  qualityProfile: QualityProfile;
}

export interface MaterializerResult {
  files: ScaffoldFile[];
  facts: ScaffoldFacts;
}

// ============================================================================
// Top-level result + options
// ============================================================================

export interface LocalScaffoldResult {
  classification: ClassifyResult;
  knowledge: PatternKnowledge;
  governance: GovernanceDocs;
  files: ScaffoldFile[];
  facts: ScaffoldFacts;
  /** Promoted from classification.traits for convenient top-level access */
  traits: string[];
  /** True when classifier confidence is below 0.6 — signals LLM tier-2 may improve results */
  tier2Recommended: boolean;
}

export interface ScaffoldOptions {
  projectName?: string;
  oracle?: boolean;
}

/**
 * Vendored type definitions for the Stackbilt scaffold-response contract.
 *
 * These types are structurally copied from @stackbilt/contracts to avoid
 * a file: workspace dependency on an unpublished sibling repo. They are
 * type-only (erased at compile time, zero runtime cost) and are used
 * internally by http-client.ts — they are NOT re-exported from the public
 * CLI surface in src/index.ts.
 *
 * When @stackbilt/contracts is properly published to npm, this file can be
 * deleted and http-client.ts can re-import from the real package.
 *
 * Upstream source (as of @stackbilt/contracts@0.1.0):
 *   contracts/dist/scaffold-response/scaffold-response.contract.d.ts
 *
 * Type aliases follow the upstream naming convention with the `Type` suffix
 * (e.g. `ScaffoldFile` → `ScaffoldFileType`), matching the re-exports in
 * contracts/dist/scaffold-response/index.d.ts.
 */

export type FileRoleType = 'config' | 'scaffold' | 'governance' | 'test' | 'doc';

export interface ScaffoldFileType {
  path: string;
  content: string;
  role: FileRoleType;
}

export interface GovernanceDocsType {
  threat_model: string;
  adr: string;
  test_plan: string;
}

export interface PromptContextMetaType {
  project_type: string;
  complexity: string;
  confidence: string;
  seed: number;
}

export interface PromptContextRequirementType {
  name: string;
  priority: string;
  effort: string;
  acceptance: string;
}

export interface PromptContextInterfaceType {
  name: string;
  layout: string;
  components: string;
}

export interface PromptContextThreatType {
  name: string;
  owasp: string;
  likelihood: string;
  impact: string;
  mitigation: string;
  detection: string;
  response_time: string;
}

export interface PromptContextRuntimeType {
  name: string;
  tier: string;
  traits: string;
}

export interface PromptContextTestPlanType {
  name: string;
  framework: string;
  ci_stage: string;
  coverage: string;
  setup: string;
  assertion_style: string;
}

export interface PromptContextFirstTaskType {
  name: string;
  estimate: string;
  complexity: string;
  deliverable: string;
  adr: string;
}

export interface PromptContextType {
  intention: string;
  pattern: string;
  meta: PromptContextMetaType;
  requirement: PromptContextRequirementType;
  interface: PromptContextInterfaceType;
  threat: PromptContextThreatType;
  runtime: PromptContextRuntimeType;
  test_plan: PromptContextTestPlanType;
  first_task: PromptContextFirstTaskType;
  governance: GovernanceDocsType;
  files: ScaffoldFileType[];
}

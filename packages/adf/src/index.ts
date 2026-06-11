export { parseAdf } from './parser';
export { formatAdf } from './formatter';
export { applyPatches } from './patcher';
export { parseManifest, resolveModules, bundleModules } from './bundler';
export { validateConstraints, computeWeightSummary } from './validator';
export { evaluateLocBudgets, resolveBudgetStatus, matchPath } from './loc-budget';
export { evaluateEvidence } from './evidence';
export type { EvidenceReport, StaleBaselineWarning } from './evidence';
export { parseMarkdownSections } from './markdown-parser';
export type { MarkdownSection, MarkdownElement, RuleStrength, StrengthConfig } from './markdown-parser';
export { classifyElement, isDuplicateItem, buildMigrationPlan } from './content-classifier';
export type {
  ClassificationResult,
  RoutingTrace,
  MigrationItem,
  MigrationPlan,
  RouteDecision,
  AdfTargetSection,
  WeightTag,
  TriggerMap,
  ClassifierConfig,
} from './content-classifier';
export { stripCharterSentinels, isCharterSentinel } from './sentinels';
export {
  compileAdf,
  buildBanner,
  COMPILE_TARGETS,
  TARGET_FILENAMES,
  COMPILE_BANNER_MARKER,
  MODULE_INDEX_FENCE,
} from './compiler';
export type {
  CompileTarget,
  CompileOptions,
  CompileResult,
} from './compiler';
export * from './types';
export * from './errors';

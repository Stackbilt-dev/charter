export { parseAdf } from './parser';
export { formatAdf } from './formatter';
export { applyPatches } from './patcher';
export { parseManifest, resolveModules, bundleModules } from './bundler';
export { validateConstraints, computeWeightSummary } from './validator';
export { parseMarkdownSections } from './markdown-parser';
export type { MarkdownSection, MarkdownElement, RuleStrength } from './markdown-parser';
export { classifyElement, isDuplicateItem, buildMigrationPlan } from './content-classifier';
export type {
  ClassificationResult,
  MigrationItem,
  MigrationPlan,
  RouteDecision,
  AdfTargetSection,
  WeightTag,
} from './content-classifier';
export * from './types';
export * from './errors';

// setup.contract.ts — bounded context: CLI setup command
// Entities: SetupPreset, WorkflowTemplate, SetupResult
// Authority rules: isValidPreset guards user-provided preset input
// State machine: detection → validation → plan → apply

import { z } from 'zod';

export const VALID_PRESETS = ['worker', 'frontend', 'backend', 'fullstack', 'docs', 'rust-wasm'] as const;

export const StackPresetSchema = z.enum(VALID_PRESETS);

export type SetupPreset = z.infer<typeof StackPresetSchema>;

export const WorkflowTemplateSchema = z.object({
  hasPushTrigger: z.boolean(),
  hasBadgeRefreshStep: z.boolean(),
  hasBadgeCommitStep: z.boolean(),
  hasGovernedByTrailer: z.boolean(),
});

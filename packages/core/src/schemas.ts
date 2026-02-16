/**
 * Zod validation schemas for Charter governance data.
 *
 * These schemas define the shape of governance artifacts (ledger entries,
 * patterns, protocols, requests) and can be used for input validation
 * in both Kit CLI and Cloud API contexts.
 */

import { z } from 'zod';

// ============================================================================
// Ledger Entry Schemas
// ============================================================================

export const CreateLedgerEntrySchema = z.object({
  entry_type: z.enum(['RULING', 'ADR', 'POLICY', 'SOP', 'STRATEGIC', 'REVIEW', 'NOTARY_STAMP']),
  source_mode: z.enum(['PRODUCT', 'UX', 'RISK', 'ARCHITECT', 'TDD', 'SPRINT']),
  title: z.string()
    .min(5, "Title must be at least 5 characters")
    .max(100, "Title must be at most 100 characters"),
  summary: z.string().max(500).optional(),
  input_excerpt: z.string().max(500).optional(),
  output: z.string().min(10, "Output must be at least 10 characters"),
  tags: z.array(z.string()).optional(),
  project_id: z.string().optional(),
  artifact_hash: z.string().regex(/^sha256:[A-Fa-f0-9]{64}$/).optional(),
  quality_metadata: z.object({
    specificity_score: z.number().min(0).max(100),
    rubric_version: z.string().min(1)
  }).optional(),
  stamp: z.object({
    stamp_id: z.string().min(1),
    ledger_ids: z.array(z.string().uuid()).min(1),
    issued_at: z.string().min(1),
    policy_hash: z.string().regex(/^sha256:[A-Fa-f0-9]{64}$/),
    signature: z.string().min(8)
  }).optional(),
  create_pattern: z.object({
    name: z.string().min(3).max(100),
    category: z.enum(['COMPUTE', 'DATA', 'INTEGRATION', 'SECURITY', 'ASYNC']),
    blessed_solution: z.string().min(5).max(200),
    rationale: z.string().max(1000).optional(),
    anti_patterns: z.string().max(500).optional(),
    documentation_url: z.string().url().optional()
  }).optional()
}).superRefine((data, ctx) => {
  if (data.entry_type === 'NOTARY_STAMP') {
    if (!data.artifact_hash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'artifact_hash is required for NOTARY_STAMP' });
    }
    if (!data.quality_metadata) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'quality_metadata is required for NOTARY_STAMP' });
    }
    if (!data.stamp) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'stamp is required for NOTARY_STAMP' });
    }
  }
});

export const UpdateLedgerStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUPERSEDED', 'ARCHIVED'])
});

// ============================================================================
// Pattern Schemas
// ============================================================================

export const CreatePatternSchema = z.object({
  name: z.string().min(3).max(100),
  category: z.enum(['COMPUTE', 'DATA', 'INTEGRATION', 'SECURITY', 'ASYNC']),
  blessed_solution: z.string().min(5).max(200),
  rationale: z.string().max(1000).optional(),
  anti_patterns: z.string().max(500).optional(),
  documentation_url: z.string().url().optional(),
  related_ledger_id: z.string().uuid().optional(),
  project_id: z.string().optional()
});

export const UpdatePatternSchema = z.object({
  name: z.string().min(3).max(100).optional(),
  blessed_solution: z.string().min(5).max(200).optional(),
  rationale: z.string().max(1000).optional(),
  anti_patterns: z.string().max(500).optional(),
  documentation_url: z.string().url().optional(),
  status: z.enum(['ACTIVE', 'DEPRECATED', 'EVALUATING']).optional()
});

// ============================================================================
// Protocol Schemas
// ============================================================================

export const CreateProtocolSchema = z.object({
  title: z.string()
    .min(3, "Title must be at least 3 characters")
    .max(40, "Title must be at most 40 characters")
    .transform(s => s.toUpperCase()),
  description: z.string()
    .min(10, "Description must be at least 10 characters")
    .max(120, "Description must be at most 120 characters"),
  content: z.string()
    .min(20, "Content must be at least 20 characters")
    .max(10000, "Content must be at most 10000 characters"),
  project_id: z.string().optional()
});

// ============================================================================
// Governance Request Schemas
// ============================================================================

export const CreateGovernanceRequestSchema = z.object({
  title: z.string()
    .min(5, "Title must be at least 5 characters")
    .max(150, "Title must be at most 150 characters"),
  description: z.string().max(2000).optional(),
  request_type: z.enum(['FEATURE_APPROVAL', 'ARCHITECTURE_REVIEW', 'POLICY_QUESTION', 'EXCEPTION_REQUEST', 'TOOL_EVALUATION']),
  domain: z.enum(['ARCHITECTURE', 'DATA', 'STANDARDS', 'SECURITY', 'STRATEGY']),
  urgency: z.enum(['LOW', 'STANDARD', 'ELEVATED', 'CRITICAL']).default('STANDARD'),
  complexity: z.enum(['TRIVIAL', 'SIMPLE', 'MODERATE', 'COMPLEX', 'EPIC']).default('MODERATE'),
  requester: z.string().max(100).optional(),
  project_id: z.string().optional()
});

export const ResolveGovernanceRequestSchema = z.object({
  resolution_summary: z.string().min(10).max(500),
  resolution_ledger_id: z.string().uuid().optional()
});

// ============================================================================
// Project Schemas
// ============================================================================

export const CreateProjectSchema = z.object({
  name: z.string()
    .min(2, "Project name must be at least 2 characters")
    .max(50, "Project name must be at most 50 characters")
    .transform(s => s.toUpperCase().replace(/\s+/g, '_')),
  description: z.string().max(500).optional()
});

// ============================================================================
// Inferred Types
// ============================================================================

export type CreateLedgerEntryRequest = z.infer<typeof CreateLedgerEntrySchema>;
export type UpdateLedgerStatusRequest = z.infer<typeof UpdateLedgerStatusSchema>;
export type CreatePatternRequest = z.infer<typeof CreatePatternSchema>;
export type UpdatePatternRequest = z.infer<typeof UpdatePatternSchema>;
export type CreateProtocolRequest = z.infer<typeof CreateProtocolSchema>;
export type CreateGovernanceRequestType = z.infer<typeof CreateGovernanceRequestSchema>;
export type ResolveGovernanceRequestType = z.infer<typeof ResolveGovernanceRequestSchema>;
export type CreateProjectRequest = z.infer<typeof CreateProjectSchema>;

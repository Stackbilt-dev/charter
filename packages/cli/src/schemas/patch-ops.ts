/**
 * Zod schema for `adf patch --ops` input.
 *
 * Validates externally-supplied patch operations at the CLI boundary (the
 * `--ops` JSON / `--ops-file` contents) before they reach the patch engine.
 * Without this, a malformed op (e.g. a `null` array element) crashed the
 * before-capture pass with an uncaught `TypeError` instead of a clean error.
 *
 * The schema is the runtime authority; `@stackbilt/adf` remains the source of
 * truth for the `PatchOperation` *type*. The compile-time guard at the bottom
 * fails the build if the two ever drift, without making adf depend on zod.
 */

import { z } from 'zod';
import type { PatchOperation } from '@stackbilt/adf';

const AdfContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('list'), items: z.array(z.string()) }),
  z.object({
    type: z.literal('map'),
    entries: z.array(z.object({ key: z.string(), value: z.string() })),
  }),
  z.object({
    type: z.literal('metric'),
    entries: z.array(
      z.object({
        key: z.string(),
        value: z.number(),
        ceiling: z.number(),
        unit: z.string(),
      })
    ),
  }),
]);

export const PatchOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ADD_BULLET'), section: z.string(), value: z.string() }),
  z.object({ op: z.literal('REPLACE_BULLET'), section: z.string(), index: z.number(), value: z.string() }),
  z.object({ op: z.literal('REMOVE_BULLET'), section: z.string(), index: z.number() }),
  z.object({
    op: z.literal('ADD_SECTION'),
    key: z.string(),
    decoration: z.string().nullable().optional(),
    content: AdfContentSchema,
    weight: z.enum(['load-bearing', 'advisory']).optional(),
  }),
  z.object({ op: z.literal('REPLACE_SECTION'), key: z.string(), content: AdfContentSchema }),
  z.object({ op: z.literal('REMOVE_SECTION'), key: z.string() }),
  z.object({ op: z.literal('UPDATE_METRIC'), section: z.string(), key: z.string(), value: z.number() }),
]);

export const PatchOperationArraySchema = z.array(PatchOperationSchema);

// Compile-time drift guard: the inferred schema type and adf's public
// `PatchOperation` must be mutually assignable. If either side changes without
// the other, one of these aliases fails to resolve and the build breaks.
type AssertAssignable<A extends B, B> = A;
type _SchemaMatchesType = AssertAssignable<z.infer<typeof PatchOperationSchema>, PatchOperation>;
type _TypeMatchesSchema = AssertAssignable<PatchOperation, z.infer<typeof PatchOperationSchema>>;

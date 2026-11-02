import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CreateGovernanceRequestSchema, CreateLedgerEntrySchema, CreatePatternSchema, CreateProjectSchema } from '@stackbilt/core';
import { BlastInputSchema, BlastOutputSchema } from '@stackbilt/blast';
import { SurfaceInputSchema } from '@stackbilt/surface';
import { PatchOperationArraySchema } from '../schemas/patch-ops';

describe('Zod 4 public validation contracts (#310)', () => {
  it('preserves blast and surface defaults without materializing absent optional keys', () => {
    expect(BlastInputSchema.parse({ seeds: ['src/a.ts'] })).toEqual({
      seeds: ['src/a.ts'], root: '.', maxDepth: 3, aliases: {},
    });
    const surface = SurfaceInputSchema.parse({});
    expect(surface).toMatchObject({ root: '.', ignoreDirs: [], excludeGlobs: [] });
    expect(surface.extensions).toContain('.ts');
    expect(surface).not.toHaveProperty('schemaPaths');
    expect(SurfaceInputSchema.parse({ root: undefined })).toEqual(surface);
  });

  it('keeps map keys open-ended while validating values and stripping unknown object keys', () => {
    expect(BlastInputSchema.parse({ seeds: ['a.ts'], aliases: { '@/': 'src/' }, extra: true }))
      .toEqual({ seeds: ['a.ts'], root: '.', maxDepth: 3, aliases: { '@/': 'src/' } });
    expect(BlastInputSchema.safeParse({ seeds: ['a.ts'], aliases: { '@/': 42 } }).success).toBe(false);
    const output = {
      root: '.', fileCount: 0, seeds: [], affected: [], maxDepth: 0, hotFiles: [],
      summary: { totalAffected: 0, seedCount: 0, depthHistogram: { '1': 2, custom: 0 } },
    };
    expect(BlastOutputSchema.parse(output)).toEqual(output);
    expect(BlastOutputSchema.safeParse({ ...output, summary: { ...output.summary, depthHistogram: { '1': -1 } } }).success).toBe(false);
  });

  it('preserves governance defaults, transforms and legacy UUID-like identifiers', () => {
    const request = CreateGovernanceRequestSchema.parse({
      title: 'Review this change', request_type: 'FEATURE_APPROVAL', domain: 'ARCHITECTURE',
    });
    expect(request).toMatchObject({ urgency: 'STANDARD', complexity: 'MODERATE' });
    expect(CreateProjectSchema.parse({ name: 'example project', extra: true })).toEqual({ name: 'EXAMPLE_PROJECT' });
    const pattern = {
      name: 'Example', category: 'DATA', blessed_solution: 'Validate inputs',
      related_ledger_id: '00000000-0000-0000-0000-000000000001',
    };
    expect(CreatePatternSchema.parse(pattern)).toEqual(pattern);
    expect(CreatePatternSchema.safeParse({ ...pattern, related_ledger_id: 'not-an-id' }).success).toBe(false);
  });

  it('preserves notary cross-field requirements and readable issues', () => {
    const result = CreateLedgerEntrySchema.safeParse({
      entry_type: 'NOTARY_STAMP', source_mode: 'RISK', title: 'A notary stamp', output: 'A sufficiently detailed output',
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected notary validation to fail');
    expect(result.error).toBeInstanceOf(z.ZodError);
    expect(result.error.issues.map(issue => issue.message)).toEqual([
      'artifact_hash is required for NOTARY_STAMP',
      'quality_metadata is required for NOTARY_STAMP',
      'stamp is required for NOTARY_STAMP',
    ]);
  });

  it('allows consumers to extend exported schemas with the same Zod runtime', () => {
    const schema = BlastInputSchema.extend({ requestId: z.string().min(1) });
    expect(schema.parse({ seeds: ['a.ts'], requestId: 'request-1' })).toMatchObject({ requestId: 'request-1', maxDepth: 3 });
    for (const result of [
      BlastInputSchema.safeParse({ seeds: [] }),
      SurfaceInputSchema.safeParse({ root: 1 }),
      CreateProjectSchema.safeParse({ name: 1 }),
    ]) {
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected validation to fail');
      expect(result.error).toBeInstanceOf(z.ZodError);
      expect(result.error.issues[0]).toMatchObject({ message: expect.any(String), path: expect.any(Array) });
    }
  });

  it('rejects malformed patch payloads and unsafe numeric inputs', () => {
    const op = { op: 'UPDATE_METRIC', section: 'CONSTRAINTS', key: 'loc', value: 2 };
    expect(PatchOperationArraySchema.parse([op])).toEqual([op]);
    expect(PatchOperationArraySchema.safeParse([null]).success).toBe(false);
    expect(PatchOperationArraySchema.safeParse([{ ...op, value: Infinity }]).success).toBe(false);
    expect(BlastInputSchema.safeParse({ seeds: ['a.ts'], maxDepth: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });
});

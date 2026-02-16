import { describe, it, expect } from 'vitest';
import { heuristicClassify, determineRecommendation } from '../index';

describe('heuristicClassify', () => {
  it('classifies "readme" as SURFACE', () => {
    const result = heuristicClassify('update readme');
    expect(result.suggestedClass).toBe('SURFACE');
  });

  it('classifies "typo fix" as SURFACE', () => {
    const result = heuristicClassify('fix typo in docs');
    expect(result.suggestedClass).toBe('SURFACE');
  });

  it('classifies "OAuth integration" as CROSS_CUTTING', () => {
    const result = heuristicClassify('Add OAuth integration for partner API');
    expect(result.suggestedClass).toBe('CROSS_CUTTING');
  });

  it('classifies "database migration" as CROSS_CUTTING', () => {
    const result = heuristicClassify('database schema migration for users');
    expect(result.suggestedClass).toBe('CROSS_CUTTING');
  });

  it('returns HIGH confidence when multiple cross-cutting patterns match', () => {
    const result = heuristicClassify('api endpoint schema migration');
    expect(result.suggestedClass).toBe('CROSS_CUTTING');
    expect(result.confidence).toBe('HIGH');
  });

  it('classifies generic subject as LOCAL with LOW confidence', () => {
    const result = heuristicClassify('fix button color');
    expect(result.suggestedClass).toBe('LOCAL');
    expect(result.confidence).toBe('LOW');
  });

  it('returns signals for matched patterns', () => {
    const result = heuristicClassify('update readme documentation');
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals.some(s => s.startsWith('Surface'))).toBe(true);
  });

  it('returns default signal for LOCAL classification', () => {
    const result = heuristicClassify('fix button color');
    expect(result.signals).toContain('No strong patterns detected - defaulting to LOCAL');
  });
});

describe('determineRecommendation', () => {
  it('returns REJECT for VIOLATION status', () => {
    expect(determineRecommendation('SURFACE', 'VIOLATION', false)).toBe('REJECT');
  });

  it('returns ESCALATE for NEEDS_REVIEW status', () => {
    expect(determineRecommendation('LOCAL', 'NEEDS_REVIEW', false)).toBe('ESCALATE');
  });

  it('returns ESCALATE for CROSS_CUTTING without mitigations', () => {
    expect(determineRecommendation('CROSS_CUTTING', 'CLEAR', false)).toBe('ESCALATE');
  });

  it('returns APPROVE_WITH_MITIGATIONS for CROSS_CUTTING with mitigations', () => {
    expect(determineRecommendation('CROSS_CUTTING', 'CLEAR', true)).toBe('APPROVE_WITH_MITIGATIONS');
  });

  it('returns APPROVE for SURFACE with CLEAR status', () => {
    expect(determineRecommendation('SURFACE', 'CLEAR', false)).toBe('APPROVE');
  });

  it('returns APPROVE_WITH_MITIGATIONS when mitigations required', () => {
    expect(determineRecommendation('LOCAL', 'CLEAR', true)).toBe('APPROVE_WITH_MITIGATIONS');
  });
});

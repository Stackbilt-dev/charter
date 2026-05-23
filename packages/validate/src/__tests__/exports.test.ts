import { describe, it, expect } from 'vitest';
import {
  validateCitations,
  extractCitations,
  enrichCitations,
  classifyMessage,
} from '../index';
import type { CitationBundle } from '../index';

// ============================================================================
// Export boundary — verify every top-level export is callable
// ============================================================================

describe('@stackbilt/validate export boundary', () => {
  it('exports validateCitations as a function', () => {
    expect(typeof validateCitations).toBe('function');
  });

  it('exports extractCitations as a function', () => {
    expect(typeof extractCitations).toBe('function');
  });

  it('exports enrichCitations as a function', () => {
    expect(typeof enrichCitations).toBe('function');
  });

  it('exports classifyMessage as a function', () => {
    expect(typeof classifyMessage).toBe('function');
  });
});

// ============================================================================
// extractCitations
// ============================================================================

describe('extractCitations', () => {
  it('extracts section citations', () => {
    const citations = extractCitations('See [Section 3.1] for details.');
    expect(citations).toContain('Section 3.1');
  });

  it('extracts ADR citations', () => {
    const citations = extractCitations('Per [ADR-042] and [ADR-007].');
    expect(citations).toContain('ADR-042');
    expect(citations).toContain('ADR-007');
  });

  it('returns empty array when no citations present', () => {
    const citations = extractCitations('No citations here.');
    expect(Array.isArray(citations)).toBe(true);
    expect(citations).toHaveLength(0);
  });
});

// ============================================================================
// validateCitations
// ============================================================================

function makeBundle(knownIds: string[]): CitationBundle {
  const citationMap = new Map<string, unknown>(knownIds.map((id) => [id, true]));
  return {
    citationMap,
    sections: [],
    adrs: [],
    patterns: [],
  };
}

describe('validateCitations', () => {
  it('returns valid=true when all citations are known', () => {
    const bundle = makeBundle(['Section 2.1', 'ADR-001']);
    const result = validateCitations('See [Section 2.1] and [ADR-001].', bundle);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('returns valid=false with violation when citation is unknown', () => {
    const bundle = makeBundle([]);
    const result = validateCitations('See [Section 99.9].', bundle);
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].errorType).toBe('NOT_FOUND_IN_DATABASE');
  });

  it('reports totalCitations and validCount', () => {
    const bundle = makeBundle(['ADR-001']);
    const result = validateCitations('[ADR-001] and [ADR-999]', bundle);
    expect(result.totalCitations).toBe(2);
    expect(result.validCount).toBe(1);
  });
});

// ============================================================================
// classifyMessage
// ============================================================================

describe('classifyMessage', () => {
  it('returns a classification object with expected shape', () => {
    const result = classifyMessage('Should we use TypeScript or JavaScript?');
    expect(result).toHaveProperty('intent');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('dudePhases');
    expect(Array.isArray(result.dudePhases)).toBe(true);
  });

  it('classifies decision-style messages with decision intent', () => {
    const result = classifyMessage('Which approach should we choose: A or B?');
    expect(result.intent).toBe('decision');
  });

  it('classifies ideation-style messages with ideation intent', () => {
    const result = classifyMessage("I'm thinking we could try a new architecture here.");
    expect(result.intent).toBe('ideation');
  });
});

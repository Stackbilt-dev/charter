import { describe, it, expect } from 'vitest';
import { mergeDocuments, estimateTokens } from '../merger';
import type { AdfDocument } from '../types';

describe('mergeDocuments', () => {
  it('merges list sections by concatenating items', () => {
    const doc1: AdfDocument = {
      version: '0.1',
      sections: [{ key: 'RULES', decoration: null, content: { type: 'list', items: ['Rule A'] } }],
    };
    const doc2: AdfDocument = {
      version: '0.1',
      sections: [{ key: 'RULES', decoration: null, content: { type: 'list', items: ['Rule B'] } }],
    };
    const merged = mergeDocuments([doc1, doc2]);
    const rules = merged.sections.find(s => s.key === 'RULES');
    expect(rules).toBeDefined();
    expect(rules!.content).toEqual({ type: 'list', items: ['Rule A', 'Rule B'] });
  });

  it('merges map sections by concatenating entries', () => {
    const doc1: AdfDocument = {
      version: '0.1',
      sections: [{ key: 'STATE', decoration: null, content: { type: 'map', entries: [{ key: 'A', value: '1' }] } }],
    };
    const doc2: AdfDocument = {
      version: '0.1',
      sections: [{ key: 'STATE', decoration: null, content: { type: 'map', entries: [{ key: 'B', value: '2' }] } }],
    };
    const merged = mergeDocuments([doc1, doc2]);
    const state = merged.sections.find(s => s.key === 'STATE');
    expect(state!.content).toEqual({ type: 'map', entries: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }] });
  });

  it('merges text sections by joining with newline', () => {
    const doc1: AdfDocument = {
      version: '0.1',
      sections: [{ key: 'ROLE', decoration: null, content: { type: 'text', value: 'Part 1' } }],
    };
    const doc2: AdfDocument = {
      version: '0.1',
      sections: [{ key: 'ROLE', decoration: null, content: { type: 'text', value: 'Part 2' } }],
    };
    const merged = mergeDocuments([doc1, doc2]);
    const role = merged.sections.find(s => s.key === 'ROLE');
    expect(role!.content).toEqual({ type: 'text', value: 'Part 1\nPart 2' });
  });

  it('merges metric sections by concatenating entries', () => {
    const doc1: AdfDocument = {
      version: '0.1',
      sections: [{ key: 'METRICS', decoration: null, content: { type: 'metric', entries: [{ key: 'loc', value: 100, ceiling: 200, unit: 'lines' }] } }],
    };
    const doc2: AdfDocument = {
      version: '0.1',
      sections: [{ key: 'METRICS', decoration: null, content: { type: 'metric', entries: [{ key: 'fns', value: 10, ceiling: 20, unit: 'count' }] } }],
    };
    const merged = mergeDocuments([doc1, doc2]);
    const metrics = merged.sections.find(s => s.key === 'METRICS');
    expect(metrics!.content.type).toBe('metric');
    if (metrics!.content.type === 'metric') {
      expect(metrics!.content.entries).toHaveLength(2);
    }
  });

  it('keeps target content for mismatched types (first-wins)', () => {
    const doc1: AdfDocument = {
      version: '0.1',
      sections: [{ key: 'DATA', decoration: null, content: { type: 'text', value: 'text' } }],
    };
    const doc2: AdfDocument = {
      version: '0.1',
      sections: [{ key: 'DATA', decoration: null, content: { type: 'list', items: ['item'] } }],
    };
    const merged = mergeDocuments([doc1, doc2]);
    const data = merged.sections.find(s => s.key === 'DATA');
    expect(data!.content).toEqual({ type: 'text', value: 'text' });
  });

  it('promotes weight to load-bearing when either source is load-bearing', () => {
    const doc1: AdfDocument = {
      version: '0.1',
      sections: [{ key: 'RULES', decoration: null, content: { type: 'list', items: ['A'] }, weight: 'advisory' }],
    };
    const doc2: AdfDocument = {
      version: '0.1',
      sections: [{ key: 'RULES', decoration: null, content: { type: 'list', items: ['B'] }, weight: 'load-bearing' }],
    };
    const merged = mergeDocuments([doc1, doc2]);
    expect(merged.sections[0].weight).toBe('load-bearing');
  });

  it('does not mutate input documents', () => {
    const doc1: AdfDocument = {
      version: '0.1',
      sections: [{ key: 'RULES', decoration: null, content: { type: 'list', items: ['A'] } }],
    };
    const doc2: AdfDocument = {
      version: '0.1',
      sections: [{ key: 'RULES', decoration: null, content: { type: 'list', items: ['B'] } }],
    };
    mergeDocuments([doc1, doc2]);
    expect(doc1.sections[0].content).toEqual({ type: 'list', items: ['A'] });
  });
});

describe('estimateTokens', () => {
  it('returns positive token count for non-empty document', () => {
    const doc: AdfDocument = {
      version: '0.1',
      sections: [
        { key: 'RULES', decoration: null, content: { type: 'list', items: ['Use TypeScript', 'Follow conventions'] } },
      ],
    };
    const tokens = estimateTokens(doc);
    expect(tokens).toBeGreaterThan(0);
  });

  it('returns 0 for empty document', () => {
    const doc: AdfDocument = { version: '0.1', sections: [] };
    expect(estimateTokens(doc)).toBe(0);
  });
});

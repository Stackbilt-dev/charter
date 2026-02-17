import { describe, it, expect } from 'vitest';
import { parseTrailersFromMessage, parseAllTrailers } from '../trailers';

describe('parseTrailersFromMessage', () => {
  it('parses Governed-By trailer', () => {
    const result = parseTrailersFromMessage('abc123', 'feat: add auth\n\nGoverned-By: ADR-001');
    expect(result.governedBy).toEqual([{ commitSha: 'abc123', reference: 'ADR-001' }]);
    expect(result.resolvesRequest).toEqual([]);
  });

  it('parses Resolves-Request trailer', () => {
    const result = parseTrailersFromMessage('def456', 'fix: resolve issue\n\nResolves-Request: REQ-042');
    expect(result.resolvesRequest).toEqual([{ commitSha: 'def456', reference: 'REQ-042' }]);
  });

  it('parses both trailers from same message', () => {
    const message = 'feat: migration\n\nGoverned-By: ADR-003\nResolves-Request: REQ-010';
    const result = parseTrailersFromMessage('aaa', message);
    expect(result.governedBy).toHaveLength(1);
    expect(result.resolvesRequest).toHaveLength(1);
  });

  it('is case-insensitive', () => {
    const result = parseTrailersFromMessage('bbb', 'chore\n\ngoverned-by: ADR-005');
    expect(result.governedBy).toHaveLength(1);
    expect(result.governedBy[0].reference).toBe('ADR-005');
  });

  it('returns empty arrays when no trailers present', () => {
    const result = parseTrailersFromMessage('ccc', 'fix: typo in readme');
    expect(result.governedBy).toEqual([]);
    expect(result.resolvesRequest).toEqual([]);
  });

  it('handles multiple Governed-By trailers', () => {
    const message = 'feat: big change\n\nGoverned-By: ADR-001\nGoverned-By: ADR-002';
    const result = parseTrailersFromMessage('ddd', message);
    expect(result.governedBy).toHaveLength(2);
  });

  it('ignores governance lines outside the terminal trailer block', () => {
    const message = [
      'feat: integration',
      '',
      'Governed-By: ADR-101',
      'Resolves-Request: REQ-101',
      '',
      'Co-Authored-By: Example <dev@example.com>',
    ].join('\n');
    const result = parseTrailersFromMessage('eee', message);
    expect(result.governedBy).toHaveLength(0);
    expect(result.resolvesRequest).toHaveLength(0);
  });
});

describe('parseAllTrailers', () => {
  it('combines trailers from multiple commits', () => {
    const commits = [
      { sha: 'a1', message: 'feat: x\n\nGoverned-By: ADR-001', author: 'dev', timestamp: '2025-01-01' },
      { sha: 'b2', message: 'fix: y\n\nResolves-Request: REQ-001', author: 'dev', timestamp: '2025-01-02' },
    ];
    const result = parseAllTrailers(commits);
    expect(result.governedBy).toHaveLength(1);
    expect(result.resolvesRequest).toHaveLength(1);
  });

  it('returns empty arrays for commits with no trailers', () => {
    const commits = [
      { sha: 'c3', message: 'chore: update deps', author: 'dev', timestamp: '2025-01-01' },
    ];
    const result = parseAllTrailers(commits);
    expect(result.governedBy).toEqual([]);
    expect(result.resolvesRequest).toEqual([]);
  });
});

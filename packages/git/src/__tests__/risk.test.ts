import { describe, it, expect } from 'vitest';
import { assessCommitRisk } from '../risk';

describe('assessCommitRisk', () => {
  describe('file-based assessment', () => {
    it('returns HIGH for worker/handlers/ paths', () => {
      expect(assessCommitRisk(['worker/handlers/auth.ts'], '')).toBe('HIGH');
    });

    it('returns HIGH for migration files', () => {
      expect(assessCommitRisk(['migrations/001.sql'], '')).toBe('HIGH');
    });

    it('returns HIGH for .sql files', () => {
      expect(assessCommitRisk(['schema.sql'], '')).toBe('HIGH');
    });

    it('returns MEDIUM for components/ paths', () => {
      expect(assessCommitRisk(['components/Button.tsx'], '')).toBe('MEDIUM');
    });

    it('returns MEDIUM for lib/ paths', () => {
      expect(assessCommitRisk(['lib/utils.ts'], '')).toBe('MEDIUM');
    });

    it('returns LOW for markdown files', () => {
      expect(assessCommitRisk(['README.md'], '')).toBe('LOW');
    });

    it('returns LOW for json files', () => {
      expect(assessCommitRisk(['package.json'], '')).toBe('LOW');
    });

    it('HIGH takes precedence over MEDIUM', () => {
      expect(assessCommitRisk(['worker/handlers/x.ts', 'components/y.tsx'], '')).toBe('HIGH');
    });
  });

  describe('message-based fallback', () => {
    it('returns HIGH for "migration" keyword', () => {
      expect(assessCommitRisk(undefined, 'run database migration')).toBe('HIGH');
    });

    it('returns HIGH for "security" keyword', () => {
      expect(assessCommitRisk(undefined, 'fix security vulnerability')).toBe('HIGH');
    });

    it('returns MEDIUM for "refactor" keyword', () => {
      expect(assessCommitRisk(undefined, 'refactor auth module')).toBe('MEDIUM');
    });

    it('returns MEDIUM for "component" keyword', () => {
      expect(assessCommitRisk(undefined, 'update component styles')).toBe('MEDIUM');
    });

    it('returns LOW for generic messages', () => {
      expect(assessCommitRisk(undefined, 'fix typo')).toBe('LOW');
    });

    it('falls back to message when files array is empty', () => {
      expect(assessCommitRisk([], 'run database migration')).toBe('HIGH');
    });
  });
});

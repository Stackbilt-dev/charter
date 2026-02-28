import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runGit,
  isGitRepo,
  hasCommits,
  getGitErrorMessage,
  parseCommitMetadata,
  parseChangedFilesByCommit,
  getRecentCommitRange,
} from '../git-helpers';

describe('git-helpers', () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-git-helpers-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('runGit', () => {
    it('succeeds inside a git repo', () => {
      execFileSync('git', ['init'], { stdio: 'ignore' });
      const result = runGit(['rev-parse', '--is-inside-work-tree']).trim();
      expect(result).toBe('true');
    });

    it('throws outside a git repo', () => {
      expect(() => runGit(['rev-parse', '--is-inside-work-tree'])).toThrow();
    });
  });

  describe('isGitRepo', () => {
    it('returns true inside a git repo', () => {
      execFileSync('git', ['init'], { stdio: 'ignore' });
      expect(isGitRepo()).toBe(true);
    });

    it('returns false outside a git repo', () => {
      expect(isGitRepo()).toBe(false);
    });
  });

  describe('hasCommits', () => {
    it('returns false on empty repo', () => {
      execFileSync('git', ['init'], { stdio: 'ignore' });
      expect(hasCommits()).toBe(false);
    });

    it('returns true after a commit', () => {
      execFileSync('git', ['init'], { stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'hello');
      execFileSync('git', ['add', '.'], { stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { stdio: 'ignore' });
      expect(hasCommits()).toBe(true);
    });
  });

  describe('getGitErrorMessage', () => {
    it('extracts stderr from exec error', () => {
      const err = Object.assign(new Error('fail'), { stderr: 'fatal: not a repo' });
      expect(getGitErrorMessage(err)).toBe('fatal: not a repo');
    });

    it('falls back to message', () => {
      expect(getGitErrorMessage(new Error('some error'))).toBe('some error');
    });

    it('returns fallback for non-Error', () => {
      expect(getGitErrorMessage('string')).toBe('Unknown git error.');
    });
  });

  describe('parseCommitMetadata', () => {
    it('parses git log format', () => {
      const log = 'abc123\x1fAlice\x1f2026-01-01T00:00:00Z\x1fInitial commit\x1e';
      const result = parseCommitMetadata(log);
      expect(result).toHaveLength(1);
      expect(result[0].sha).toBe('abc123');
      expect(result[0].author).toBe('Alice');
      expect(result[0].message).toBe('Initial commit');
    });

    it('handles multiple commits', () => {
      const log = 'aaa\x1fA\x1f2026-01-01\x1fFirst\x1ebbb\x1fB\x1f2026-01-02\x1fSecond\x1e';
      expect(parseCommitMetadata(log)).toHaveLength(2);
    });
  });

  describe('parseChangedFilesByCommit', () => {
    it('parses name-only log', () => {
      const log = [
        'a'.repeat(40),
        'src/index.ts',
        'src/util.ts',
        '',
        'b'.repeat(40),
        'README.md',
      ].join('\n');
      const result = parseChangedFilesByCommit(log);
      expect(result.get('a'.repeat(40))).toEqual(['src/index.ts', 'src/util.ts']);
      expect(result.get('b'.repeat(40))).toEqual(['README.md']);
    });
  });

  describe('getRecentCommitRange', () => {
    it('returns HEAD on empty repo', () => {
      execFileSync('git', ['init'], { stdio: 'ignore' });
      expect(getRecentCommitRange()).toBe('HEAD');
    });
  });
});

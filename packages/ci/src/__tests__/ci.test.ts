import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setOutput,
  setSummary,
  annotateDriftViolations,
  annotateValidationStatus,
  formatPRComment,
} from '../index';
import type { DriftViolation } from '@stackbilt/types';

describe('@stackbilt/ci export boundary', () => {
  it('exports setOutput as a function', () => {
    expect(typeof setOutput).toBe('function');
  });

  it('exports setSummary as a function', () => {
    expect(typeof setSummary).toBe('function');
  });

  it('exports annotateDriftViolations as a function', () => {
    expect(typeof annotateDriftViolations).toBe('function');
  });

  it('exports annotateValidationStatus as a function', () => {
    expect(typeof annotateValidationStatus).toBe('function');
  });

  it('exports formatPRComment as a function', () => {
    expect(typeof formatPRComment).toBe('function');
  });
});

describe('annotateDriftViolations', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('emits ::error for BLOCKER severity', () => {
    const violation: DriftViolation = {
      file: 'src/index.ts',
      line: 10,
      patternName: 'no-eval',
      snippet: 'eval(code)',
      severity: 'BLOCKER',
      category: 'style',
    };
    annotateDriftViolations([violation]);
    expect(logs[0]).toContain('::error');
    expect(logs[0]).toContain('src/index.ts');
  });

  it('emits ::warning for LOW severity', () => {
    const violation: DriftViolation = {
      file: 'src/util.ts',
      line: 5,
      patternName: 'prefer-const',
      snippet: 'let x = 1',
      severity: 'LOW',
      category: 'style',
    };
    annotateDriftViolations([violation]);
    expect(logs[0]).toContain('::warning');
  });

  it('emits nothing for empty violations', () => {
    annotateDriftViolations([]);
    expect(logs).toHaveLength(0);
  });
});

describe('annotateValidationStatus', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('emits ::error for FAIL status', () => {
    annotateValidationStatus('FAIL', 'trailer missing');
    expect(logs[0]).toContain('::error');
    expect(logs[0]).toContain('trailer missing');
  });

  it('emits ::warning for WARN status', () => {
    annotateValidationStatus('WARN', 'optional trailer absent');
    expect(logs[0]).toContain('::warning');
  });

  it('emits nothing for PASS status', () => {
    annotateValidationStatus('PASS', 'all good');
    expect(logs).toHaveLength(0);
  });
});

describe('formatPRComment', () => {
  it('returns a string containing the status', () => {
    const result = formatPRComment({ status: 'PASS', summary: 'All checks passed' });
    expect(typeof result).toBe('string');
    expect(result).toContain('PASS');
    expect(result).toContain('All checks passed');
  });

  it('includes violations table when violations are provided', () => {
    const violations: DriftViolation[] = [
      { file: 'src/a.ts', line: 1, patternName: 'no-any', snippet: 'any', severity: 'CRITICAL', category: 'types' },
    ];
    const result = formatPRComment({ status: 'FAIL', summary: 'Issues found', violations });
    expect(result).toContain('Violations');
    expect(result).toContain('src/a.ts');
  });

  it('includes suggestions list when suggestions are provided', () => {
    const result = formatPRComment({
      status: 'WARN',
      summary: 'Review needed',
      suggestions: ['Add trailer', 'Run tests'],
    });
    expect(result).toContain('Add trailer');
    expect(result).toContain('Run tests');
  });

  it('includes drift score when score is provided', () => {
    const result = formatPRComment({ status: 'PASS', summary: 'ok', score: 0.87 });
    expect(result).toContain('87%');
  });
});

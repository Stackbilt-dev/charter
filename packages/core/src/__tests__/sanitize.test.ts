import { describe, it, expect } from 'vitest';
import { sanitizeInput } from '../sanitize';
import { sanitizeErrorMessage } from '../errors';

describe('sanitizeInput', () => {
  it('removes null bytes', () => {
    expect(sanitizeInput('hello\x00world')).toBe('helloworld');
  });

  it('removes control characters', () => {
    expect(sanitizeInput('line\x01\x02\x1Fone')).toBe('lineone');
  });

  it('removes DEL character (0x7F)', () => {
    expect(sanitizeInput('test\x7Fvalue')).toBe('testvalue');
  });

  it('preserves normal text', () => {
    expect(sanitizeInput('Hello, World!')).toBe('Hello, World!');
  });

  it('preserves newlines are stripped (control chars)', () => {
    // \n is 0x0A which is in the \x00-\x1F range
    expect(sanitizeInput('line1\nline2')).toBe('line1line2');
  });

  it('truncates at 50000 characters', () => {
    const long = 'a'.repeat(60000);
    expect(sanitizeInput(long)).toHaveLength(50000);
  });

  it('handles empty string', () => {
    expect(sanitizeInput('')).toBe('');
  });
});

describe('sanitizeErrorMessage', () => {
  it('maps SQLITE_CONSTRAINT to safe message', () => {
    expect(sanitizeErrorMessage(new Error('SQLITE_CONSTRAINT: UNIQUE'))).toBe('Database constraint violated');
  });

  it('maps network errors to safe message', () => {
    expect(sanitizeErrorMessage(new Error('fetch failed'))).toBe('Network error - please retry');
  });

  it('maps timeout errors to safe message', () => {
    expect(sanitizeErrorMessage(new Error('request timed out'))).toBe('Request timed out');
  });

  it('maps not found errors', () => {
    expect(sanitizeErrorMessage(new Error('Resource not found'))).toBe('Resource not found');
  });

  it('returns generic message for unknown errors', () => {
    expect(sanitizeErrorMessage(new Error('weird internal thing'))).toBe('An internal error occurred. Please try again.');
  });

  it('handles non-Error values', () => {
    expect(sanitizeErrorMessage('some string error')).toBe('An internal error occurred. Please try again.');
  });
});

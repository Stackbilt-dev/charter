import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveApiKey, API_KEY_ENV_VAR } from '../credentials';

describe('resolveApiKey', () => {
  const originalEnv = process.env[API_KEY_ENV_VAR];

  beforeEach(() => {
    delete process.env[API_KEY_ENV_VAR];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[API_KEY_ENV_VAR];
    } else {
      process.env[API_KEY_ENV_VAR] = originalEnv;
    }
  });

  it('returns env var when set (env wins over stored credentials)', () => {
    process.env[API_KEY_ENV_VAR] = 'ea_test_from_env_12345';

    const result = resolveApiKey();

    expect(result).not.toBeNull();
    expect(result!.source).toBe('env');
    expect(result!.apiKey).toBe('ea_test_from_env_12345');
  });

  it('trims whitespace from the env var', () => {
    process.env[API_KEY_ENV_VAR] = '  sb_test_abc  ';

    const result = resolveApiKey();

    expect(result).not.toBeNull();
    expect(result!.source).toBe('env');
    expect(result!.apiKey).toBe('sb_test_abc');
  });

  it('treats an empty env var as unset (falls through to credentials or null)', () => {
    process.env[API_KEY_ENV_VAR] = '';

    const result = resolveApiKey();

    // We can't predict whether this machine has stored credentials, so we
    // only assert the env path was NOT taken.
    if (result !== null) {
      expect(result.source).toBe('credentials');
    }
  });

  it('treats a whitespace-only env var as unset', () => {
    process.env[API_KEY_ENV_VAR] = '   \t  ';

    const result = resolveApiKey();

    if (result !== null) {
      expect(result.source).toBe('credentials');
    }
  });
});

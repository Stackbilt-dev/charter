import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolate loadCredentials from the developer's real ~/.charter/credentials.json
// by mocking node:fs. Each test configures the fs mock explicitly.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
  };
});

import * as fs from 'node:fs';
import { resolveApiKey, API_KEY_ENV_VAR, API_BASE_URL_ENV_VAR } from '../credentials';

const mockedFs = fs as unknown as {
  existsSync: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
};

function stubStoredCredentials(apiKey: string, baseUrl?: string): void {
  mockedFs.existsSync.mockReturnValue(true);
  mockedFs.readFileSync.mockReturnValue(JSON.stringify({ apiKey, baseUrl }));
}

function stubNoStoredCredentials(): void {
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.readFileSync.mockImplementation(() => {
    throw new Error('readFileSync should not be called when existsSync=false');
  });
}

describe('resolveApiKey', () => {
  const originalKeyEnv = process.env[API_KEY_ENV_VAR];
  const originalBaseUrlEnv = process.env[API_BASE_URL_ENV_VAR];

  beforeEach(() => {
    delete process.env[API_KEY_ENV_VAR];
    delete process.env[API_BASE_URL_ENV_VAR];
    mockedFs.existsSync.mockReset();
    mockedFs.readFileSync.mockReset();
    stubNoStoredCredentials();
  });

  afterEach(() => {
    if (originalKeyEnv === undefined) delete process.env[API_KEY_ENV_VAR];
    else process.env[API_KEY_ENV_VAR] = originalKeyEnv;
    if (originalBaseUrlEnv === undefined) delete process.env[API_BASE_URL_ENV_VAR];
    else process.env[API_BASE_URL_ENV_VAR] = originalBaseUrlEnv;
  });

  it('returns env var when set', () => {
    process.env[API_KEY_ENV_VAR] = 'ea_test_from_env_12345';

    const result = resolveApiKey();

    expect(result).not.toBeNull();
    expect(result!.source).toBe('env');
    expect(result!.apiKey).toBe('ea_test_from_env_12345');
  });

  it('env var wins when both env var and stored credentials are present', () => {
    process.env[API_KEY_ENV_VAR] = 'ea_env_wins';
    stubStoredCredentials('sb_live_should_be_ignored', 'https://stored.example');

    const result = resolveApiKey();

    expect(result).not.toBeNull();
    expect(result!.source).toBe('env');
    expect(result!.apiKey).toBe('ea_env_wins');
  });

  it('trims whitespace from the env var', () => {
    process.env[API_KEY_ENV_VAR] = '  sb_test_abc  ';

    const result = resolveApiKey();

    expect(result).not.toBeNull();
    expect(result!.source).toBe('env');
    expect(result!.apiKey).toBe('sb_test_abc');
  });

  it('empty env var falls through to stored credentials', () => {
    process.env[API_KEY_ENV_VAR] = '';
    stubStoredCredentials('sb_live_from_disk');

    const result = resolveApiKey();

    expect(result).not.toBeNull();
    expect(result!.source).toBe('credentials');
    expect(result!.apiKey).toBe('sb_live_from_disk');
  });

  it('whitespace-only env var falls through to stored credentials', () => {
    process.env[API_KEY_ENV_VAR] = '   \t  ';
    stubStoredCredentials('sb_live_from_disk');

    const result = resolveApiKey();

    expect(result).not.toBeNull();
    expect(result!.source).toBe('credentials');
    expect(result!.apiKey).toBe('sb_live_from_disk');
  });

  it('returns null when neither env var nor stored credentials are present', () => {
    stubNoStoredCredentials();

    const result = resolveApiKey();

    expect(result).toBeNull();
  });

  it('env-var path adopts STACKBILT_API_BASE_URL when set', () => {
    process.env[API_KEY_ENV_VAR] = 'ea_with_custom_url';
    process.env[API_BASE_URL_ENV_VAR] = 'https://engine.internal.example';

    const result = resolveApiKey();

    expect(result).not.toBeNull();
    expect(result!.source).toBe('env');
    expect(result!.baseUrl).toBe('https://engine.internal.example');
  });

  it('env-var path leaves baseUrl undefined when STACKBILT_API_BASE_URL is unset', () => {
    process.env[API_KEY_ENV_VAR] = 'ea_without_custom_url';

    const result = resolveApiKey();

    expect(result).not.toBeNull();
    expect(result!.baseUrl).toBeUndefined();
  });

  it('credentials path carries baseUrl from the stored file', () => {
    stubStoredCredentials('sb_live_from_disk', 'https://engine.custom.example');

    const result = resolveApiKey();

    expect(result).not.toBeNull();
    expect(result!.source).toBe('credentials');
    expect(result!.baseUrl).toBe('https://engine.custom.example');
  });
});

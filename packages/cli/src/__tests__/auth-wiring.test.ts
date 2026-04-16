import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock state: vi.mock factories run before any imports, so the
// EngineClient class mock must reach these via vi.hoisted.
const hoisted = vi.hoisted(() => ({
  buildFn: vi.fn(),
  scaffoldFn: vi.fn(),
  constructorArgs: [] as Array<{ baseUrl?: string; apiKey?: string | null }>,
}));

vi.mock('../credentials', async () => {
  const actual = await vi.importActual<typeof import('../credentials')>('../credentials');
  return { ...actual, resolveApiKey: vi.fn() };
});

vi.mock('../http-client', () => {
  return {
    EngineClient: class {
      constructor(opts: { baseUrl?: string; apiKey?: string | null }) {
        hoisted.constructorArgs.push(opts);
      }
      build = hoisted.buildFn;
      scaffold = hoisted.scaffoldFn;
      health = vi.fn();
      catalog = vi.fn();
    },
  };
});

import { resolveApiKey } from '../credentials';
import { architectCommand } from '../commands/architect';
import { runCommand } from '../commands/run';
import type { CLIOptions } from '../index';

const mockedResolveApiKey = vi.mocked(resolveApiKey);

const options: CLIOptions = {
  format: 'json',
  configPath: '.charter',
  ciMode: false,
  yes: true,
};

function fakeBuildResult() {
  return {
    stack: [],
    compatibility: {
      pairs: [],
      totalScore: 0,
      normalizedScore: 0,
      dominant: '',
      tensions: [],
    },
    scaffold: {},
    seed: 1,
    receipt: 'receipt',
    requirements: {
      description: 'anything',
      keywords: [],
      constraints: {},
      complexity: 'moderate',
    },
  };
}

function fakeScaffoldResult() {
  return {
    files: [],
    fileSource: 'engine' as const,
    nextSteps: [],
  };
}

let tmpCwd: string;

beforeEach(() => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-wiring-'));
  process.chdir(tmpCwd);
  fs.mkdirSync(path.join(tmpCwd, '.charter'), { recursive: true });
  hoisted.buildFn.mockReset().mockResolvedValue(fakeBuildResult());
  hoisted.scaffoldFn.mockReset().mockResolvedValue(fakeScaffoldResult());
  hoisted.constructorArgs.length = 0;
  mockedResolveApiKey.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(os.tmpdir());
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe('architect — auth wiring', () => {
  it('forwards the env-sourced API key (and custom baseUrl) to EngineClient', async () => {
    mockedResolveApiKey.mockReturnValue({
      apiKey: 'ea_env_wiring',
      source: 'env',
      baseUrl: 'https://engine.example',
    });

    await architectCommand(options, ['a simple project description']);

    expect(hoisted.constructorArgs).toHaveLength(1);
    expect(hoisted.constructorArgs[0].apiKey).toBe('ea_env_wiring');
    expect(hoisted.constructorArgs[0].baseUrl).toBe('https://engine.example');
  });

  it('passes apiKey=null to EngineClient when resolveApiKey returns null', async () => {
    mockedResolveApiKey.mockReturnValue(null);

    await architectCommand(options, ['unauthenticated fallback']);

    expect(hoisted.constructorArgs[0].apiKey).toBeNull();
  });
});

describe('run — gateway vs engine routing', () => {
  it('uses the gateway (scaffold) when the env var provides an API key', async () => {
    mockedResolveApiKey.mockReturnValue({ apiKey: 'ea_env_gateway', source: 'env' });

    await runCommand(options, ['a description', '--dry-run']);

    expect(hoisted.scaffoldFn).toHaveBeenCalledTimes(1);
    expect(hoisted.buildFn).not.toHaveBeenCalled();
  });

  it('falls back to engine /build when no API key is resolved', async () => {
    mockedResolveApiKey.mockReturnValue(null);

    await runCommand(options, ['a description', '--dry-run']);

    expect(hoisted.buildFn).toHaveBeenCalledTimes(1);
    expect(hoisted.scaffoldFn).not.toHaveBeenCalled();
  });

  it('uses the gateway when login-stored credentials are resolved (parity with env path)', async () => {
    mockedResolveApiKey.mockReturnValue({ apiKey: 'sb_live_stored', source: 'credentials' });

    await runCommand(options, ['a description', '--dry-run']);

    expect(hoisted.scaffoldFn).toHaveBeenCalledTimes(1);
    expect(hoisted.buildFn).not.toHaveBeenCalled();
  });
});

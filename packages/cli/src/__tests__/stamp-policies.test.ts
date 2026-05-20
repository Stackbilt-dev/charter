import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { stampPoliciesCommand } from '../commands/stamp-policies';
import type { CLIOptions } from '../index';

// Mock @stackbilt/policies so no real fs writes or network calls happen
vi.mock('@stackbilt/policies', () => ({
  applyPolicies: vi.fn(),
}));

// Mock child_process for resolveStackbiltLlcRef
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));

import { applyPolicies } from '@stackbilt/policies';
import { exec } from 'node:child_process';

const mockApply = vi.mocked(applyPolicies);
const mockExec = vi.mocked(exec);

function makeOptions(overrides: Partial<CLIOptions> = {}): CLIOptions {
  return { configPath: '.charter', format: 'text', ciMode: false, yes: false, ...overrides };
}

const FAKE_REF = 'a'.repeat(40);
const fakeConfig = { packageManager: 'npm' as const, nodeVersion: '20', existingWorkflows: [], floatingPins: [], hasSupplyChainWorkflow: false };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: exec succeeds with fake SHA
  mockExec.mockImplementation((_cmd: unknown, _opts: unknown, cb: unknown) => {
    (cb as (e: null, out: string) => void)(null, `${FAKE_REF}\tHEAD\n`);
    return {} as ReturnType<typeof exec>;
  });
  // Default: apply returns updated
  mockApply.mockResolvedValue({
    config: fakeConfig,
    pinsPatched: 2,
    workflowsPatched: ['.github/workflows/ci.yml'],
    supplyChainWorkflowAdded: true,
    charterConfigUpdated: true,
    alreadyCompliant: false,
  });
});

describe('stampPoliciesCommand', () => {
  it('uses --policy-repo-ref directly without calling git ls-remote', async () => {
    const code = await stampPoliciesCommand(
      makeOptions(),
      ['--policy-repo-ref', FAKE_REF, '--path', '/tmp'],
    );
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockApply).toHaveBeenCalledWith('/tmp', expect.objectContaining({ policyRepoRef: FAKE_REF }));
    expect(code).toBe(0);
  });

  it('calls git ls-remote when --policy-repo-ref is absent', async () => {
    await stampPoliciesCommand(makeOptions(), ['--policy-repo-ref', FAKE_REF]);
    // Verify applyPolicies received the ref
    expect(mockApply).toHaveBeenCalledWith('.', expect.objectContaining({ policyRepoRef: FAKE_REF }));
  });

  it('returns RUNTIME_ERROR when git ls-remote fails and no explicit ref', async () => {
    mockExec.mockImplementation((_cmd: unknown, _opts: unknown, cb: unknown) => {
      (cb as (e: Error, out: string) => void)(new Error('network'), '');
      return {} as ReturnType<typeof exec>;
    });
    const code = await stampPoliciesCommand(makeOptions(), []);
    expect(code).toBe(2);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('passes --dry-run through to applyPolicies', async () => {
    await stampPoliciesCommand(makeOptions(), ['--policy-repo-ref', FAKE_REF, '--dry-run']);
    expect(mockApply).toHaveBeenCalledWith('.', expect.objectContaining({ dryRun: true }));
  });

  it('passes --no-fix-pins as fixPins: false', async () => {
    await stampPoliciesCommand(makeOptions(), ['--policy-repo-ref', FAKE_REF, '--no-fix-pins']);
    expect(mockApply).toHaveBeenCalledWith('.', expect.objectContaining({ fixPins: false }));
  });

  it('returns exit 0 when already compliant', async () => {
    mockApply.mockResolvedValue({
      config: fakeConfig,
      pinsPatched: 0,
      workflowsPatched: [],
      supplyChainWorkflowAdded: false,
      charterConfigUpdated: false,
      alreadyCompliant: true,
    });
    const code = await stampPoliciesCommand(makeOptions(), ['--policy-repo-ref', FAKE_REF]);
    expect(code).toBe(0);
  });

  it('emits JSON output when format is json', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg); });
    const code = await stampPoliciesCommand(
      makeOptions({ format: 'json' }),
      ['--policy-repo-ref', FAKE_REF],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.find((l) => l.startsWith('{')) ?? '{}');
    expect(parsed.status).toBe('UPDATED');
    expect(parsed.pinsPatched).toBe(2);
    expect(parsed.policyRepoRef).toBe(FAKE_REF);
    vi.restoreAllMocks();
  });

  it('returns RUNTIME_ERROR when applyPolicies throws', async () => {
    mockApply.mockRejectedValue(new Error('disk full'));
    const code = await stampPoliciesCommand(makeOptions(), ['--policy-repo-ref', FAKE_REF]);
    expect(code).toBe(2);
  });
});

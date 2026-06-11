import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectRepoConfig } from '../detect';
import { patchFloatingActionPins } from '../patch';
import { generateCallerWorkflow, generateCharterConfigPatch } from '../generate';
import { applyPolicies, PolicyGovernanceGate } from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policies-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

const FAKE_SHA = 'a'.repeat(40);

// Mock child_process.exec so tests never hit GitHub.
// Returns a line for each ref type so both tag (@vN) and branch (@main) lookups resolve.
vi.mock('node:child_process', () => ({
  exec: (
    cmd: string,
    _opts: unknown,
    cb: (err: null, stdout: string) => void,
  ) => {
    const tagM = cmd.match(/"refs\/tags\/([^"^]+)"/);
    const branchM = cmd.match(/"refs\/heads\/([^"]+)"/);
    const lines: string[] = [];
    if (tagM) lines.push(`${FAKE_SHA}\trefs/tags/${tagM[1]}`);
    if (branchM) lines.push(`${FAKE_SHA}\trefs/heads/${branchM[1]}`);
    cb(null, (lines.length ? lines.join('\n') : `${FAKE_SHA}\trefs/tags/v4`) + '\n');
  },
}));

// ---------------------------------------------------------------------------
// detectRepoConfig
// ---------------------------------------------------------------------------

describe('detectRepoConfig', () => {
  it('detects npm + node version from ci.yml matrix', () => {
    const dir = makeTempRepo({
      'package.json': '{}',
      '.github/workflows/ci.yml': `
jobs:
  test:
    strategy:
      matrix:
        node-version: [18, 20, 22]
`,
    });
    const config = detectRepoConfig(dir);
    expect(config.packageManager).toBe('npm');
    expect(config.nodeVersion).toBe('22');
  });

  it('detects pnpm from pnpm-lock.yaml', () => {
    const dir = makeTempRepo({ 'pnpm-lock.yaml': '' });
    expect(detectRepoConfig(dir).packageManager).toBe('pnpm');
  });

  it('detects floating pins in workflow — tags and branch refs', () => {
    const dir = makeTempRepo({
      '.github/workflows/ci.yml': `
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
  - uses: actions/cache@main
`,
    });
    const config = detectRepoConfig(dir);
    expect(config.floatingPins).toHaveLength(3);
    expect(config.floatingPins[0].tag).toBe('v4');
    expect(config.floatingPins[2].tag).toBe('main');
  });

  it('does not flag SHA-pinned or local refs as floating', () => {
    const dir = makeTempRepo({
      '.github/workflows/ci.yml': `
steps:
  - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
  - uses: ./.github/workflows/helper.yml
  - uses: Stackbilt-dev/stackbilt_llc/.github/workflows/sbom.yml@abc123
`,
    });
    expect(detectRepoConfig(dir).floatingPins).toHaveLength(0);
  });

  it('detects existing supply-chain.yml', () => {
    const dir = makeTempRepo({ '.github/workflows/supply-chain.yml': 'name: SC' });
    expect(detectRepoConfig(dir).hasSupplyChainWorkflow).toBe(true);
  });

  it('defaults node version to 20 when no hints', () => {
    const dir = makeTempRepo({ 'package.json': '{}' });
    expect(detectRepoConfig(dir).nodeVersion).toBe('20');
  });
});

// ---------------------------------------------------------------------------
// patchFloatingActionPins
// ---------------------------------------------------------------------------

describe('patchFloatingActionPins', () => {
  it('replaces floating tag with mocked SHA + comment', async () => {
    const content = `steps:\n  - uses: actions/checkout@v4\n`;
    const { patched, replacements } = await patchFloatingActionPins(content);
    expect(replacements).toHaveLength(1);
    expect(patched).toContain(`actions/checkout@${FAKE_SHA} # v4`);
  });

  it('replaces @main branch ref with mocked SHA + comment', async () => {
    const content = `steps:\n  - uses: actions/cache@main\n`;
    const { patched, replacements } = await patchFloatingActionPins(content);
    expect(replacements).toHaveLength(1);
    expect(patched).toContain(`actions/cache@${FAKE_SHA} # main`);
  });

  it('leaves SHA-pinned lines unchanged', async () => {
    const content = `  - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4\n`;
    const { replacements } = await patchFloatingActionPins(content);
    expect(replacements).toHaveLength(0);
  });

  it('leaves Stackbilt-dev and local refs unchanged', async () => {
    const content = [
      '  - uses: Stackbilt-dev/stackbilt_llc/.github/workflows/sbom.yml@abc123',
      '  - uses: ./.github/workflows/helper.yml',
    ].join('\n');
    const { replacements } = await patchFloatingActionPins(content);
    expect(replacements).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// generateCallerWorkflow
// ---------------------------------------------------------------------------

describe('generateCallerWorkflow', () => {
  it('includes policyRepoRef in uses paths', () => {
    const config = {
      packageManager: 'npm' as const,
      nodeVersion: '22',
      existingWorkflows: [],
      floatingPins: [],
      hasSupplyChainWorkflow: false,
    };
    const out = generateCallerWorkflow(config, 'abc123sha456');
    expect(out).toContain('supply-chain-sbom.yml@abc123sha456');
    expect(out).toContain('supply-chain-dep-review.yml@abc123sha456');
    expect(out).toContain("node-version: '22'");
    expect(out).toContain("package-manager: 'npm'");
  });
});

// ---------------------------------------------------------------------------
// generateCharterConfigPatch
// ---------------------------------------------------------------------------

describe('generateCharterConfigPatch', () => {
  it('enables drift with yaml include on null config', () => {
    const result = generateCharterConfigPatch(null);
    expect((result.drift as { enabled: boolean }).enabled).toBe(true);
    expect((result.drift as { include: string[] }).include).toContain('.github/workflows/*.yml');
  });

  it('preserves existing includes and adds yaml glob', () => {
    const existing = { drift: { enabled: false, include: ['**/*.ts'] } };
    const result = generateCharterConfigPatch(existing);
    expect((result.drift as { include: string[] }).include).toContain('**/*.ts');
    expect((result.drift as { include: string[] }).include).toContain('.github/workflows/*.yml');
  });

  it('does not duplicate yaml glob if already present', () => {
    const existing = { drift: { enabled: true, include: ['.github/workflows/*.yml'] } };
    const result = generateCharterConfigPatch(existing);
    const inc = (result.drift as { include: string[] }).include;
    expect(inc.filter((x) => x === '.github/workflows/*.yml')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// applyPolicies (integration — filesystem, mocked network)
// ---------------------------------------------------------------------------

describe('applyPolicies', () => {
  it('dry-run: reports changes without writing files', async () => {
    const dir = makeTempRepo({
      '.github/workflows/ci.yml': `steps:\n  - uses: actions/checkout@v4\n`,
    });
    const result = await applyPolicies(dir, {
      dryRun: true,
      fixPins: true,
      policyRepoRef: 'testref123',
    });
    // Supply-chain.yml should NOT be written
    expect(fs.existsSync(path.join(dir, '.github/workflows/supply-chain.yml'))).toBe(false);
    expect(result.supplyChainWorkflowAdded).toBe(true);
    expect(result.pinsPatched).toBe(1);
  });

  it('applies: patches pins and creates supply-chain.yml and charter config', async () => {
    const dir = makeTempRepo({
      '.github/workflows/ci.yml': `steps:\n  - uses: actions/checkout@v4\n`,
    });
    const result = await applyPolicies(dir, {
      dryRun: false,
      fixPins: true,
      policyRepoRef: 'testref123',
    });
    // supply-chain.yml created
    expect(fs.existsSync(path.join(dir, '.github/workflows/supply-chain.yml'))).toBe(true);
    // pin patched
    const ciContent = fs.readFileSync(path.join(dir, '.github/workflows/ci.yml'), 'utf-8');
    expect(ciContent).toContain(`@${FAKE_SHA} # v4`);
    // charter config created
    expect(fs.existsSync(path.join(dir, '.charter/config.json'))).toBe(true);
    // floating-action-pins pattern installed
    expect(fs.existsSync(path.join(dir, '.charter/patterns/floating-action-pins.json'))).toBe(true);
    expect(result.alreadyCompliant).toBe(false);
  });

  it('already-compliant: no changes, alreadyCompliant true (#200 idempotency)', async () => {
    const dir = makeTempRepo({
      '.github/workflows/supply-chain.yml': 'name: SC',
      '.github/workflows/ci.yml': `steps:\n  - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4\n`,
      '.charter/config.json': JSON.stringify({
        drift: { enabled: true, include: ['.github/workflows/*.yml'] },
      }),
      '.charter/patterns/floating-action-pins.json': '{}',
    });
    const result = await applyPolicies(dir, {
      dryRun: false,
      fixPins: true,
      policyRepoRef: 'testref123',
    });
    expect(result.alreadyCompliant).toBe(true);
    expect(result.pinsPatched).toBe(0);
    expect(result.supplyChainWorkflowAdded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PolicyGovernanceGate — authority-gated governance contract (#200)
// ---------------------------------------------------------------------------

describe('PolicyGovernanceGate', () => {
  const GATE_OPTS = { fixPins: true, policyRepoRef: 'testref123' };

  it('propose() returns a proposal without writing files', async () => {
    const dir = makeTempRepo({
      '.github/workflows/ci.yml': `steps:\n  - uses: actions/checkout@v4\n`,
    });
    const gate = new PolicyGovernanceGate(GATE_OPTS);
    const proposal = await gate.propose(dir);

    expect(proposal.alreadyCompliant).toBe(false);
    expect(proposal.delta.length).toBeGreaterThan(0);
    expect(proposal.id).toMatch(/^[0-9a-f]{16}$/);
    expect(proposal.repoPath).toBe(dir);
    // Gate must not have written anything
    expect(fs.existsSync(path.join(dir, '.github/workflows/supply-chain.yml'))).toBe(false);
  });

  it('propose() is idempotent — same repo state yields same proposal id', async () => {
    const dir = makeTempRepo({
      '.github/workflows/ci.yml': `steps:\n  - uses: actions/checkout@v4\n`,
    });
    const gate = new PolicyGovernanceGate(GATE_OPTS);
    const first = await gate.propose(dir);
    const second = await gate.propose(dir);
    expect(first.id).toBe(second.id);
    expect(first.delta).toEqual(second.delta);
  });

  it('commit(approve) writes files and returns a receipt', async () => {
    const dir = makeTempRepo({
      '.github/workflows/ci.yml': `steps:\n  - uses: actions/checkout@v4\n`,
    });
    const gate = new PolicyGovernanceGate(GATE_OPTS);
    const proposal = await gate.propose(dir);
    const receipt = await gate.commit(proposal, 'approve');

    expect(receipt.proposalId).toBe(proposal.id);
    expect(receipt.decision).toBe('approve');
    expect(typeof receipt.committedAt).toBe('number');
    expect(receipt.committedAt).toBeGreaterThan(0);
    // Files must have been written
    expect(fs.existsSync(path.join(dir, '.github/workflows/supply-chain.yml'))).toBe(true);
  });

  it('commit(dismiss) emits a receipt but does NOT write files', async () => {
    const dir = makeTempRepo({
      '.github/workflows/ci.yml': `steps:\n  - uses: actions/checkout@v4\n`,
    });
    const gate = new PolicyGovernanceGate(GATE_OPTS);
    const proposal = await gate.propose(dir);
    const receipt = await gate.commit(proposal, 'dismiss');

    expect(receipt.decision).toBe('dismiss');
    expect(receipt.proposalId).toBe(proposal.id);
    // Gate must have left state unchanged
    expect(fs.existsSync(path.join(dir, '.github/workflows/supply-chain.yml'))).toBe(false);
  });

  it('commit(override) applies changes even when alreadyCompliant', async () => {
    const dir = makeTempRepo({
      '.github/workflows/supply-chain.yml': 'name: SC',
      '.github/workflows/ci.yml': `steps:\n  - uses: actions/checkout@${FAKE_SHA} # v4\n`,
      '.charter/config.json': JSON.stringify({
        drift: { enabled: true, include: ['.github/workflows/*.yml'] },
      }),
      '.charter/patterns/floating-action-pins.json': '{}',
    });
    const gate = new PolicyGovernanceGate(GATE_OPTS);
    const proposal = await gate.propose(dir);
    expect(proposal.alreadyCompliant).toBe(true);

    // override should still emit a receipt without throwing
    const receipt = await gate.commit(proposal, 'override');
    expect(receipt.decision).toBe('override');
    expect(receipt.proposalId).toBe(proposal.id);
  });

  it('alreadyCompliant proposal has an empty delta', async () => {
    const dir = makeTempRepo({
      '.github/workflows/supply-chain.yml': 'name: SC',
      '.github/workflows/ci.yml': `steps:\n  - uses: actions/checkout@${FAKE_SHA} # v4\n`,
      '.charter/config.json': JSON.stringify({
        drift: { enabled: true, include: ['.github/workflows/*.yml'] },
      }),
      '.charter/patterns/floating-action-pins.json': '{}',
    });
    const gate = new PolicyGovernanceGate(GATE_OPTS);
    const proposal = await gate.propose(dir);
    expect(proposal.alreadyCompliant).toBe(true);
    expect(proposal.delta).toHaveLength(0);
  });
});

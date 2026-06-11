import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectRepoConfig } from './detect';
import { patchFloatingActionPins } from './patch';
import { generateCallerWorkflow, generateCharterConfigPatch, FLOATING_PIN_PATTERN } from './generate';
import type { GovernanceGate, GovernanceProposal, GovernanceReceipt, GovernanceDecision } from '@stackbilt/types';

export { detectRepoConfig } from './detect';
export { patchFloatingActionPins } from './patch';
export { generateCallerWorkflow, generateCharterConfigPatch, FLOATING_PIN_PATTERN } from './generate';
export type { RepoConfig, FloatingPin } from './detect';
export type { PatchResult, PatchReplacement } from './patch';
export type { GovernanceDecision, GovernanceProposal, GovernanceReceipt, GovernanceGate } from '@stackbilt/types';

export interface StampOptions {
  dryRun: boolean;
  fixPins: boolean;
  policyRepoRef: string;
}

export interface PolicyStampResult {
  config: ReturnType<typeof detectRepoConfig>;
  pinsPatched: number;
  workflowsPatched: string[];
  supplyChainWorkflowAdded: boolean;
  charterConfigUpdated: boolean;
  alreadyCompliant: boolean;
}

export async function applyPolicies(repoPath: string, opts: StampOptions): Promise<PolicyStampResult> {
  const abs = path.resolve(repoPath);
  const config = detectRepoConfig(abs);

  const workflowsPatched: string[] = [];
  let pinsPatched = 0;

  // 1. Patch floating pins in existing workflows
  if (opts.fixPins && config.floatingPins.length > 0) {
    for (const wfPath of config.existingWorkflows) {
      const content = fs.readFileSync(wfPath, 'utf-8');
      const { patched, replacements } = await patchFloatingActionPins(content);
      if (replacements.length > 0) {
        if (!opts.dryRun) fs.writeFileSync(wfPath, patched, 'utf-8');
        workflowsPatched.push(wfPath);
        pinsPatched += replacements.length;
      }
    }
  }

  // 2. Add supply-chain.yml caller workflow
  let supplyChainWorkflowAdded = false;
  if (!config.hasSupplyChainWorkflow) {
    const workflowContent = generateCallerWorkflow(config, opts.policyRepoRef);
    const wfDir = path.join(abs, '.github', 'workflows');
    if (!opts.dryRun) {
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(path.join(wfDir, 'supply-chain.yml'), workflowContent, 'utf-8');
    }
    supplyChainWorkflowAdded = true;
  }

  // 3. Install floating-action-pins drift pattern + update charter config
  let charterConfigUpdated = false;
  const charterDir = path.join(abs, '.charter');
  const patternsDir = path.join(charterDir, 'patterns');
  const patternFile = path.join(patternsDir, 'floating-action-pins.json');
  const configFile = path.join(charterDir, 'config.json');

  const patternMissing = !fs.existsSync(patternFile);
  const configNeedsUpdate = !charterConfigHasYamlDrift(configFile);

  if (patternMissing || configNeedsUpdate) {
    if (!opts.dryRun) {
      fs.mkdirSync(patternsDir, { recursive: true });
      if (patternMissing) {
        fs.writeFileSync(patternFile, JSON.stringify(FLOATING_PIN_PATTERN, null, 2) + '\n', 'utf-8');
      }
      if (configNeedsUpdate) {
        const existing = fs.existsSync(configFile)
          ? (JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>)
          : null;
        const updated = generateCharterConfigPatch(existing);
        fs.writeFileSync(configFile, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
      }
    }
    charterConfigUpdated = true;
  }

  const alreadyCompliant = !supplyChainWorkflowAdded && pinsPatched === 0 && !charterConfigUpdated;

  return { config, pinsPatched, workflowsPatched, supplyChainWorkflowAdded, charterConfigUpdated, alreadyCompliant };
}

// ============================================================================
// Authority-Gated Governance implementation (#200)
// ============================================================================

/**
 * Extends GovernanceProposal with the repo path needed to replay the commit.
 * The gate stores this internally — callers receive the base GovernanceProposal
 * shape and pass it back to commit() opaquely.
 */
export interface PolicyGovernanceProposal extends GovernanceProposal {
  /** Absolute repo path — carried so commit() can re-evaluate against the same target. */
  readonly repoPath: string;
}

/**
 * Implements GovernanceGate<string> for supply-chain policy stamping.
 *
 * Enforces the propose→gate→commit invariant:
 *   - propose() runs detection + dry-run; never writes files.
 *   - commit('approve'|'override') applies the stamping. 'dismiss' is a no-op.
 *   - Every commit() emits a GovernanceReceipt regardless of decision.
 *
 * Usage:
 *   const gate = new PolicyGovernanceGate({ fixPins: true, policyRepoRef: sha });
 *   const proposal = await gate.propose('./my-repo');
 *   if (!proposal.alreadyCompliant) {
 *     const receipt = await gate.commit(proposal, 'approve');
 *   }
 */
export class PolicyGovernanceGate implements GovernanceGate<string, PolicyGovernanceProposal> {
  constructor(private readonly opts: Omit<StampOptions, 'dryRun'>) {}

  async propose(repoPath: string): Promise<PolicyGovernanceProposal> {
    const result = await applyPolicies(repoPath, { ...this.opts, dryRun: true });
    const delta = buildPolicyDelta(result);
    const id = crypto
      .createHash('sha256')
      .update(path.resolve(repoPath) + '\n' + delta.join('\n'))
      .digest('hex')
      .slice(0, 16);
    return { id, alreadyCompliant: result.alreadyCompliant, delta, repoPath };
  }

  async commit(proposal: PolicyGovernanceProposal, decision: GovernanceDecision): Promise<GovernanceReceipt> {
    if (decision !== 'dismiss') {
      await applyPolicies(proposal.repoPath, { ...this.opts, dryRun: false });
    }
    return { proposalId: proposal.id, decision, committedAt: Date.now() };
  }
}

function buildPolicyDelta(result: PolicyStampResult): string[] {
  const delta: string[] = [];
  if (result.supplyChainWorkflowAdded) {
    delta.push('add .github/workflows/supply-chain.yml');
  }
  if (result.pinsPatched > 0) {
    delta.push(`patch ${result.pinsPatched} floating action pin(s) in: ${result.workflowsPatched.join(', ')}`);
  }
  if (result.charterConfigUpdated) {
    delta.push('update .charter/ (drift pattern + config)');
  }
  return delta;
}

function charterConfigHasYamlDrift(configFile: string): boolean {
  if (!fs.existsSync(configFile)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
    const drift = parsed.drift as Record<string, unknown> | undefined;
    if (!drift?.enabled) return false;
    const include = drift.include as string[] | undefined;
    return (include ?? []).some((g) => g.includes('.yml') || g.includes('.yaml'));
  } catch {
    return false;
  }
}

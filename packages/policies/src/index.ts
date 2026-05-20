import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectRepoConfig } from './detect';
import { patchFloatingActionPins } from './patch';
import { generateCallerWorkflow, generateCharterConfigPatch, FLOATING_PIN_PATTERN } from './generate';

export { detectRepoConfig } from './detect';
export { patchFloatingActionPins } from './patch';
export { generateCallerWorkflow, generateCharterConfigPatch, FLOATING_PIN_PATTERN } from './generate';
export type { RepoConfig, FloatingPin } from './detect';
export type { PatchResult, PatchReplacement } from './patch';

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

/**
 * charter stamp-policies
 *
 * Stamps supply chain CI policies onto a target repo:
 *   1. Patches floating action pins (@vN) to full commit SHAs
 *   2. Adds .github/workflows/supply-chain.yml (SBOM + dep-review callers)
 *   3. Installs .charter/patterns/floating-action-pins.json
 *   4. Updates .charter/config.json to enable drift on workflow YAML files
 *
 * Reusable workflows sourced from Stackbilt-dev/stackbilt_llc (Stackbilt-dev/stackbilt_llc#11).
 * All output commits should carry: Governed-By: Stackbilt-dev/stackbilt_llc#11
 */

import { exec } from 'node:child_process';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { applyPolicies } from '@stackbilt/policies';

export async function stampPoliciesCommand(options: CLIOptions, args: string[]): Promise<number> {
  const repoPath = getFlag(args, '--path') ?? '.';
  const dryRun = args.includes('--dry-run');
  const fixPins = !args.includes('--no-fix-pins');
  const explicitRef = getFlag(args, '--policy-repo-ref');
  const envRef = process.env.CHARTER_POLICY_REPO_REF?.trim();
  const recoveryCommand = 'npx charter stamp-policies --policy-repo-ref <sha>';

  let policyRepoRef: string;
  if (explicitRef) {
    policyRepoRef = explicitRef;
  } else if (envRef) {
    policyRepoRef = envRef;
  } else {
    const resolved = await resolveStackbiltLlcRef();
    if (!resolved) {
      if (options.format === 'json') {
        console.log(JSON.stringify({
          status: 'ERROR',
          error: {
            code: 'POLICY_REPO_REF_UNRESOLVED',
            message: 'Could not resolve Stackbilt-dev/stackbilt_llc HEAD SHA.',
            hint: 'Pass --policy-repo-ref <sha> or set CHARTER_POLICY_REPO_REF.',
            recoveryCommand,
          },
        }, null, 2));
      } else {
        console.error(
          '  [error] Could not resolve Stackbilt-dev/stackbilt_llc HEAD SHA.\n' +
          '          Pass --policy-repo-ref <sha> to override.\n' +
          `          Recovery: ${recoveryCommand}`,
        );
      }
      return EXIT_CODE.RUNTIME_ERROR;
    }
    policyRepoRef = resolved;
  }

  if (!options.ciMode) {
    console.log(`\n  charter stamp-policies`);
    console.log(`  Path:             ${repoPath}`);
    console.log(`  Dry run:          ${dryRun}`);
    console.log(`  Fix pins:         ${fixPins}`);
    console.log(`  Policy repo ref:  ${policyRepoRef.slice(0, 12)}...`);
    if (dryRun) console.log('\n  [dry-run] No files will be written.\n');
  }

  let result;
  try {
    result = await applyPolicies(repoPath, { dryRun, fixPins, policyRepoRef });
  } catch (err) {
    console.error(`  [error] ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_CODE.RUNTIME_ERROR;
  }

  if (options.format === 'json') {
    console.log(JSON.stringify({
      status: result.alreadyCompliant ? 'COMPLIANT' : 'UPDATED',
      dryRun,
      pinsPatched: result.pinsPatched,
      workflowsPatched: result.workflowsPatched,
      supplyChainWorkflowAdded: result.supplyChainWorkflowAdded,
      charterConfigUpdated: result.charterConfigUpdated,
      alreadyCompliant: result.alreadyCompliant,
      policyRepoRef,
    }, null, 2));
    return EXIT_CODE.SUCCESS;
  }

  if (result.alreadyCompliant) {
    console.log('\n  [ok] Repo is already compliant — nothing to do.\n');
    return EXIT_CODE.SUCCESS;
  }

  console.log('\n  Changes' + (dryRun ? ' (dry-run — not written)' : '') + ':');

  if (result.pinsPatched > 0) {
    console.log(`\n  Pinned ${result.pinsPatched} floating action tag(s) to commit SHAs:`);
    for (const wf of result.workflowsPatched) {
      console.log(`    ${wf}`);
    }
  }

  if (result.supplyChainWorkflowAdded) {
    console.log(`\n  Added: .github/workflows/supply-chain.yml`);
    console.log(`    SBOM:        Stackbilt-dev/stackbilt_llc/.github/workflows/supply-chain-sbom.yml@${policyRepoRef.slice(0, 12)}...`);
    console.log(`    Dep review:  Stackbilt-dev/stackbilt_llc/.github/workflows/supply-chain-dep-review.yml@${policyRepoRef.slice(0, 12)}...`);
  }

  if (result.charterConfigUpdated) {
    console.log(`\n  Updated: .charter/ (drift pattern + config patch)`);
    console.log(`    Installed:  .charter/patterns/floating-action-pins.json`);
    console.log(`    Config:     drift.enabled = true, include += .github/workflows/*.yml`);
  }

  console.log('\n  [!] Cross-repo reusable workflows in a private GitHub org require:');
  console.log('      Org Settings → Actions → General → "Allow all actions and reusable workflows"');
  console.log('      or the caller repo must be listed under allowed repositories.\n');

  console.log('  Commit with:');
  console.log('    Governed-By: Stackbilt-dev/stackbilt_llc#11\n');

  return EXIT_CODE.SUCCESS;
}

function resolveStackbiltLlcRef(): Promise<string | null> {
  return new Promise((resolve) => {
    exec(
      'git ls-remote https://github.com/Stackbilt-dev/stackbilt_llc HEAD',
      { timeout: 20000 },
      (err, stdout) => {
        if (err || !stdout.trim()) { resolve(null); return; }
        const sha = stdout.trim().split('\t')[0];
        resolve(sha.length === 40 ? sha : null);
      },
    );
  });
}

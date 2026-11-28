/**
 * charter adf context
 *
 * Resolves ADF modules based on file paths and/or explicit keywords.
 * Outputs the resolved module list and optionally the bundled context.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseAdf,
  parseManifest,
  resolveModules,
  bundleModules,
  buildTriggerReport,
  formatAdf,
} from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag, tokenizeTask } from '../flags';
import { recordAdfResolutionEvent } from '../telemetry';
import { filePathRoutingKeywords, filePathToKeywords, resolvePathTokenRoot } from './adf-path-tokens';
import { computeFileCeilings } from './adf-ceilings';
import type { FileCeiling } from './adf-ceilings';

// Re-exported for existing importers; the implementation lives in adf-path-tokens.ts.
export { filePathToKeywords };

export function adfContextCommand(options: CLIOptions, args: string[]): number {
  const filesFlag = getFlag(args, '--files');
  const keywordsFlag = getFlag(args, '--keywords');
  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const bundle = args.includes('--bundle');

  if (!filesFlag && !keywordsFlag) {
    throw new CLIError(
      'adf context requires --files <path,...> and/or --keywords <kw,...>.\n' +
      'Usage: charter adf context --files src/components/Button.tsx,src/api/handler.ts'
    );
  }

  const manifestPath = path.join(aiDir, 'manifest.adf');
  if (!fs.existsSync(manifestPath)) {
    throw new CLIError(`manifest.adf not found at ${manifestPath}. Run: charter adf init`);
  }

  // Collect keywords from both sources
  const allKeywords: string[] = [];
  if (filesFlag) {
    const filePaths = filesFlag.split(',').map(f => f.trim()).filter(Boolean);
    // Extension/directory signals and the path's own name tokens (e.g. `adf`,
    // `manifest`), all from the repo-relative path so checkout-root dirs
    // never route -- see adf-path-tokens.ts.
    allKeywords.push(...filePathRoutingKeywords(filePaths, { root: resolvePathTokenRoot(aiDir) }));
  }
  if (keywordsFlag) {
    allKeywords.push(...tokenizeTask(keywordsFlag));
  }

  const dedupKeywords = [...new Set(allKeywords)];

  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  const manifestDoc = parseAdf(manifestContent);
  const manifest = parseManifest(manifestDoc);

  const resolvedModules = resolveModules(manifest, dedupKeywords);
  const candidateModules = manifest.onDemand.map(m => m.path);

  if (bundle) {
    // Full bundle output. bundleModules already joins aiDir onto each module
    // path before calling readFile, so read the path as given (#439).
    const readFile = (resolvedPath: string): string => fs.readFileSync(resolvedPath, 'utf-8');

    const result = bundleModules(aiDir, resolvedModules, readFile, dedupKeywords, manifest);

    recordAdfResolutionEvent(options.configPath, {
      source: 'context',
      keywords: dedupKeywords,
      candidateModules,
      resolvedModules: result.resolvedModules,
      triggerMatches: result.triggerMatches,
      tokenEstimate: result.tokenEstimate,
    });

    if (options.format === 'json') {
      console.log(JSON.stringify({
        keywords: dedupKeywords,
        resolvedModules: result.resolvedModules,
        tokenEstimate: result.tokenEstimate,
        triggerMatches: result.triggerMatches,
        content: formatAdf(result.mergedDocument),
        ...ceilingsField(aiDir, manifest, filesFlag),
      }, null, 2));
    } else {
      console.log(formatAdf(result.mergedDocument));
    }
  } else {
    // Module list only
    const triggerMatches = buildTriggerReport(manifest, resolvedModules, dedupKeywords);
    recordAdfResolutionEvent(options.configPath, {
      source: 'context',
      keywords: dedupKeywords,
      candidateModules,
      resolvedModules,
      triggerMatches,
    });

    if (options.format === 'json') {
      console.log(JSON.stringify({
        keywords: dedupKeywords,
        resolvedModules,
        triggerMatches,
        ...ceilingsField(aiDir, manifest, filesFlag),
      }, null, 2));
    } else {
      console.log(`  Keywords: ${dedupKeywords.join(', ')}`);
      console.log(`  Resolved modules:`);
      for (const mod of resolvedModules) {
        const isDefault = manifest.defaultLoad.includes(mod);
        console.log(`    ${mod} (${isDefault ? 'DEFAULT' : 'ON_DEMAND'})`);
      }
      printCeilings(ceilingsField(aiDir, manifest, filesFlag).ceilings);
    }
  }

  return EXIT_CODE.SUCCESS;
}

/**
 * Live ceiling headroom (#443) for `--files` entries that map to a manifest
 * METRICS source. Additive: the key is present only when --files was given.
 */
function ceilingsField(
  aiDir: string,
  manifest: ReturnType<typeof parseManifest>,
  filesFlag: string | undefined,
): { ceilings?: FileCeiling[] } {
  if (!filesFlag) return {};
  const files = filesFlag.split(',').map(f => f.trim()).filter(Boolean);
  return { ceilings: computeFileCeilings(aiDir, manifest, files) };
}

function printCeilings(ceilings: FileCeiling[] | undefined): void {
  if (!ceilings || ceilings.length === 0) return;
  console.log('  Ceilings:');
  for (const c of ceilings) {
    console.log(`    [${c.status}] ${c.file}: ${c.value} / ${c.ceiling} (${c.metric}, headroom ${c.headroom}, ${c.module})`);
  }
}

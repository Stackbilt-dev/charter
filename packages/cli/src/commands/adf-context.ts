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
import { fileRoutingKeywords, resolvePathTokenRoot } from './adf-path-tokens';
import { preflightAnswer, splitFiles } from './adf-preflight';
import type { Preflight } from './adf-preflight';

// Moved to the leaf module adf-path-tokens.ts (breaks the
// index -> serve -> project-context -> adf-context -> index cycle); re-exported
// here so existing imports keep working.
export { filePathToKeywords } from './adf-path-tokens';

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
  // One repo-root lookup (memoized) for routing, rules, ceilings and labels.
  const cwd = process.cwd();
  const files = filesFlag ? splitFiles(filesFlag) : [];
  const root = filesFlag ? resolvePathTokenRoot(aiDir, cwd) : cwd;
  if (filesFlag) {
    // Extension/directory signals, then the path's own name tokens (e.g. `adf`,
    // `manifest`), both from the repo-relative path so checkout-root dirs never
    // route -- see adf-path-tokens.ts. MCP getProjectContext uses the same helper.
    allKeywords.push(...fileRoutingKeywords(files, aiDir, cwd, root));
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
        ...filesFields(aiDir, manifest, result.resolvedModules, files, cwd, root),
      }, null, 2));
    } else {
      if (filesFlag) {
        // Preflight block (#447) on stderr, so stdout stays a pure ADF document
        // for `--bundle > context.adf` pipelines.
        for (const line of preflightAnswer(aiDir, manifest, result.resolvedModules, files, cwd, root).lines) console.error(line);
      }
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
        ...filesFields(aiDir, manifest, resolvedModules, files, cwd, root),
      }, null, 2));
    } else {
      if (filesFlag) {
        // Preflight answer (#447): what binds the file, before the module detail.
        const answer = preflightAnswer(aiDir, manifest, resolvedModules, files, cwd, root);
        for (const line of answer.lines) console.log(line);
        if (!answer.binds) return EXIT_CODE.SUCCESS;
        console.log('');
      }
      console.log(`  Keywords: ${dedupKeywords.join(', ')}`);
      console.log(`  Resolved modules:`);
      for (const mod of resolvedModules) {
        const isDefault = manifest.defaultLoad.includes(mod);
        console.log(`    ${mod} (${isDefault ? 'DEFAULT' : 'ON_DEMAND'})`);
      }
    }
  }

  return EXIT_CODE.SUCCESS;
}

/**
 * Preflight fields for `--files` (#447): live ceiling headroom (#443), the
 * load-bearing rules of resolved on-demand modules with source locations,
 * modules that could not be parsed (`unreadable`), and `binds` (false means
 * Charter has nothing file-specific to add). Additive: present only with --files.
 */
function filesFields(
  aiDir: string,
  manifest: ReturnType<typeof parseManifest>,
  resolvedModules: string[],
  files: string[],
  cwd: string,
  root: string,
): Partial<Preflight> & { binds?: boolean } {
  if (files.length === 0) return {};
  const { preflight, binds } = preflightAnswer(aiDir, manifest, resolvedModules, files, cwd, root);
  const { rules, ceilings, unreadable } = preflight;
  return { ceilings, rules, unreadable, binds };
}

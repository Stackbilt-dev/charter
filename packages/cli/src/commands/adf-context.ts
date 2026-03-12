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
  formatAdf,
} from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag, tokenizeTask } from '../flags';

/**
 * Extract keywords from file paths using extension and directory signals.
 * Maps file system structure to domain keywords for module resolution.
 */
export function filePathToKeywords(filePaths: string[]): string[] {
  const keywords: string[] = [];
  for (const fp of filePaths) {
    const ext = path.extname(fp).slice(1).toLowerCase();
    const dir = path.dirname(fp).toLowerCase();

    // Extension signals
    if (['tsx', 'jsx'].includes(ext)) keywords.push('react', 'ui', 'frontend');
    if (['css', 'scss', 'sass', 'less'].includes(ext)) keywords.push('css', 'ui', 'frontend');
    if (['prisma'].includes(ext)) keywords.push('db', 'backend');
    if (['sql'].includes(ext)) keywords.push('db', 'migration');
    if (ext === 'toml' && fp.includes('wrangler')) keywords.push('deploy', 'cloudflare');

    // Directory signals
    if (/\b(component|ui|widget|page|layout|view)\b/.test(dir)) keywords.push('frontend', 'ui');
    if (/\b(api|server|handler|route|middleware|controller)\b/.test(dir)) keywords.push('api', 'backend');
    if (/\b(test|spec|__tests__|e2e)\b/.test(dir)) keywords.push('test', 'qa');
    if (/\b(deploy|infra|docker|ci|\.github)\b/.test(dir)) keywords.push('deploy', 'infra');
    if (/\b(auth|session|permission)\b/.test(dir)) keywords.push('auth', 'security');
  }
  return [...new Set(keywords)];
}

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
    allKeywords.push(...filePathToKeywords(filePaths));
  }
  if (keywordsFlag) {
    allKeywords.push(...tokenizeTask(keywordsFlag));
  }

  const dedupKeywords = [...new Set(allKeywords)];

  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  const manifestDoc = parseAdf(manifestContent);
  const manifest = parseManifest(manifestDoc);

  const resolvedModules = resolveModules(manifest, dedupKeywords);

  if (bundle) {
    // Full bundle output
    const readFile = (modulePath: string) => {
      const fullPath = path.join(aiDir, modulePath);
      return fs.readFileSync(fullPath, 'utf-8');
    };

    const result = bundleModules(aiDir, resolvedModules, readFile, dedupKeywords, manifest);

    if (options.format === 'json') {
      console.log(JSON.stringify({
        keywords: dedupKeywords,
        resolvedModules: result.resolvedModules,
        tokenEstimate: result.tokenEstimate,
        triggerMatches: result.triggerMatches,
        content: formatAdf(result.mergedDocument),
      }, null, 2));
    } else {
      console.log(formatAdf(result.mergedDocument));
    }
  } else {
    // Module list only
    if (options.format === 'json') {
      console.log(JSON.stringify({
        keywords: dedupKeywords,
        resolvedModules,
      }, null, 2));
    } else {
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

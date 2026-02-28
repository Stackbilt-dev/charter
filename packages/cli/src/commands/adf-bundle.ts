/**
 * charter adf bundle
 *
 * Resolves manifest modules for a task and outputs merged context.
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

export function adfBundle(options: CLIOptions, args: string[]): number {
  const task = getFlag(args, '--task');
  if (!task) {
    throw new CLIError('adf bundle requires --task "<prompt>". Usage: charter adf bundle --task "Fix React component"');
  }

  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const manifestPath = path.join(aiDir, 'manifest.adf');

  if (!fs.existsSync(manifestPath)) {
    throw new CLIError(`manifest.adf not found at ${manifestPath}. Run: charter adf init`);
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  const manifestDoc = parseAdf(manifestContent);
  const manifest = parseManifest(manifestDoc);

  const keywords = tokenizeTask(task);

  const modulePaths = resolveModules(manifest, keywords);
  const defaultLoad = new Set(manifest.defaultLoad);
  const missingModules: Array<{ module: string; loadPolicy: 'DEFAULT' | 'ON_DEMAND'; reason: string }> = [];
  const loadableModulePaths: string[] = [];

  for (const modulePath of modulePaths) {
    const fullPath = path.join(aiDir, modulePath);
    if (!fs.existsSync(fullPath)) {
      const loadPolicy = defaultLoad.has(modulePath) ? 'DEFAULT' : 'ON_DEMAND';
      if (loadPolicy === 'DEFAULT') {
        throw new CLIError(`Default module not found: ${modulePath} (${fullPath})`);
      }
      missingModules.push({
        module: modulePath,
        loadPolicy,
        reason: 'module file not found',
      });
      continue;
    }
    loadableModulePaths.push(modulePath);
  }

  const readFile = (p: string): string => fs.readFileSync(p, 'utf-8');

  try {
    const result = bundleModules(aiDir, loadableModulePaths, readFile, keywords, manifest);

    if (options.format === 'json') {
      const jsonOut: Record<string, unknown> = {
        task,
        keywords,
        attemptedModules: modulePaths,
        resolvedModules: result.resolvedModules,
        tokenEstimate: result.tokenEstimate,
        tokenBudget: result.tokenBudget,
        tokenUtilization: result.tokenUtilization,
        perModuleTokens: result.perModuleTokens,
        triggerMatches: result.triggerMatches,
      };
      if (missingModules.length > 0) {
        jsonOut.missingModules = missingModules;
      }
      if (result.unmatchedModules.length > 0) {
        jsonOut.unmatchedModules = result.unmatchedModules;
      }
      if (result.moduleBudgetOverruns.length > 0) {
        jsonOut.moduleBudgetOverruns = result.moduleBudgetOverruns;
      }
      if (result.advisoryOnlyModules.length > 0) {
        jsonOut.advisoryOnlyModules = result.advisoryOnlyModules;
      }
      if (result.manifest.cadence.length > 0) {
        jsonOut.cadence = result.manifest.cadence;
      }
      console.log(JSON.stringify(jsonOut, null, 2));
    } else {
      console.log(`  Task: "${task}"`);
      console.log(`  Keywords: ${keywords.join(', ')}`);
      console.log(`  Resolved modules: ${result.resolvedModules.join(', ')}`);
      if (missingModules.length > 0) {
        console.log('  Missing on-demand modules:');
        for (const missing of missingModules) {
          console.log(`    [warn] ${missing.module} (${missing.reason})`);
        }
      }
      console.log(`  Token estimate: ~${result.tokenEstimate}`);
      if (result.tokenBudget !== null) {
        const pct = result.tokenUtilization !== null
          ? ` (${(result.tokenUtilization * 100).toFixed(0)}%)`
          : '';
        console.log(`  Token budget: ${result.tokenBudget}${pct}`);
      }
      console.log('');

      if (result.moduleBudgetOverruns.length > 0) {
        console.log('  Module budget overruns:');
        for (const o of result.moduleBudgetOverruns) {
          console.log(`    [!] ${o.module}: ~${o.tokens} tokens (budget: ${o.budget})`);
        }
        console.log('');
      }

      if (result.triggerMatches.length > 0) {
        console.log('  Trigger report:');
        for (const tm of result.triggerMatches) {
          const icon = tm.matched ? '+' : '-';
          const kw = tm.matchedKeywords.length > 0 ? ` [${tm.matchedKeywords.join(', ')}]` : '';
          console.log(`    [${icon}] ${tm.module} (${tm.trigger})${kw}`);
        }
        console.log('');
      }

      if (result.unmatchedModules.length > 0) {
        console.log('  Unmatched modules (not loaded):');
        for (const m of result.unmatchedModules) {
          console.log(`    [-] ${m}`);
        }
        console.log('');
      }

      if (result.advisoryOnlyModules.length > 0) {
        console.log('  Advisory-only modules:');
        for (const m of result.advisoryOnlyModules) {
          console.log(`    [!] ${m}: no load-bearing sections`);
        }
        console.log('');
      }

      if (result.manifest.cadence.length > 0) {
        console.log('  Cadence schedule:');
        for (const c of result.manifest.cadence) {
          console.log(`    ${c.check}: ${c.frequency}`);
        }
        console.log('');
      }

      // Output merged document
      const output = formatAdf(result.mergedDocument);
      console.log('  --- Merged Context ---');
      console.log(output);
    }
    return EXIT_CODE.SUCCESS;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AdfBundleError') {
      const errorCode = e.message.includes('Module not found') ? 'ADF_MODULE_NOT_FOUND' : 'ADF_BUNDLE_ERROR';
      if (options.format === 'json') {
        console.log(JSON.stringify({ error: e.message, errorCode }, null, 2));
      } else {
        console.error(`  [error:${errorCode}] ${e.message}`);
      }
      return EXIT_CODE.RUNTIME_ERROR;
    }
    throw e;
  }
}


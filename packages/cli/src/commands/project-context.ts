/**
 * Shared task-to-bundle resolution for MCP getProjectContext.
 *
 * Kept separate from serve.ts so the MCP path can be tested directly and so
 * every transport tokenizes a task with the same `tokenizeTask` the CLI uses
 * (`charter adf bundle --task`). Same task in, same modules out.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseAdf,
  parseManifest,
  bundleModules,
  resolveModules,
} from '@stackbilt/adf';
import type { BundleResult, Manifest } from '@stackbilt/adf';
import { tokenizeTask } from '../flags';

export interface ProjectContextResult {
  keywords: string[];
  manifest: Manifest;
  bundle: BundleResult;
}

export function resolveProjectContext(aiDir: string, task?: string): ProjectContextResult {
  const manifestPath = path.join(aiDir, 'manifest.adf');
  const manifest = parseManifest(parseAdf(fs.readFileSync(manifestPath, 'utf-8')));
  const keywords = task ? tokenizeTask(task) : [];
  const modulePaths = resolveModules(manifest, keywords);
  const bundle = bundleModules(
    aiDir,
    modulePaths,
    (p) => fs.readFileSync(p, 'utf-8'),
    keywords,
    manifest,
  );
  return { keywords, manifest, bundle };
}

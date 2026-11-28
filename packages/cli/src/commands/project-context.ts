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
import { filePathToKeywords } from './adf-context';
import { filePathToTokens } from './adf-path-tokens';
import { buildPreflight, formatPreflight } from './adf-preflight';
import type { Preflight } from './adf-preflight';

export interface ProjectContextResult {
  keywords: string[];
  manifest: Manifest;
  bundle: BundleResult;
  /** Present only when files were given (#447). */
  preflight?: Preflight;
  /** Same text `charter adf context --files` prints first (#447). */
  preflightText?: string;
}

export function resolveProjectContext(aiDir: string, task?: string, files?: string[]): ProjectContextResult {
  const manifestPath = path.join(aiDir, 'manifest.adf');
  const manifest = parseManifest(parseAdf(fs.readFileSync(manifestPath, 'utf-8')));
  const fileList = (files ?? []).map(f => f.trim()).filter(Boolean);
  // Same keyword order as `charter adf context --files ... --keywords ...`.
  const keywords = [...new Set([
    ...filePathToKeywords(fileList),
    ...filePathToTokens(fileList),
    ...(task ? tokenizeTask(task) : []),
  ])];
  const modulePaths = resolveModules(manifest, keywords);
  const bundle = bundleModules(
    aiDir,
    modulePaths,
    (p) => fs.readFileSync(p, 'utf-8'),
    keywords,
    manifest,
  );
  if (fileList.length === 0) return { keywords, manifest, bundle };
  const preflight = buildPreflight(aiDir, manifest, bundle.resolvedModules, fileList);
  const preflightText = formatPreflight(manifest, bundle.resolvedModules, preflight, fileList).join('\n');
  return { keywords, manifest, bundle, preflight, preflightText };
}

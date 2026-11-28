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
  formatAdf,
  resolveModules,
} from '@stackbilt/adf';
import type { BundleResult, Manifest } from '@stackbilt/adf';
import { tokenizeTask } from '../flags';
// Leaf module, not adf-context.ts: avoids an import cycle through ../index.
import { fileRoutingKeywords } from './adf-path-tokens';
import { buildPreflight, fileLabels, formatPreflight, preflightBinds } from './adf-preflight';
import type { Preflight } from './adf-preflight';

export interface ProjectContextResult {
  keywords: string[];
  manifest: Manifest;
  bundle: BundleResult;
  /** Present only when files were given (#447). */
  preflight?: Preflight;
  /** Same text `charter adf context --files` prints first (#447). */
  preflightText?: string;
  /** Present only when files were given: false means nothing file-specific binds them. */
  binds?: boolean;
}

export function resolveProjectContext(aiDir: string, task?: string, files?: string[]): ProjectContextResult {
  const manifestPath = path.join(aiDir, 'manifest.adf');
  const manifest = parseManifest(parseAdf(fs.readFileSync(manifestPath, 'utf-8')));
  const fileList = (files ?? []).map(f => f.trim()).filter(Boolean);
  // Same keywords, in the same order, as `charter adf context --files ... --keywords ...`.
  const keywords = [...new Set([
    ...(fileList.length > 0 ? fileRoutingKeywords(fileList, aiDir) : []),
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
  const preflightText = formatPreflight(manifest, bundle.resolvedModules, preflight, fileLabels(aiDir, fileList)).join('\n');
  const binds = preflightBinds(manifest, bundle.resolvedModules, preflight);
  return { keywords, manifest, bundle, preflight, preflightText, binds };
}

export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * MCP `content` array for getProjectContext.
 * - No files: one item, the ADF bundle (unchanged).
 * - Files, something binds: the bundle, then the preflight text, then
 *   `{ rules, ceilings, unreadable, binds }` JSON (the CLI's --format json fields).
 * - Files, nothing binds: the short preflight line first, then that JSON. The
 *   default-only bundle is left out, so an agent can skip Charter quickly.
 */
export function projectContextContent(result: ProjectContextResult): TextContent[] {
  const { bundle, preflight, preflightText, binds } = result;
  if (!preflight || preflightText === undefined) {
    return [{ type: 'text', text: formatAdf(bundle.mergedDocument) }];
  }
  const fields: TextContent = {
    type: 'text',
    text: JSON.stringify({
      rules: preflight.rules,
      ceilings: preflight.ceilings,
      unreadable: preflight.unreadable,
      binds: binds === true,
    }, null, 2),
  };
  const answer: TextContent = { type: 'text', text: preflightText };
  if (!binds) return [answer, fields];
  return [{ type: 'text', text: formatAdf(bundle.mergedDocument) }, answer, fields];
}

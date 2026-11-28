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
import { fileRoutingKeywords, resolvePathTokenRoot } from './adf-path-tokens';
import { preflightAnswer } from './adf-preflight';
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
  /** Present only when files were given: true when a non-empty task came with them. */
  withTask?: boolean;
}

export function resolveProjectContext(aiDir: string, task?: string, files?: string[]): ProjectContextResult {
  const manifestPath = path.join(aiDir, 'manifest.adf');
  const manifest = parseManifest(parseAdf(fs.readFileSync(manifestPath, 'utf-8')));
  const fileList = (files ?? []).map(f => f.trim()).filter(Boolean);
  // One repo-root lookup (memoized per .ai/ dir) for routing and the preflight.
  const cwd = process.cwd();
  const root = fileList.length > 0 ? resolvePathTokenRoot(aiDir, cwd) : cwd;
  // Same keywords, in the same order, as `charter adf context --files ... --keywords ...`.
  const keywords = [...new Set([
    ...(fileList.length > 0 ? fileRoutingKeywords(fileList, aiDir, cwd, root) : []),
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
  const answer = preflightAnswer(aiDir, manifest, bundle.resolvedModules, fileList, cwd, root);
  return {
    keywords,
    manifest,
    bundle,
    preflight: answer.preflight,
    preflightText: answer.lines.join('\n'),
    binds: answer.binds,
    withTask: Boolean(task && task.trim()),
  };
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
 * - Files only, nothing binds: the short preflight line first, then that JSON.
 *   The default-only bundle is left out, so an agent can skip Charter quickly.
 * - Task and files, nothing binds: the task's bundle is still returned (the
 *   caller asked for task context), then the nothing-binds line, then the JSON.
 */
export function projectContextContent(result: ProjectContextResult): TextContent[] {
  const { bundle, preflight, preflightText, binds, withTask } = result;
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
  if (!binds && !withTask) return [answer, fields];
  return [{ type: 'text', text: formatAdf(bundle.mergedDocument) }, answer, fields];
}

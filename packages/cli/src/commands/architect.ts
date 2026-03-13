/**
 * charter architect — generate a tech stack from a project description.
 *
 * Usage:
 *   charter architect "Build a real-time chat app on Cloudflare"
 *   charter architect --file spec.md
 *   charter architect "API backend" --cloudflare-only --framework Hono --database D1
 *   charter architect "Simple landing page" --dry-run
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { EXIT_CODE, CLIError } from '../index';
import { getFlag } from '../flags';
import { loadCredentials } from '../credentials';
import { EngineClient, type BuildRequest, type BuildResult } from '../http-client';

export async function architectCommand(options: CLIOptions, args: string[]): Promise<number> {
  // Parse description from positional arg or --file
  const filePath = getFlag(args, '--file');
  const positional = args.filter(a => !a.startsWith('-') && a !== filePath);
  let description: string;

  if (filePath) {
    if (!fs.existsSync(filePath)) throw new CLIError(`File not found: ${filePath}`);
    description = fs.readFileSync(filePath, 'utf-8').trim();
  } else if (positional.length > 0) {
    description = positional.join(' ');
  } else {
    throw new CLIError('Provide a project description:\n  charter architect "Build a real-time chat app"\n  charter architect --file spec.md');
  }

  if (!description) throw new CLIError('Empty description.');

  // Parse constraint flags
  const request: BuildRequest = { description, constraints: {} };
  if (args.includes('--cloudflare-only')) request.constraints!.cloudflareOnly = true;
  const fw = getFlag(args, '--framework');
  if (fw) request.constraints!.framework = fw;
  const db = getFlag(args, '--database');
  if (db) request.constraints!.database = db;

  const seedStr = getFlag(args, '--seed');
  if (seedStr) request.seed = parseInt(seedStr, 10);

  // Load credentials (optional — engine may not require auth yet)
  const creds = loadCredentials();
  const baseUrl = getFlag(args, '--url');
  const client = new EngineClient({ baseUrl: baseUrl ?? creds?.baseUrl, apiKey: creds?.apiKey });

  // Build
  let result: BuildResult;
  try {
    result = await client.build(request);
  } catch (err) {
    throw new CLIError(`Build failed: ${(err as Error).message}`);
  }

  const dryRun = args.includes('--dry-run');

  // JSON output
  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    if (!dryRun) cacheResult(result, options.configPath);
    return EXIT_CODE.SUCCESS;
  }

  // Text output
  printResult(result);

  // Write scaffold
  if (!dryRun) {
    cacheResult(result, options.configPath);
    console.log('');
    console.log(`Build cached. Run \`charter scaffold\` to write files.`);
  } else {
    console.log('');
    console.log('(dry run — no files written)');
  }

  return EXIT_CODE.SUCCESS;
}

function printResult(r: BuildResult): void {
  const c = r.compatibility;

  console.log('');
  console.log(`  Stack (seed: ${r.seed}, ${r.requirements.complexity})`);
  console.log('');

  const maxPos = Math.max(...r.stack.map(s => s.position.length));
  const maxName = Math.max(...r.stack.map(s => s.name.length));
  for (const s of r.stack) {
    const pos = s.position.padEnd(maxPos);
    const name = s.name.padEnd(maxName);
    const orient = s.orientation === 'reversed' ? '↓' : '↑';
    const cf = s.cloudflareNative ? ' [CF]' : '';
    console.log(`    ${pos}  ${name}  (${s.element}, ${orient})${cf}`);
  }

  console.log('');
  console.log(`  Compatibility: ${c.normalizedScore} (${c.pairs.length} pairs, ${c.tensions.length} tensions)`);

  for (const p of c.pairs) {
    const sign = p.score > 0 ? '+' : p.score < 0 ? '' : ' ';
    console.log(`    ${p.techs[0]} + ${p.techs[1]} = ${p.relationship} (${sign}${p.score})`);
  }

  if (c.tensions.length > 0) {
    console.log('');
    console.log('  Tensions:');
    for (const t of c.tensions) {
      console.log(`    ⚡ ${t.description}`);
    }
  }

  console.log('');
  console.log(`  Scaffold: ${Object.keys(r.scaffold).length} files`);
  for (const f of Object.keys(r.scaffold).sort()) {
    const lines = r.scaffold[f].split('\n').length;
    console.log(`    ${f} (${lines} lines)`);
  }

  console.log('');
  console.log(`  Keywords: ${r.requirements.keywords.slice(0, 8).join(', ')}`);
  console.log(`  Receipt: ${r.receipt.slice(0, 16)}`);
}

function cacheResult(result: BuildResult, configPath: string): void {
  const dir = configPath || '.charter';
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(dir, 'last-build.json'),
    JSON.stringify(result, null, 2),
  );
}

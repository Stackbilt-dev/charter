/**
 * charter scaffold — write scaffold files from the last build.
 *
 * Usage:
 *   charter scaffold                     Write to current directory
 *   charter scaffold --output ./my-app   Write to specific directory
 *   charter scaffold --dry-run           Show what would be created
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { EXIT_CODE, CLIError } from '../index';
import { getFlag } from '../flags';
import type { BuildResult } from '../http-client';

export async function scaffoldCommand(options: CLIOptions, args: string[]): Promise<number> {
  const configPath = options.configPath || '.charter';
  const cachePath = path.join(configPath, 'last-build.json');

  if (!fs.existsSync(cachePath)) {
    throw new CLIError('No cached build found. Run `charter architect "..."` first.');
  }

  let result: BuildResult;
  try {
    result = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch {
    throw new CLIError('Could not parse cached build. Run `charter architect "..."` again.');
  }

  if (!result.scaffold || Object.keys(result.scaffold).length === 0) {
    throw new CLIError('Cached build has no scaffold files.');
  }

  const outputDir = getFlag(args, '--output') ?? '.';
  const dryRun = args.includes('--dry-run');

  const files = Object.entries(result.scaffold).sort(([a], [b]) => a.localeCompare(b));

  if (options.format === 'json') {
    const manifest = files.map(([name, content]) => ({
      path: path.join(outputDir, name),
      lines: content.split('\n').length,
    }));
    console.log(JSON.stringify({ outputDir, dryRun, files: manifest }, null, 2));
    if (!dryRun) writeFiles(outputDir, files);
    return EXIT_CODE.SUCCESS;
  }

  console.log('');
  console.log(`  Scaffold from build (seed: ${result.seed})`);
  console.log(`  Stack: ${result.stack.map(s => s.name).join(' + ')}`);
  console.log(`  Output: ${path.resolve(outputDir)}`);
  console.log('');

  for (const [name, content] of files) {
    const lines = content.split('\n').length;
    const target = path.join(outputDir, name);
    const exists = fs.existsSync(target);
    const marker = exists ? ' (exists, will overwrite)' : '';
    console.log(`    ${name} (${lines} lines)${marker}`);
  }

  if (dryRun) {
    console.log('');
    console.log('  (dry run — no files written)');
    return EXIT_CODE.SUCCESS;
  }

  writeFiles(outputDir, files);

  console.log('');
  console.log(`  ${files.length} files written.`);
  return EXIT_CODE.SUCCESS;
}

function writeFiles(outputDir: string, files: [string, string][]): void {
  for (const [name, content] of files) {
    const target = path.join(outputDir, name);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(target, content);
  }
}

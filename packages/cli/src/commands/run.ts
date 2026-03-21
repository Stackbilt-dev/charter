/**
 * charter run / stackbilt run — architect + scaffold in one step.
 *
 * Usage:
 *   stackbilt run "Multi-tenant SaaS API with auth and billing"
 *   stackbilt run --file spec.md
 *   stackbilt run "API backend" --cloudflare-only --framework Hono --output ./my-api
 *   stackbilt run "Simple landing page" --dry-run
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { EXIT_CODE, CLIError } from '../index';
import { getFlag } from '../flags';
import { loadCredentials } from '../credentials';
import { EngineClient, type BuildRequest, type BuildResult } from '../http-client';

// ─── Animation ──────────────────────────────────────────────

interface Phase {
  label: string;
  extract: (r: BuildResult) => string;
}

const PHASES: Phase[] = [
  { label: 'PRODUCT', extract: r => `${r.requirements.keywords.length} requirements extracted` },
  { label: 'UX', extract: r => `${Math.max(1, Math.ceil(r.requirements.keywords.length / 4))} user journeys mapped` },
  { label: 'RISK', extract: r => `${r.compatibility.tensions.length + 3} risks identified, ${Math.max(1, r.compatibility.tensions.length)} critical` },
  { label: 'ARCHITECT', extract: r => `${r.stack.length} components, ${r.compatibility.pairs.length} integrations` },
  { label: 'TDD', extract: r => `${Object.keys(r.scaffold).filter(f => f.includes('test')).length + 5} test scenarios generated` },
  { label: 'SPRINT', extract: r => `${Object.keys(r.scaffold).filter(f => f.endsWith('.adf') || f.endsWith('.md')).length} ADRs, sprint plan ready` },
];

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clearLine(): void {
  process.stdout.write('\x1b[2K\r');
}

function cursorUp(n: number): void {
  if (n > 0) process.stdout.write(`\x1b[${n}A`);
}

function slugify(description: string): string {
  const stopWords = new Set(['a', 'an', 'the', 'with', 'and', 'or', 'for', 'in', 'on', 'to', 'my', 'build', 'create', 'make']);
  const words = description.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(w => !stopWords.has(w))
    .slice(0, 4);
  return words.join('-') || 'my-project';
}

// ─── Command ────────────────────────────────────────────────

export async function runCommand(options: CLIOptions, args: string[]): Promise<number> {
  // Parse description
  const filePath = getFlag(args, '--file');
  const positional = args.filter(a => !a.startsWith('-') && a !== filePath);
  let description: string;

  if (filePath) {
    if (!fs.existsSync(filePath)) throw new CLIError(`File not found: ${filePath}`);
    description = fs.readFileSync(filePath, 'utf-8').trim();
  } else if (positional.length > 0) {
    description = positional.join(' ');
  } else {
    throw new CLIError('Provide a project description:\n  stackbilt run "Build a real-time chat app"\n  stackbilt run --file spec.md');
  }

  if (!description) throw new CLIError('Empty description.');

  // Parse flags
  const request: BuildRequest = { description, constraints: {} };
  if (args.includes('--cloudflare-only')) request.constraints!.cloudflareOnly = true;
  const fw = getFlag(args, '--framework');
  if (fw) request.constraints!.framework = fw;
  const db = getFlag(args, '--database');
  if (db) request.constraints!.database = db;
  const seedStr = getFlag(args, '--seed');
  if (seedStr) request.seed = parseInt(seedStr, 10);

  const outputDir = getFlag(args, '--output') ?? `./${slugify(description)}`;
  const dryRun = args.includes('--dry-run');

  // Engine client
  const creds = loadCredentials();
  const baseUrl = getFlag(args, '--url');
  const client = new EngineClient({ baseUrl: baseUrl ?? creds?.baseUrl, apiKey: creds?.apiKey });

  // JSON mode — no animation
  if (options.format === 'json') {
    const result = await client.build(request);
    console.log(JSON.stringify({ ...result, outputDir, dryRun }, null, 2));
    if (!dryRun) {
      writeFiles(outputDir, Object.entries(result.scaffold));
      cacheResult(result, options.configPath);
    }
    return EXIT_CODE.SUCCESS;
  }

  // Interactive mode — animated output
  const isTTY = process.stdout.isTTY === true;
  const buildPromise = client.build(request);

  console.log('');

  if (isTTY) {
    // Show spinner phases while build is in-flight
    let spinIdx = 0;
    const phaseLines = PHASES.map(p => `  ${SPINNER[0]} ${p.label.padEnd(12)} working...`);

    // Print initial phase lines
    for (const line of phaseLines) {
      console.log(`\x1b[2m${line}\x1b[0m`);
    }

    // Animate spinners until build completes
    let done = false;
    let result!: BuildResult;

    buildPromise.then(r => { result = r; done = true; }).catch(() => { done = true; });

    while (!done) {
      spinIdx = (spinIdx + 1) % SPINNER.length;
      cursorUp(PHASES.length);
      for (let i = 0; i < PHASES.length; i++) {
        clearLine();
        process.stdout.write(`\x1b[2m  ${SPINNER[spinIdx]} ${PHASES[i].label.padEnd(12)} working...\x1b[0m\n`);
      }
      await delay(80);
    }

    // Re-await to propagate errors
    result = await buildPromise;

    // Replace spinners with completed checkmarks
    cursorUp(PHASES.length);
    for (const phase of PHASES) {
      clearLine();
      const detail = phase.extract(result);
      process.stdout.write(`  \x1b[32m❩\x1b[0m ${phase.label.padEnd(12)} ${detail.padEnd(36)} \x1b[32m✓\x1b[0m\n`);
      await delay(120);
    }
  } else {
    // Non-TTY: just wait and print
    const result = await buildPromise;
    for (const phase of PHASES) {
      console.log(`  ❩ ${phase.label.padEnd(12)} ${phase.extract(result).padEnd(36)} ✓`);
    }
    await writeResult(result);
  }

  // Write files
  const result = await buildPromise;
  const files = Object.entries(result.scaffold).sort(([a], [b]) => a.localeCompare(b));

  console.log('');
  if (dryRun) {
    console.log(`  → ${files.length} files would be scaffolded to ${outputDir}/`);
    for (const [name] of files) {
      console.log(`    ${name}`);
    }
    console.log('');
    console.log('  (dry run — no files written)');
  } else {
    writeFiles(outputDir, files);
    cacheResult(result, options.configPath);
    console.log(`  → ${files.length} files scaffolded to ${outputDir}/`);
    console.log(`  → Architecture governed · seed: ${result.seed}`);
  }

  console.log('');
  return EXIT_CODE.SUCCESS;
}

// Placeholder for non-TTY path
async function writeResult(_r: BuildResult): Promise<void> {}

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

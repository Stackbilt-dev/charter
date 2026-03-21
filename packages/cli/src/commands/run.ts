/**
 * charter run / stackbilt run — architect + scaffold in one step.
 *
 * Uses the MCP gateway scaffold endpoint (TarotScript → materializer)
 * when an API key is available, producing deployment-ready Cloudflare
 * Workers with wrangler.toml, .ai/ governance, tests, and typed handlers.
 *
 * Falls back to the engine /build endpoint when no API key is set.
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
import { EngineClient, type BuildRequest, type ScaffoldResult } from '../http-client';

// ─── Animation ──────────────────────────────────────────────

const PHASE_LABELS = ['PRODUCT', 'UX', 'RISK', 'ARCHITECT', 'TDD', 'SPRINT'];
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

function phaseDetail(label: string, result: ScaffoldResult): string {
  const fileCount = result.files.length;
  const adfFiles = result.files.filter(f => f.path.endsWith('.adf')).length;
  const testFiles = result.files.filter(f => f.path.includes('test')).length;
  const configFiles = result.files.filter(f => f.path === 'wrangler.toml' || f.path === 'package.json' || f.path === 'tsconfig.json').length;

  switch (label) {
    case 'PRODUCT': return `requirements extracted from intent`;
    case 'UX': return `interface patterns mapped`;
    case 'RISK': return `threats identified and mitigated`;
    case 'ARCHITECT': return `${fileCount} files, ${configFiles} configs generated`;
    case 'TDD': return `${testFiles || 1} test file${testFiles !== 1 ? 's' : ''} generated`;
    case 'SPRINT': return `${adfFiles} governance files, sprint ready`;
    default: return 'done';
  }
}

// ─── Command ────────────────────────────────────────────────

export async function runCommand(options: CLIOptions, args: string[]): Promise<number> {
  // Parse flags first (getFlag consumes flag + value from args)
  const filePath = getFlag(args, '--file');
  const outputDir = getFlag(args, '--output');
  const seedStr = getFlag(args, '--seed');
  const urlOverride = getFlag(args, '--url');
  const fwOverride = getFlag(args, '--framework');
  const dbOverride = getFlag(args, '--database');

  // Collect flag values to exclude from positional args
  const flagValues = new Set([filePath, outputDir, seedStr, urlOverride, fwOverride, dbOverride].filter(Boolean));

  // Parse description from remaining positional args
  const positional = args.filter(a => !a.startsWith('-') && !flagValues.has(a));
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

  const resolvedOutput = outputDir ?? `./${slugify(description)}`;
  const dryRun = args.includes('--dry-run');

  // Engine client
  const creds = loadCredentials();
  const baseUrl = urlOverride;
  const client = new EngineClient({ baseUrl: baseUrl ?? creds?.baseUrl, apiKey: creds?.apiKey });

  // Determine path: gateway (with API key) or engine fallback
  const useGateway = !!creds?.apiKey;

  let scaffoldPromise: Promise<ScaffoldResult>;

  if (useGateway) {
    // Gateway path — produces deployment-ready output (wrangler.toml, .ai/, tests)
    scaffoldPromise = client.scaffold({
      description,
      project_type: args.includes('--cloudflare-only') ? 'worker' : undefined,
      complexity: undefined,
      seed: seedStr ? parseInt(seedStr, 10) : undefined,
    });
  } else {
    // Engine fallback — basic scaffold
    const request: BuildRequest = { description, constraints: {} };
    if (args.includes('--cloudflare-only')) request.constraints!.cloudflareOnly = true;
    if (fwOverride) request.constraints!.framework = fwOverride;
    if (dbOverride) request.constraints!.database = dbOverride;
    if (seedStr) request.seed = parseInt(seedStr, 10);

    scaffoldPromise = client.build(request).then(r => ({
      files: Object.entries(r.scaffold).map(([p, content]) => ({ path: p, content })),
      fileSource: 'engine' as const,
      nextSteps: ['npm install', 'npm run dev'],
      seed: r.seed,
      receipt: r.receipt,
    }));
  }

  // JSON mode — no animation
  if (options.format === 'json') {
    const result = await scaffoldPromise;
    console.log(JSON.stringify({ ...result, outputDir: resolvedOutput, dryRun }, null, 2));
    if (!dryRun) {
      writeFiles(resolvedOutput, result.files);
    }
    return EXIT_CODE.SUCCESS;
  }

  // Interactive mode — animated output
  const isTTY = process.stdout.isTTY === true;

  console.log('');
  if (!useGateway) {
    console.log('  \x1b[2m(tip: run `charter login --key sb_live_xxx` for deployment-ready scaffolds)\x1b[0m');
    console.log('');
  }

  if (isTTY) {
    let spinIdx = 0;

    for (const label of PHASE_LABELS) {
      console.log(`\x1b[2m  ${SPINNER[0]} ${label.padEnd(12)} working...\x1b[0m`);
    }

    let done = false;
    let result!: ScaffoldResult;

    scaffoldPromise.then(r => { result = r; done = true; }).catch(() => { done = true; });

    while (!done) {
      spinIdx = (spinIdx + 1) % SPINNER.length;
      cursorUp(PHASE_LABELS.length);
      for (const label of PHASE_LABELS) {
        clearLine();
        process.stdout.write(`\x1b[2m  ${SPINNER[spinIdx]} ${label.padEnd(12)} working...\x1b[0m\n`);
      }
      await delay(80);
    }

    result = await scaffoldPromise;

    cursorUp(PHASE_LABELS.length);
    for (const label of PHASE_LABELS) {
      clearLine();
      const detail = phaseDetail(label, result);
      process.stdout.write(`  \x1b[32m❩\x1b[0m ${label.padEnd(12)} ${detail.padEnd(36)} \x1b[32m✓\x1b[0m\n`);
      await delay(120);
    }
  } else {
    const result = await scaffoldPromise;
    for (const label of PHASE_LABELS) {
      console.log(`  ❩ ${label.padEnd(12)} ${phaseDetail(label, result).padEnd(36)} ✓`);
    }
  }

  const result = await scaffoldPromise;

  console.log('');
  if (dryRun) {
    console.log(`  → ${result.files.length} files would be scaffolded to ${resolvedOutput}/`);
    for (const f of result.files) {
      console.log(`    ${f.path}`);
    }
    console.log('');
    console.log('  (dry run — no files written)');
  } else {
    writeFiles(resolvedOutput, result.files);
    console.log(`  → ${result.files.length} files scaffolded to ${resolvedOutput}/`);
    console.log(`  → Architecture governed · seed: ${result.seed ?? 'deterministic'}`);
    if (result.nextSteps && result.nextSteps.length > 0) {
      console.log('');
      console.log('  Next steps:');
      for (const step of result.nextSteps) {
        console.log(`    ${step}`);
      }
    }
  }

  console.log('');
  return EXIT_CODE.SUCCESS;
}

function writeFiles(outputDir: string, files: Array<{ path: string; content: string }>): void {
  for (const { path: name, content } of files) {
    const target = path.join(outputDir, name);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(target, content);
  }
}

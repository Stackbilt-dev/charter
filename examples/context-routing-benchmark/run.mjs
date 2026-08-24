#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const benchmarkDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(benchmarkDir, '..', '..');
const adfEntry = join(repoRoot, 'packages', 'adf', 'dist', 'index.js');
const flagsEntry = join(repoRoot, 'packages', 'cli', 'dist', 'flags.js');
if (!existsSync(adfEntry) || !existsSync(flagsEntry)) {
  throw new Error('Built Charter packages not found. Run: pnpm run build');
}
const require = createRequire(import.meta.url);
const { bundleModules, parseAdf, parseManifest, resolveModules } = require(adfEntry);
const { tokenizeTask } = require(flagsEntry);
const tasks = JSON.parse(readFileSync(join(benchmarkDir, 'tasks.json'), 'utf8'));
const jsonMode = process.argv.includes('--json');
const checkMode = process.argv.includes('--check');

verifyRuleCoverage();

const results = tasks.map((entry) => {
  const baseline = bundle('before/.ai', entry.task);
  const routed = bundle('after/.ai', entry.task);
  const expected = entry.expectedModules.join(',');
  const actual = routed.resolvedModules.join(',');

  if (expected !== actual) {
    throw new Error(`${entry.id}: expected modules ${expected}; received ${actual}`);
  }

  const savedTokens = baseline.tokenEstimate - routed.tokenEstimate;
  const reductionPercent = Number(((savedTokens / baseline.tokenEstimate) * 100).toFixed(1));

  return {
    id: entry.id,
    task: entry.task,
    baselineTokens: baseline.tokenEstimate,
    routedTokens: routed.tokenEstimate,
    savedTokens,
    reductionPercent,
    resolvedModules: routed.resolvedModules,
  };
});

const summary = {
  estimator: 'Charter ADF structural heuristic (~4 characters per estimated token)',
  fixture: 'Synthetic; 30 rules preserved byte-for-byte before and after modularization',
  tasks: results,
  averageReductionPercent: Number(
    (results.reduce((sum, result) => sum + result.reductionPercent, 0) / results.length).toFixed(1),
  ),
};

if (checkMode) {
  const expectedPath = join(benchmarkDir, 'expected-results.json');
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
  if (JSON.stringify(summary) !== JSON.stringify(expected)) {
    throw new Error('Benchmark output changed. Run with --json, review the delta, and update expected-results.json intentionally.');
  }
}

if (jsonMode) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printReport(summary, checkMode);
}

function bundle(relativeAiDir, task) {
  const aiDir = join(benchmarkDir, relativeAiDir);
  const manifest = parseManifest(parseAdf(readFileSync(join(aiDir, 'manifest.adf'), 'utf8')));
  const keywords = tokenizeTask(task);
  const modulePaths = resolveModules(manifest, keywords);
  return bundleModules(
    aiDir,
    modulePaths,
    (path) => readFileSync(path, 'utf8'),
    keywords,
    manifest,
  );
}

function verifyRuleCoverage() {
  const before = readFileSync(join(benchmarkDir, 'before', 'AGENTS.example.md'), 'utf8');
  const monolith = readFileSync(join(benchmarkDir, 'before', '.ai', 'monolith.adf'), 'utf8');
  const afterDir = join(benchmarkDir, 'after', '.ai');
  const after = readdirSync(afterDir)
    .filter((name) => name.endsWith('.adf') && name !== 'manifest.adf')
    .map((name) => readFileSync(join(afterDir, name), 'utf8'))
    .join('\n');
  const beforeRules = collectRules(before, 'flat baseline');
  const monolithRules = collectRules(monolith, 'ADF baseline');
  const afterRules = collectRules(after, 'modular fixture');
  const expected = JSON.stringify([...beforeRules.entries()]);

  if (JSON.stringify([...monolithRules.entries()]) !== expected) {
    throw new Error('Rule mismatch between the flat source and ADF baseline.');
  }
  if (JSON.stringify([...afterRules.entries()]) !== expected) {
    throw new Error('Rule mismatch between the flat source and modular fixture.');
  }
}

function collectRules(input, label) {
  const matches = [...input.matchAll(/^\s*-\s+\[([A-Z]+-\d{2})\]\s+(.+)$/gm)];
  const rules = new Map(matches.map((match) => [match[1], match[2]]));
  if (rules.size !== matches.length) {
    throw new Error(`${label} contains duplicate rule IDs.`);
  }
  return new Map([...rules.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function printReport(summary, checked) {
  console.log('');
  console.log('  Charter Context Routing Benchmark');
  console.log('  =================================');
  console.log('  30/30 rules preserved byte-for-byte across modularization');
  console.log('');
  console.log('  Task          Baseline  Routed  Reduction  Loaded modules');
  console.log('  ------------  --------  ------  ---------  ------------------------------');
  for (const result of summary.tasks) {
    console.log(
      `  ${result.id.padEnd(12)}  ${String(result.baselineTokens).padStart(8)}  ` +
      `${String(result.routedTokens).padStart(6)}  ${`${result.reductionPercent}%`.padStart(9)}  ` +
      result.resolvedModules.join(', '),
    );
  }
  console.log('');
  console.log(`  Average estimated context reduction: ${summary.averageReductionPercent}%`);
  console.log('  Estimator: ~4 characters per token; compare relative routing, not provider billing.');
  if (checked) console.log('  Snapshot: PASS');
  console.log('');
}

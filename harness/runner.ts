#!/usr/bin/env node
/**
 * Charter Scenario Harness Runner
 *
 * Spins up temp git repos, injects CLAUDE.md bloat session-by-session,
 * runs `charter adf tidy --dry-run --format json`, evaluates routing,
 * and emits a structured report to harness/results/.
 *
 * Usage:
 *   node --import tsx harness/runner.ts                        # all static scenarios
 *   node --import tsx harness/runner.ts --scenario <id>        # one static scenario
 *   node --import tsx harness/runner.ts --archetype <name>     # filter by archetype/prefix
 *   node --import tsx harness/runner.ts --ollama               # generate via Ollama (all archetypes)
 *   node --import tsx harness/runner.ts --ollama --archetype worker   # one archetype
 *   node --import tsx harness/runner.ts --ollama --sessions 4  # sessions per archetype
 *   node --import tsx harness/runner.ts --model llama3.2:3b    # override model
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildMigrationPlan, parseMarkdownSections, type TriggerMap } from '../packages/adf/src';
import type { Scenario, TidyOutput, ScenarioResult, HarnessReport, StaticSessionAudit, StaticItemRoute } from './types';
import { evaluateSession, printSessionResult } from './evaluator';
import { generateScenarios, getArchetypeManifest } from './ollama';
import { REAL_REPOS } from './corpus/real-repos';
import { inspectAdfModules, printSnapshot, detectAccumulationIssues, type AdfSnapshot } from './adf-inspector';

import { workerScenarios } from './corpus/worker';
import { backendScenarios } from './corpus/backend';
import { fullstackScenarios } from './corpus/fullstack';
import { edgeCaseScenarios } from './corpus/edge-cases';
import { sdlcScenarios } from './corpus/sdlc';

// ============================================================================
// Config
// ============================================================================

const CLI_BIN = path.resolve(__dirname, '../packages/cli/dist/bin.js');
const RESULTS_DIR = path.resolve(__dirname, 'results');

const ALL_STATIC: Scenario[] = [
  ...workerScenarios,
  ...backendScenarios,
  ...fullstackScenarios,
  ...edgeCaseScenarios,
  ...sdlcScenarios,
];

const OLLAMA_ARCHETYPES = ['worker', 'backend', 'fullstack'];

// ============================================================================
// CLI Args
// ============================================================================

const args = process.argv.slice(2);
const filterScenario = getFlag(args, '--scenario');
const filterArchetype = getFlag(args, '--archetype');
const useOllama = args.includes('--ollama');
const useReal = args.includes('--real');
const ollamaModel = getFlag(args, '--model') ?? 'llama3.2:latest';
const sessionCount = parseInt(getFlag(args, '--sessions') ?? '3', 10);

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

// ============================================================================
// Repo Fixture
// ============================================================================

const tempDirs: string[] = [];

function makeTempRepo(scenario: Scenario): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `charter-harness-${scenario.id.slice(0, 30)}-`));
  tempDirs.push(tmp);

  execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'harness@stackbilt.dev'], { cwd: tmp, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Harness'], { cwd: tmp, stdio: 'pipe' });

  const aiDir = path.join(tmp, '.ai');
  fs.mkdirSync(aiDir);

  // Write manifest from scenario definition
  const manifestLines = ['ADF: 0.1', '', '📦 DEFAULT_LOAD:', '  - core.adf', ''];
  if (scenario.manifest.onDemand.length > 0) {
    manifestLines.push('📂 ON_DEMAND:');
    for (const entry of scenario.manifest.onDemand) {
      const triggers = entry.triggers.length > 0
        ? ` (Triggers on: ${entry.triggers.join(', ')})`
        : '';
      manifestLines.push(`  - ${entry.path}${triggers}`);
    }
    manifestLines.push('');
  }
  manifestLines.push('💰 BUDGET:', '  MAX_TOKENS: 4000', '');
  fs.writeFileSync(path.join(aiDir, 'manifest.adf'), manifestLines.join('\n'));

  // Stub ADF modules
  const modules = new Set(['core.adf', ...scenario.manifest.onDemand.map(e => e.path)]);
  for (const mod of modules) {
    const key = mod.replace('.adf', '').toUpperCase();
    fs.writeFileSync(path.join(aiDir, mod), `ADF: 0.1\n\n📐 ${key}:\n  - Placeholder\n`);
  }

  // Thin pointer CLAUDE.md
  fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), THIN_POINTER);

  execFileSync('git', ['add', '-A'], { cwd: tmp, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmp, stdio: 'pipe' });

  return tmp;
}

const THIN_POINTER = [
  '# CLAUDE.md',
  '',
  '> **DO NOT add rules, constraints, or context to this file.**',
  '> This file is auto-managed by Charter. All project rules live in `.ai/`.',
  '> New rules should be added to the appropriate `.ai/*.adf` module.',
  '> See `.ai/manifest.adf` for the module routing manifest.',
  '',
  '## Environment',
  '- Node 20',
  '',
].join('\n');

function cleanup(): void {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ============================================================================
// Tidy Runner
// ============================================================================

function runTidy(repoDir: string, dryRun = true): TidyOutput {
  try {
    const tidyArgs = [CLI_BIN, 'adf', 'tidy', '--format', 'json'];
    if (dryRun) tidyArgs.splice(3, 0, '--dry-run');
    const raw = execFileSync(
      process.execPath,
      tidyArgs,
      { cwd: repoDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return JSON.parse(raw) as TidyOutput;
  } catch {
    return { dryRun, files: [], totalExtracted: 0, modulesModified: [] };
  }
}

// ============================================================================
// Static Scenario Runner
// ============================================================================

function runStaticScenario(scenario: Scenario): ScenarioResult {
  const tmp = makeTempRepo(scenario);
  const sessionResults = [];
  const sessionAudits: StaticSessionAudit[] = [];
  const snapshots: AdfSnapshot[] = [];
  let prevSnapshot: AdfSnapshot | undefined;
  let scenarioPass = true;
  const baseClaude = THIN_POINTER.trim();
  const aiDir = path.join(tmp, '.ai');

  for (const session of scenario.sessions) {
    // Each session: inject onto thin pointer, dry-run to evaluate, then apply
    // to reset state so the next session starts from a clean CLAUDE.md.
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), THIN_POINTER + '\n' + session.inject);

    const tidyOutput = runTidy(tmp, true);   // dry-run: measure only this session's content
    const sessionResult = evaluateSession(session, tidyOutput);
    printSessionResult(sessionResult);
    sessionResults.push(sessionResult);
    if (!sessionResult.pass) scenarioPass = false;

    // Apply tidy (non-dry-run) to route content into ADF modules, restoring
    // CLAUDE.md to thin pointer so the next session sees a clean baseline.
    const applyOutput = runTidy(tmp, false);

    const postClaude = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8').trim();
    const claudeRestored = postClaude === baseClaude;
    if (!claudeRestored) {
      scenarioPass = false;
      console.log('      portability warning: CLAUDE.md was not restored to thin pointer state');
    }

    const snapshot = inspectAdfModules(aiDir, session.label, prevSnapshot);
    snapshots.push(snapshot);
    prevSnapshot = snapshot;
    const itemRoutes = previewItemRoutes(session.inject, scenario);

    sessionAudits.push({
      sessionLabel: session.label,
      dryRunExtracted: tidyOutput.totalExtracted,
      appliedModulesModified: applyOutput.modulesModified,
      claudeRestored,
      adfTotalItems: snapshot.totalItemsAcrossAllModules,
      modulesGrew: snapshot.grew,
      itemRoutes,
    });

    if (!sessionResult.pass) {
      console.log('      item routing preview:');
      for (const item of itemRoutes) {
        const matches = item.matchedTriggers.length > 0 ? ` | matches=${item.matchedTriggers.join(', ')} score=${item.matchScore}` : '';
        console.log(`        [${item.heading || 'preamble'} -> ${item.headingModule}] ${item.targetModule} (${item.targetSection}) :: ${item.content}${matches}`);
      }
    }
  }

  const accumulationIssues = detectAccumulationIssues(snapshots);
  if (accumulationIssues.length > 0) {
    console.log('      accumulation warnings:');
    for (const issue of accumulationIssues) console.log(`        - ${issue}`);
  }

  return {
    scenarioId: scenario.id,
    archetype: scenario.archetype,
    description: scenario.description,
    sessions: sessionResults,
    staticAudit: {
      sessions: sessionAudits,
      accumulationIssues,
    },
    pass: scenarioPass,
  };
}

function previewItemRoutes(inject: string, scenario: Scenario): StaticItemRoute[] {
  const triggerMap: TriggerMap = {};
  for (const entry of scenario.manifest.onDemand) {
    if (entry.triggers.length > 0) {
      triggerMap[entry.path] = entry.triggers.map(trigger => trigger.toLowerCase());
    }
  }

  const sections = parseMarkdownSections(inject);
  const plan = buildMigrationPlan(sections, undefined, triggerMap);

  return plan.items.map(item => ({
    heading: item.sourceHeading,
    content: item.element.content,
    headingModule: previewHeadingModule(item.sourceHeading),
    targetModule: item.classification.targetModule,
    targetSection: item.classification.targetSection,
    decision: item.classification.decision,
    reason: item.classification.reason,
    ...scoreItemAgainstTriggers(item.element.content, triggerMap),
  }));
}

function previewHeadingModule(heading: string): string {
  const lower = heading.toLowerCase();
  if (/\b(design.system|ui|frontend|css|component|react|vue|svelte|next|nextjs|tailwind|shadcn|radix|storybook|vite|vitest|playwright|remix|nuxt|astro)\b/.test(lower)) {
    return 'frontend.adf';
  }
  if (/\b(qa|quality|test|testing|verification|validate|validation|contract|smoke|evidence|audit)\b/.test(lower)) {
    return 'qa.adf';
  }
  if (/\b(auth|authentication|authorization|security|secret|token|permission|cors|rate.limit|jwt|oauth|clerk|nextauth|lucia|session|cookie|csrf|xss|password|bcrypt)\b/.test(lower)) {
    return 'security.adf';
  }
  if (/\b(deploy|deployment|infrastructure|infra|ci|cd|pipeline|config|configuration|environment|env|docker|wrangler|cloudflare|vercel|netlify|railway|fly|render|github.actions|kv|d1|r2|queue|durable.object)\b/.test(lower)) {
    return 'infra.adf';
  }
  if (/\b(api|backend|server|database|db|endpoint|query|migration|handler|prisma|drizzle|mongoose|postgres|postgresql|mysql|sqlite|express|fastify|hono|trpc|zod|graphql)\b/.test(lower)) {
    return 'backend.adf';
  }
  return 'core.adf';
}

function scoreItemAgainstTriggers(text: string, triggerMap: TriggerMap): Pick<StaticItemRoute, 'matchedTriggers' | 'matchScore'> {
  const lower = text.toLowerCase();
  let matchedTriggers: string[] = [];
  let matchScore = 0;

  for (const triggers of Object.values(triggerMap)) {
    const currentMatches = triggers.filter(trigger =>
      new RegExp(`\\b${escapeRegex(trigger)}(?:s|ed|ing|ment|tion|ity|ication)?\\b`, 'i').test(lower),
    );
    if (currentMatches.length > matchScore) {
      matchedTriggers = currentMatches;
      matchScore = currentMatches.length;
    }
  }

  return { matchedTriggers, matchScore };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Ollama Scenario Runner (exploratory — no expected routing)
// ============================================================================

interface OllamaSessionRecord {
  label: string;
  topic: string;
  inject: string;
  totalExtracted: number;
  routing: Record<string, number>;
  coreBleedRate: number;
  moduleWarnings: Array<{ module: string; section: string; itemCount: number }>;
}

interface OllamaScenarioRecord {
  scenarioId: string;
  archetype: string;
  model: string;
  sessions: OllamaSessionRecord[];
  avgCoreBleedRate: number;
  totalExtracted: number;
}

async function runOllamaScenario(archetype: string): Promise<OllamaScenarioRecord> {
  console.log(`\n  generating ${sessionCount} sessions via ${ollamaModel}...`);

  const generated = await generateScenarios(archetype, ollamaModel, sessionCount);
  const manifest = getArchetypeManifest(archetype);

  // Build a synthetic Scenario for repo creation
  const synthetic: Scenario = {
    id: generated.id,
    archetype: archetype as Scenario['archetype'],
    description: `Ollama-generated (${ollamaModel})`,
    manifest,
    sessions: [],
  };

  const tmp = makeTempRepo(synthetic);
  const sessionRecords: OllamaSessionRecord[] = [];
  let accumulatedContent = '';

  for (const session of generated.sessions) {
    accumulatedContent += '\n' + session.inject;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), THIN_POINTER + accumulatedContent);

    const tidyOutput = runTidy(tmp);

    // Flatten routing across all files
    const routing: Record<string, number> = {};
    for (const f of tidyOutput.files) {
      for (const [mod, count] of Object.entries(f.routing)) {
        routing[mod] = (routing[mod] ?? 0) + count;
      }
    }

    const total = tidyOutput.totalExtracted;
    const coreBled = routing['core.adf'] ?? 0;
    const bleedRate = total > 0 ? coreBled / total : 0;

    const warnings = tidyOutput.moduleWarnings ?? [];
    const icon = bleedRate < 0.25 ? '✓' : bleedRate < 0.5 ? '~' : '✗';
    console.log(`    ${icon} ${session.topic}`);
    console.log(`      extracted: ${total} | core bleed: ${(bleedRate * 100).toFixed(0)}%`);
    for (const [mod, count] of Object.entries(routing)) {
      console.log(`      ${mod}: ${count}`);
    }
    for (const w of warnings) {
      console.log(`      ⚠ ${w.module} > ${w.section}: ${w.itemCount} items`);
    }

    sessionRecords.push({
      label: session.label,
      topic: session.topic,
      inject: session.inject,
      totalExtracted: total,
      routing,
      coreBleedRate: bleedRate,
      moduleWarnings: warnings,
    });
  }

  const avgBleed = sessionRecords.reduce((s, r) => s + r.coreBleedRate, 0) / sessionRecords.length;
  const totalExtracted = sessionRecords.reduce((s, r) => s + r.totalExtracted, 0);

  return {
    scenarioId: generated.id,
    archetype,
    model: ollamaModel,
    sessions: sessionRecords,
    avgCoreBleedRate: avgBleed,
    totalExtracted,
  };
}

// ============================================================================
// Real Repo Runner — copies actual .ai/, applies tidy for real, inspects ADF
// ============================================================================

interface RealRepoResult {
  repoId: string;
  label: string;
  model: string;
  sessions: Array<{
    topic: string;
    inject: string;
    tidyExtracted: number;
    tidyModified: string[];
    adfSnapshot: AdfSnapshot;
  }>;
  accumulationIssues: string[];
  finalAdfState: AdfSnapshot | null;
}

async function runRealRepo(repoId: string): Promise<RealRepoResult> {
  const repo = REAL_REPOS.find(r => r.id === repoId);
  if (!repo) throw new Error(`Unknown repo: ${repoId}`);

  console.log(`\n▶ ${repo.label} (${repo.id})`);

  // Spin up a temp repo seeded with the real .ai/ directory
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `charter-real-${repo.id}-`));
  tempDirs.push(tmp);

  execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'harness@stackbilt.dev'], { cwd: tmp, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Harness'], { cwd: tmp, stdio: 'pipe' });

  // Copy real .ai/ directory
  const targetAiDir = path.join(tmp, '.ai');
  fs.mkdirSync(targetAiDir);
  for (const f of fs.readdirSync(repo.aiDir)) {
    fs.copyFileSync(path.join(repo.aiDir, f), path.join(targetAiDir, f));
  }

  // Copy real CLAUDE.md as starting state
  fs.copyFileSync(repo.claudeMd, path.join(tmp, 'CLAUDE.md'));

  execFileSync('git', ['add', '-A'], { cwd: tmp, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'seed from real repo'], { cwd: tmp, stdio: 'pipe' });

  console.log(`  seeded from: ${repo.aiDir}`);
  console.log(`  generating ${sessionCount} sessions via ${ollamaModel}...`);

  // Baseline ADF snapshot before any injection
  let prevSnapshot: AdfSnapshot | undefined;
  const allSnapshots: AdfSnapshot[] = [];

  // Generate sessions grounded in real repo context
  const topics = repo.topics.slice(0, sessionCount);
  const sessionRecords: RealRepoResult['sessions'] = [];

  for (const topic of topics) {
    const prompt = `${repo.ollamaContext}
You just finished: ${topic}.
Write the markdown content you would add to CLAUDE.md to document what you learned or decided.
Start with a ## heading. Be specific to this codebase — use real file names and patterns. 3-6 items.`;

    process.stdout.write(`\n  [${topic.slice(0, 50)}]\n  generating... `);

    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        prompt,
        system: 'Write ONLY the markdown sections. Start with a ## heading. No preamble.',
        stream: false,
        options: { temperature: 0.8, num_predict: 350 },
      }),
    });
    const data = await res.json() as { response: string };
    const inject = data.response.trim();
    process.stdout.write('done\n');

    console.log(inject.split('\n').map(l => `    ${l}`).join('\n'));

    // Inject into CLAUDE.md
    const currentClaude = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), currentClaude.trimEnd() + '\n' + inject + '\n');

    // Apply tidy for real (no dry-run)
    const tidyOutput = runTidy(tmp, false);

    // Snapshot ADF state after tidy
    const snapshot = inspectAdfModules(targetAiDir, topic, prevSnapshot);
    printSnapshot(snapshot, prevSnapshot);
    allSnapshots.push(snapshot);
    prevSnapshot = snapshot;

    console.log(`\n  tidy: extracted=${tidyOutput.totalExtracted} modified=[${tidyOutput.modulesModified.join(', ')}]`);

    sessionRecords.push({
      topic,
      inject,
      tidyExtracted: tidyOutput.totalExtracted,
      tidyModified: tidyOutput.modulesModified,
      adfSnapshot: snapshot,
    });
  }

  // Final accumulation analysis
  const issues = detectAccumulationIssues(allSnapshots);
  if (issues.length > 0) {
    console.log(`\n  ⚠ Accumulation issues detected:`);
    for (const issue of issues) console.log(`    - ${issue}`);
  } else {
    console.log(`\n  ✓ No accumulation issues detected`);
  }

  return {
    repoId: repo.id,
    label: repo.label,
    model: ollamaModel,
    sessions: sessionRecords,
    accumulationIssues: issues,
    finalAdfState: allSnapshots.at(-1) ?? null,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  if (!fs.existsSync(CLI_BIN)) {
    console.error(`✗ CLI binary not found: ${CLI_BIN}`);
    console.error('  Run `pnpm run build` first.');
    process.exit(1);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // ── Real repo mode ─────────────────────────────────────────────────────────
  if (useReal) {
    let repos = REAL_REPOS;
    if (filterArchetype) {
      repos = REAL_REPOS.filter(r => r.id === filterArchetype);
      if (repos.length === 0) {
        console.error(`✗ Unknown repo: ${filterArchetype}. Use: ${REAL_REPOS.map(r => r.id).join(', ')}`);
        process.exit(1);
      }
    }

    console.log(`\nCharter Harness — Real Repo Mode`);
    console.log(`  model : ${ollamaModel}`);
    console.log(`  repos : ${repos.map(r => r.id).join(', ')}`);
    console.log(`  topics: up to ${sessionCount} per repo`);

    const allRealResults: RealRepoResult[] = [];
    for (const repo of repos) {
      allRealResults.push(await runRealRepo(repo.id));
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const reportPath = path.join(RESULTS_DIR, `real-${timestamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({
      runAt: new Date().toISOString(),
      mode: 'real',
      model: ollamaModel,
      repos: allRealResults,
    }, null, 2));
    console.log(`\nReport: ${reportPath}`);
    cleanup();
    return;
  }

  // ── Ollama mode ────────────────────────────────────────────────────────────
  if (useOllama) {
    let archetypes = OLLAMA_ARCHETYPES;
    if (filterArchetype) {
      archetypes = OLLAMA_ARCHETYPES.filter(a => a === filterArchetype || a.startsWith(filterArchetype));
      if (archetypes.length === 0) {
        console.error(`✗ Unknown archetype: ${filterArchetype}. Use: ${OLLAMA_ARCHETYPES.join(', ')}`);
        process.exit(1);
      }
    }

    console.log(`\nCharter Harness — Ollama Mode`);
    console.log(`  model     : ${ollamaModel}`);
    console.log(`  archetypes: ${archetypes.join(', ')}`);
    console.log(`  sessions  : ${sessionCount} per archetype`);

    const ollamaResults: OllamaScenarioRecord[] = [];

    for (const archetype of archetypes) {
      console.log(`\n▶ ${archetype}`);
      const record = await runOllamaScenario(archetype);
      ollamaResults.push(record);
      console.log(`  avg core bleed: ${(record.avgCoreBleedRate * 100).toFixed(0)}%`);
    }

    const reportPath = path.join(RESULTS_DIR, `ollama-${timestamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({
      runAt: new Date().toISOString(),
      mode: 'ollama',
      model: ollamaModel,
      cliBin: CLI_BIN,
      scenarios: ollamaResults,
    }, null, 2));

    console.log('\n' + '─'.repeat(50));
    console.log('Core bleed by archetype:');
    for (const r of ollamaResults) {
      const bar = '█'.repeat(Math.round(r.avgCoreBleedRate * 20));
      console.log(`  ${r.archetype.padEnd(12)} ${(r.avgCoreBleedRate * 100).toFixed(0).padStart(3)}% ${bar}`);
    }
    console.log(`\nReport: ${reportPath}`);

    cleanup();
    return;
  }

  // ── Static mode ────────────────────────────────────────────────────────────
  let scenarios = ALL_STATIC;
  if (filterScenario) {
    scenarios = scenarios.filter(s => s.id === filterScenario);
    if (scenarios.length === 0) {
      console.error(`✗ No scenario: ${filterScenario}`);
      process.exit(1);
    }
  }
  if (filterArchetype) {
    scenarios = scenarios.filter(s => s.archetype === filterArchetype || s.id.startsWith(filterArchetype));
    if (scenarios.length === 0) {
      console.error(`✗ No scenarios for archetype/prefix: ${filterArchetype}`);
      process.exit(1);
    }
  }

  const totalSessions = scenarios.reduce((s, sc) => s + sc.sessions.length, 0);
  console.log(`\nCharter Scenario Harness`);
  console.log(`  scenarios : ${scenarios.length}`);
  console.log(`  sessions  : ${totalSessions}`);
  console.log(`  cli       : ${CLI_BIN}`);
  console.log('');

  const scenarioResults: ScenarioResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const scenario of scenarios) {
    console.log(`▶ ${scenario.id} (${scenario.archetype})`);
    console.log(`  ${scenario.description}`);

    const result = runStaticScenario(scenario);
    scenarioResults.push(result);

    if (result.pass) passed++; else failed++;
    console.log(`  ${result.pass ? '✓ pass' : '✗ fail'}\n`);
  }

  const report: HarnessReport = {
    runAt: new Date().toISOString(),
    cliBin: CLI_BIN,
    totalScenarios: scenarios.length,
    totalSessions,
    passed,
    failed,
    scenarios: scenarioResults,
  };

  const reportPath = path.join(RESULTS_DIR, `run-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('─'.repeat(50));
  console.log(`Scenarios : ${passed} passed, ${failed} failed`);
  console.log(`Report    : ${reportPath}`);
  console.log('');

  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  cleanup();
  process.exit(1);
});

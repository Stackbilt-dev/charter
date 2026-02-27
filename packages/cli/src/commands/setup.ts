/**
 * charter setup
 *
 * One-command bootstrap for local governance checks.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { CLIOptions } from '../index';
import { CLIError } from '../index';
import { EXIT_CODE } from '../index';
import { initializeCharter, type StackPreset } from './init';
import packageJson from '../../package.json';

const CLI_VERSION = packageJson.version;

export function getGithubWorkflow(packageManager: 'npm' | 'pnpm'): string {
  const installStep = packageManager === 'pnpm'
    ? `      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile`
    : `      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: |
          if [ -f package-lock.json ]; then
            npm ci
          else
            npm install
          fi`;

  return `name: Governance Check

on:
  pull_request:
    branches: [main, master]

permissions:
  contents: read
  pull-requests: write

jobs:
  governance:
    name: Charter
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

${installStep}

      - name: Validate Commits
        run: npx charter validate --ci --format text

      - name: Drift Scan
        run: npx charter drift --ci --format text

      - name: ADF Wiring & Pointer Integrity
        run: npx charter doctor --adf-only --ci --format text
        if: hashFiles('.ai/manifest.adf') != ''

      - name: ADF Evidence
        run: npx charter adf evidence --auto-measure --ci --format text
        if: hashFiles('.ai/manifest.adf') != ''

      - name: Audit Report
        run: npx charter audit --format json > /tmp/audit.json
        if: always()
`;
}

export interface SetupResult {
  configPath: string;
  initialized: boolean;
  detected: DetectionResult;
  selectedPreset: StackPreset;
  inferenceMode: 'auto' | 'preset-override' | 'fallback-conservative';
  workflow: {
    mode: 'none' | 'github';
    path?: string;
    created?: boolean;
    updated?: boolean;
  };
  scripts: {
    packageJsonPath?: string;
    updated: boolean;
    added: string[];
    updatedEntries: string[];
  };
  dependencies: {
    packageJsonPath?: string;
    updated: boolean;
    added: string[];
    updatedEntries: string[];
    skipped?: boolean;
    reason?: string;
  };
  mutationPlan: SetupMutationReport;
  appliedMutations: SetupMutationReport;
}

export interface SetupMutationReport {
  baseline: {
    action: 'create' | 'update' | 'noop';
    path: string;
    configHashBefore?: string;
    configHashAfter?: string;
    writesPerformed: number;
  };
  workflow: {
    action: 'create' | 'update' | 'noop' | 'skip';
    path?: string;
  };
  scripts: {
    action: 'create' | 'update' | 'noop' | 'skip';
    path?: string;
    add: string[];
    update: string[];
  };
  dependencies: {
    action: 'create' | 'update' | 'noop' | 'skip';
    path?: string;
    add: string[];
    update: string[];
    skipped: boolean;
    reason?: string;
  };
}

export interface DetectionResult {
  runtime: string[];
  frameworks: string[];
  state: string[];
  sources: string[];
  agentStandards: string[];
  monorepo: boolean;
  signals: {
    hasFrontend: boolean;
    hasBackend: boolean;
    hasWorker: boolean;
    hasCloudflare: boolean;
    hasHono: boolean;
    hasReact: boolean;
    hasVite: boolean;
    hasPnpm: boolean;
  };
  mixedStack: boolean;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  suggestedPreset: StackPreset;
  warnings: string[];
}

export interface PackageContext {
  source: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string; pnpm?: string };
  packageManager?: string;
  name?: string;
}

export async function setupCommand(options: CLIOptions, args: string[]): Promise<number> {
  const ciMode = getFlag(args, '--ci');
  const presetFlag = getFlag(args, '--preset');
  const detectOnly = args.includes('--detect-only');
  const explicitForce = args.includes('--force');
  const force = options.yes || explicitForce;
  const noDependencySync = args.includes('--no-dependency-sync');

  if (ciMode && ciMode !== 'github') {
    throw new CLIError(`Unsupported CI target: ${ciMode}. Supported: github`);
  }

  if (presetFlag && !isValidPreset(presetFlag)) {
    throw new CLIError(`Invalid --preset value: ${presetFlag}. Use worker|frontend|backend|fullstack.`);
  }

  const contexts = loadPackageContexts();
  const detection = detectStack(contexts);
  const packageManager = detectPackageManager(contexts);
  const selectedPreset: StackPreset = isValidPreset(presetFlag) ? presetFlag : detection.suggestedPreset;
  const inferenceMode = presetFlag
    ? 'preset-override'
    : detection.confidence === 'LOW'
      ? 'fallback-conservative'
      : 'auto';

  if (detectOnly) {
    if (options.format === 'json') {
      console.log(JSON.stringify({
        detected: detection,
        selectedPreset,
        inferenceMode,
      }, null, 2));
    } else {
      console.log('');
      console.log('  Stack detection result');
      console.log(`  Runtime: ${detection.runtime.join(', ') || 'none detected'}`);
      console.log(`  Frameworks: ${detection.frameworks.join(', ') || 'none detected'}`);
      console.log(`  State: ${detection.state.join(', ') || 'none detected'}`);
      console.log(`  Sources: ${detection.sources.join(', ') || 'none'}`);
      console.log(`  Agent standards: ${detection.agentStandards.join(', ') || 'none detected'}`);
      console.log(`  Monorepo: ${detection.monorepo ? 'yes' : 'no'}`);
      console.log(`  Confidence: ${detection.confidence}`);
      console.log(`  Selected preset: ${selectedPreset} (${inferenceMode})`);
      if (detection.mixedStack) {
        console.log('  Mixed stack detected (frontend/backend split or multi-runtime). Recommended preset: fullstack');
        console.log('  Example: charter setup --preset fullstack --ci github --yes');
      }
      for (const warning of detection.warnings) {
        console.log(`  Warning: ${warning}`);
      }
      console.log('');
    }
    return EXIT_CODE.SUCCESS;
  }

  const baselinePath = path.join(options.configPath, 'config.json');
  const configHashBefore = hashFileIfExists(baselinePath);
  const baselinePlan = planBaselineMutation(baselinePath, explicitForce);
  const workflowPath = path.join('.github', 'workflows', 'charter-governance.yml');
  const workflowPlan = ciMode === 'github'
    ? planManagedFile(workflowPath, getGithubWorkflow(packageManager))
    : { action: 'skip' as const };
  const manifestPlan = syncPackageManifest(selectedPreset, !noDependencySync, false);

  const initResult = initializeCharter(options.configPath, explicitForce, {
    preset: selectedPreset,
    projectName: inferProjectName(contexts),
    features: {
      cloudflare: detection.signals.hasCloudflare,
      hono: detection.signals.hasHono,
      react: detection.signals.hasReact,
      vite: detection.signals.hasVite,
    },
  });
  const configHashAfter = hashFileIfExists(baselinePath);
  const baselineAppliedAction: SetupMutationReport['baseline']['action'] =
    !configHashBefore && !!configHashAfter
      ? 'create'
      : configHashBefore !== configHashAfter
        ? 'update'
        : 'noop';

  const result: SetupResult = {
    configPath: options.configPath,
    initialized: initResult.created,
    detected: detection,
    selectedPreset,
    inferenceMode,
    workflow: {
      mode: ciMode === 'github' ? 'github' : 'none',
    },
    scripts: {
      updated: false,
      added: [],
      updatedEntries: [],
    },
    dependencies: {
      updated: false,
      added: [],
      updatedEntries: [],
    },
    mutationPlan: {
      baseline: {
        action: baselinePlan.action,
        path: baselinePath.replace(/\\/g, '/'),
        configHashBefore: configHashBefore || undefined,
        configHashAfter: configHashBefore || undefined,
        writesPerformed: 0,
      },
      workflow: {
        action: workflowPlan.action,
        path: ciMode === 'github' ? workflowPath.replace(/\\/g, '/') : undefined,
      },
      scripts: manifestPlan.report.scripts,
      dependencies: manifestPlan.report.dependencies,
    },
    appliedMutations: {
      baseline: {
        action: baselineAppliedAction,
        path: baselinePath.replace(/\\/g, '/'),
        configHashBefore: configHashBefore || undefined,
        configHashAfter: configHashAfter || undefined,
        writesPerformed: initResult.writesPerformed,
      },
      workflow: {
        action: 'skip',
      },
      scripts: {
        action: 'skip',
        add: [],
        update: [],
      },
      dependencies: {
        action: 'skip',
        add: [],
        update: [],
        skipped: noDependencySync,
        reason: noDependencySync ? '--no-dependency-sync' : undefined,
      },
    },
  };

  if (ciMode === 'github') {
    const workflowWrite = applyManagedFile(
      workflowPath,
      getGithubWorkflow(packageManager),
      force
    );

    result.workflow = {
      mode: 'github',
      path: workflowPath,
      created: workflowWrite.created,
      updated: workflowWrite.updated,
    };
    result.appliedMutations.workflow = {
      action: workflowWrite.created ? 'create' : workflowWrite.updated ? 'update' : 'noop',
      path: workflowPath.replace(/\\/g, '/'),
    };
  }

  const manifestApplied = syncPackageManifest(selectedPreset, !noDependencySync, true);
  result.scripts = manifestApplied.legacy.scripts;
  result.dependencies = manifestApplied.legacy.dependencies;
  result.appliedMutations.scripts = manifestApplied.report.scripts;
  result.appliedMutations.dependencies = manifestApplied.report.dependencies;

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return EXIT_CODE.SUCCESS;
  }

  console.log('  Governance guardrails are now active for this repo.');
  console.log(`  Baseline path: ${result.configPath}`);
  console.log(`  Baseline created: ${result.initialized ? 'yes' : 'already present'}`);
  console.log(`  Stack preset: ${result.selectedPreset} (${result.inferenceMode})`);
  console.log(`  Detection confidence: ${result.detected.confidence}`);
  if (result.detected.mixedStack) {
    console.log('  Mixed stack detected (frontend/backend split or multi-runtime).');
    console.log('  Recommendation: use --preset fullstack when frontend exists under client/ or apps/web.');
  }
  for (const warning of result.detected.warnings) {
    console.log(`  Detection warning: ${warning}`);
  }

  if (result.workflow.mode === 'github') {
    const workflowState = result.workflow.created
      ? 'enabled'
      : result.workflow.updated
        ? 'updated'
        : 'already present';
    console.log(`  CI policy gate: ${workflowState} (${result.workflow.path})`);
  }
  if (result.scripts.updated) {
    const added = result.scripts.added.length > 0 ? `added [${result.scripts.added.join(', ')}]` : '';
    const updated = result.scripts.updatedEntries.length > 0 ? `updated [${result.scripts.updatedEntries.join(', ')}]` : '';
    console.log(`  Package scripts synced: ${[added, updated].filter(Boolean).join('; ')} (${result.scripts.packageJsonPath})`);
  }
  if (result.dependencies.updated) {
    const added = result.dependencies.added.length > 0 ? `added [${result.dependencies.added.join(', ')}]` : '';
    const updated = result.dependencies.updatedEntries.length > 0 ? `updated [${result.dependencies.updatedEntries.join(', ')}]` : '';
    console.log(`  Package dependencies synced: ${[added, updated].filter(Boolean).join('; ')} (${result.dependencies.packageJsonPath})`);
  } else if (result.dependencies.skipped) {
    console.log(`  Package dependency sync skipped: ${result.dependencies.reason}`);
  }

  console.log('');
  console.log('  What this gives you immediately:');
  console.log('    - Merge-time checks for risky changes without governance links');
  console.log('    - Drift detection against your blessed stack');
  console.log('    - Audit-ready governance evidence from repo history');
  console.log('');
  console.log('  Run now:');
  console.log('    1. charter classify "<planned change summary>"');
  console.log('    2. charter hook install --commit-msg');
  console.log('    3. charter validate --format text');
  console.log('    4. charter drift --format text');
  console.log('    5. charter audit --format text');
  console.log('');
  console.log('  Adoption ramp option:');
  console.log('    - Set "validation.citationStrictness": "WARN" in .charter/config.json for an initial non-blocking trailer policy.');
  console.log('    - Keep "git.trailerThreshold" at HIGH initially, then tighten based on team maturity.');

  return EXIT_CODE.SUCCESS;
}

export function detectStack(contexts: PackageContext[]): DetectionResult {
  if (contexts.length === 0) {
    return {
      runtime: [],
      frameworks: [],
      state: [],
      sources: [],
      agentStandards: [],
      monorepo: false,
      signals: {
        hasFrontend: false,
        hasBackend: false,
        hasWorker: false,
        hasCloudflare: false,
        hasHono: false,
        hasReact: false,
        hasVite: false,
        hasPnpm: false,
      },
      mixedStack: false,
      confidence: 'LOW',
      suggestedPreset: 'fullstack',
      warnings: [],
    };
  }

  const depNames = new Set<string>();
  for (const ctx of contexts) {
    for (const dep of Object.keys(ctx.dependencies || {})) depNames.add(dep);
    for (const dep of Object.keys(ctx.devDependencies || {})) depNames.add(dep);
  }

  const hasFrontendDep = hasAny(depNames, ['next', 'react', 'vite', 'vue', '@angular/core', 'svelte']);
  const hasFrontendPathSignals = hasAnyPath(['client', 'frontend', 'apps/web', 'web']);
  const hasFrontend = hasFrontendDep || hasFrontendPathSignals;
  const hasBackend = hasAny(depNames, ['express', 'fastify', 'nestjs', '@nestjs/core', 'koa', 'hono']);
  const hasWorker = hasAny(depNames, ['wrangler', '@cloudflare/workers-types']);

  const hasCloudflare = hasAny(depNames, ['wrangler', '@cloudflare/workers-types']);
  const hasHono = hasAny(depNames, ['hono']);
  const hasReact = hasAny(depNames, ['react']);
  const hasVite = hasAny(depNames, ['vite']);
  const hasPnpm = contexts.some((ctx) => !!ctx.engines?.pnpm)
    || contexts.some((ctx) => typeof ctx.packageManager === 'string' && ctx.packageManager.toLowerCase().startsWith('pnpm@'))
    || fs.existsSync(path.resolve('pnpm-lock.yaml'));
  const monorepo = contexts.length > 1 || fs.existsSync(path.resolve('pnpm-workspace.yaml'));
  const agentStandards = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']
    .filter((filename) => fs.existsSync(path.resolve(filename)));

  const frameworks: string[] = [];
  const runtime: string[] = [];
  const state: string[] = [];

  if (hasFrontendDep) {
    frameworks.push(...pick(depNames, ['next', 'react', 'vite', 'vue', '@angular/core', 'svelte']));
  }
  if (hasBackend) {
    frameworks.push(...pick(depNames, ['express', 'fastify', 'nestjs', '@nestjs/core', 'koa', 'hono']));
  }
  if (hasWorker) runtime.push('edge-worker');
  if (contexts.some((ctx) => !!ctx.engines?.node) || hasAny(depNames, ['typescript', 'ts-node', 'express', 'fastify', 'next'])) {
    runtime.push('node');
  }
  if (hasAny(depNames, ['zustand', 'redux', '@reduxjs/toolkit', 'mobx', 'xstate'])) {
    state.push(...pick(depNames, ['zustand', 'redux', '@reduxjs/toolkit', 'mobx', 'xstate']));
  }

  const dedup = (values: string[]) => [...new Set(values)];
  const dedupRuntime = dedup(runtime);
  const mixedStack = (hasFrontend && (hasBackend || hasWorker)) || dedupRuntime.length > 1;
  const signals = {
    hasFrontend,
    hasBackend,
    hasWorker,
    hasCloudflare,
    hasHono,
    hasReact,
    hasVite,
    hasPnpm,
  };
  const warnings: string[] = [];

  if (dedupRuntime.length > 1 && !(hasFrontend && (hasBackend || hasWorker))) {
    warnings.push('Multiple runtime families detected without clear frontend/backend split; verify preset selection.');
  }
  if (agentStandards.length > 0) {
    warnings.push(`Agent standards detected (${agentStandards.join(', ')}); align Charter policy with existing agent instructions.`);
  }

  if (mixedStack) {
    const isClassicMixed = hasFrontend && (hasBackend || hasWorker);
    return {
      runtime: dedupRuntime,
      frameworks: dedup(frameworks),
      state: dedup(state),
      sources: contexts.map((c) => c.source),
      agentStandards,
      monorepo,
      signals,
      mixedStack: true,
      confidence: isClassicMixed ? 'HIGH' : 'MEDIUM',
      suggestedPreset: 'fullstack',
      warnings,
    };
  }
  if (hasWorker && !hasFrontend && !hasBackend) {
    return {
      runtime: dedupRuntime,
      frameworks: dedup(frameworks),
      state: dedup(state),
      sources: contexts.map((c) => c.source),
      agentStandards,
      monorepo,
      signals,
      mixedStack: false,
      confidence: 'HIGH',
      suggestedPreset: 'worker',
      warnings,
    };
  }
  if (hasFrontend) {
    return {
      runtime: dedupRuntime,
      frameworks: dedup(frameworks),
      state: dedup(state),
      sources: contexts.map((c) => c.source),
      agentStandards,
      monorepo,
      signals,
      mixedStack: false,
      confidence: warnings.length > 0 ? 'MEDIUM' : 'HIGH',
      suggestedPreset: 'frontend',
      warnings,
    };
  }
  if (hasBackend) {
    return {
      runtime: dedupRuntime,
      frameworks: dedup(frameworks),
      state: dedup(state),
      sources: contexts.map((c) => c.source),
      agentStandards,
      monorepo,
      signals,
      mixedStack: false,
      confidence: warnings.length > 0 ? 'MEDIUM' : 'HIGH',
      suggestedPreset: 'backend',
      warnings,
    };
  }
  if (runtime.length > 0 || state.length > 0) {
    return {
      runtime: dedupRuntime,
      frameworks: dedup(frameworks),
      state: dedup(state),
      sources: contexts.map((c) => c.source),
      agentStandards,
      monorepo,
      signals,
      mixedStack: false,
      confidence: 'MEDIUM',
      suggestedPreset: 'fullstack',
      warnings,
    };
  }
  return {
    runtime: dedupRuntime,
    frameworks: dedup(frameworks),
    state: dedup(state),
    sources: contexts.map((c) => c.source),
    agentStandards,
    monorepo,
    signals,
    mixedStack: false,
    confidence: 'LOW',
    suggestedPreset: 'fullstack',
    warnings,
  };
}

export function loadPackageContexts(): PackageContext[] {
  const candidates = new Set<string>(['package.json']);

  for (const dir of ['client', 'frontend', 'web']) {
    candidates.add(path.join(dir, 'package.json'));
  }
  candidates.add(path.join('apps', 'web', 'package.json'));

  const appsDir = path.resolve('apps');
  if (fs.existsSync(appsDir)) {
    for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.add(path.join('apps', entry.name, 'package.json'));
      }
    }
  }
  const packagesDir = path.resolve('packages');
  if (fs.existsSync(packagesDir)) {
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.add(path.join('packages', entry.name, 'package.json'));
      }
    }
  }
  for (const workspaceManifest of resolvePnpmWorkspacePackageJsons()) {
    candidates.add(workspaceManifest);
  }

  const contexts: PackageContext[] = [];
  for (const relativePath of candidates) {
    const absolutePath = path.resolve(relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf-8')) as Omit<PackageContext, 'source'>;
      contexts.push({
        source: relativePath.replace(/\\/g, '/'),
        dependencies: parsed.dependencies,
        devDependencies: parsed.devDependencies,
        engines: parsed.engines,
        packageManager: parsed.packageManager,
        name: parsed.name,
      });
    } catch {
      // ignore malformed package file
    }
  }

  return contexts;
}

export function detectPackageManager(contexts: PackageContext[]): 'npm' | 'pnpm' {
  const root = contexts.find((ctx) => ctx.source === 'package.json');
  if (root?.engines?.pnpm || fs.existsSync(path.resolve('pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (typeof root?.packageManager === 'string' && root.packageManager.toLowerCase().startsWith('pnpm@')) {
    return 'pnpm';
  }
  return 'npm';
}

function resolvePnpmWorkspacePackageJsons(): string[] {
  const workspaceFile = path.resolve('pnpm-workspace.yaml');
  if (!fs.existsSync(workspaceFile)) return [];

  let content = '';
  try {
    content = fs.readFileSync(workspaceFile, 'utf-8');
  } catch {
    return [];
  }

  const globs = parsePnpmWorkspaceGlobs(content);
  const resolved = new Set<string>();
  for (const glob of globs) {
    for (const match of expandWorkspacePackageJsonGlob(glob)) {
      resolved.add(match);
    }
  }
  return [...resolved];
}

function parsePnpmWorkspaceGlobs(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const globs: string[] = [];
  let inPackagesBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inPackagesBlock) {
      if (trimmed === 'packages:') {
        inPackagesBlock = true;
      }
      continue;
    }

    if (trimmed.length > 0 && !line.startsWith(' ') && !line.startsWith('\t') && !line.trimStart().startsWith('-')) {
      break;
    }

    const match = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
    if (match) {
      globs.push(match[1].trim());
    }
  }

  return globs;
}

function expandWorkspacePackageJsonGlob(globPattern: string): string[] {
  const normalized = globPattern.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized.length === 0) return [];

  if (!normalized.includes('*')) {
    return maybePackageJsonPathsForDir(path.resolve(normalized), normalized);
  }

  if (normalized.endsWith('/*')) {
    const root = normalized.slice(0, -2);
    const rootAbsolute = path.resolve(root);
    if (!fs.existsSync(rootAbsolute) || !fs.statSync(rootAbsolute).isDirectory()) {
      return [];
    }
    const results: string[] = [];
    for (const entry of fs.readdirSync(rootAbsolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relative = path.posix.join(root, entry.name);
      results.push(...maybePackageJsonPathsForDir(path.resolve(relative), relative));
    }
    return results;
  }

  if (normalized.includes('/**')) {
    const root = normalized.split('/**')[0];
    const rootAbsolute = path.resolve(root);
    if (!fs.existsSync(rootAbsolute) || !fs.statSync(rootAbsolute).isDirectory()) {
      return [];
    }
    return collectPackageJsonsRecursive(rootAbsolute)
      .map((absolute) => path.relative(process.cwd(), absolute).replace(/\\/g, '/'));
  }

  return [];
}

function maybePackageJsonPathsForDir(absoluteDir: string, relativeDir: string): string[] {
  const manifest = path.join(absoluteDir, 'package.json');
  if (!fs.existsSync(manifest)) return [];
  return [path.posix.join(relativeDir, 'package.json')];
}

function collectPackageJsonsRecursive(rootDir: string): string[] {
  const results: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const manifest = path.join(current, 'package.json');
    if (fs.existsSync(manifest)) {
      results.push(manifest);
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      stack.push(path.join(current, entry.name));
    }
  }

  return results;
}

export function inferProjectName(contexts: PackageContext[]): string {
  const root = contexts.find((c) => c.source === 'package.json');
  if (root?.name && root.name.trim().length > 0) {
    return root.name.trim();
  }
  const firstNamed = contexts.find((c) => c.name && c.name.trim().length > 0);
  if (firstNamed?.name) {
    return firstNamed.name.trim();
  }
  return path.basename(process.cwd());
}

function hasAny(set: Set<string>, candidates: string[]): boolean {
  return candidates.some((c) => set.has(c));
}

function hasAnyPath(paths: string[]): boolean {
  return paths.some((p) => fs.existsSync(path.resolve(p)));
}

function pick(set: Set<string>, candidates: string[]): string[] {
  return candidates.filter((c) => set.has(c));
}

function planBaselineMutation(configFilePath: string, force: boolean): { action: 'create' | 'update' | 'noop' } {
  const exists = fs.existsSync(path.resolve(configFilePath));
  if (!exists) {
    return { action: 'create' };
  }
  if (force) {
    return { action: 'update' };
  }
  return { action: 'noop' };
}

function hashFileIfExists(targetPath: string): string | null {
  const absolute = path.resolve(targetPath);
  if (!fs.existsSync(absolute)) {
    return null;
  }
  const content = fs.readFileSync(absolute);
  return createHash('sha256').update(content).digest('hex');
}

function planManagedFile(targetPath: string, content: string): { action: 'create' | 'update' | 'noop' } {
  const absolute = path.resolve(targetPath);
  const exists = fs.existsSync(absolute);

  if (!exists) {
    return { action: 'create' };
  }

  const current = fs.readFileSync(absolute, 'utf-8');
  if (current === content) {
    return { action: 'noop' };
  }
  return { action: 'update' };
}

export function applyManagedFile(targetPath: string, content: string, force: boolean): { created: boolean; updated: boolean } {
  const absolute = path.resolve(targetPath);
  const exists = fs.existsSync(absolute);

  if (!exists) {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    return { created: true, updated: false };
  }

  const current = fs.readFileSync(absolute, 'utf-8');
  if (current === content) {
    return { created: false, updated: false };
  }
  if (!force) {
    return { created: false, updated: false };
  }

  fs.writeFileSync(absolute, content);
  return { created: false, updated: true };
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function isValidPreset(value: string | undefined): value is StackPreset {
  return value === 'worker' || value === 'frontend' || value === 'backend' || value === 'fullstack';
}

export function syncPackageManifest(
  selectedPreset: StackPreset,
  syncDependencies: boolean,
  apply: boolean
): {
  report: Pick<SetupMutationReport, 'scripts' | 'dependencies'>;
  legacy: Pick<SetupResult, 'scripts' | 'dependencies'>;
} {
  const packageJsonPath = path.resolve('package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return {
      report: {
        scripts: { action: 'skip', add: [], update: [] },
        dependencies: {
          action: 'skip',
          add: [],
          update: [],
          skipped: !syncDependencies,
          reason: !syncDependencies ? '--no-dependency-sync' : 'package.json not found',
        },
      },
      legacy: {
        scripts: { updated: false, added: [], updatedEntries: [] },
        dependencies: { updated: false, added: [], updatedEntries: [], skipped: !syncDependencies, reason: !syncDependencies ? '--no-dependency-sync' : 'package.json not found' },
      },
    };
  }

  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
    const scripts = parsed.scripts || {};
    const devDependencies = parsed.devDependencies || {};

    const added: string[] = [];
    const updatedEntries: string[] = [];
    const depAdded: string[] = [];
    const depUpdated: string[] = [];
    const detectCommand = 'charter setup --detect-only --format json';
    const setupCommand = `charter setup --preset ${selectedPreset} --ci github --yes`;
    const verifyAdfCommand = 'charter doctor --adf-only --ci --format json && charter adf evidence --auto-measure --ci --format json';
    const doctorCommand = 'charter doctor --format json';
    const bundleCommand = 'charter adf bundle --task "describe task" --format json';
    const pinnedCliVersion = CLI_VERSION;

    if (!scripts['charter:detect']) {
      scripts['charter:detect'] = detectCommand;
      added.push('charter:detect');
    } else if (scripts['charter:detect'] !== detectCommand) {
      scripts['charter:detect'] = detectCommand;
      updatedEntries.push('charter:detect');
    }
    if (!scripts['charter:setup']) {
      scripts['charter:setup'] = setupCommand;
      added.push('charter:setup');
    } else if (scripts['charter:setup'] !== setupCommand) {
      scripts['charter:setup'] = setupCommand;
      updatedEntries.push('charter:setup');
    }
    if (!scripts['verify:adf']) {
      scripts['verify:adf'] = verifyAdfCommand;
      added.push('verify:adf');
    } else if (scripts['verify:adf'] !== verifyAdfCommand) {
      scripts['verify:adf'] = verifyAdfCommand;
      updatedEntries.push('verify:adf');
    }
    if (!scripts['charter:doctor']) {
      scripts['charter:doctor'] = doctorCommand;
      added.push('charter:doctor');
    } else if (scripts['charter:doctor'] !== doctorCommand) {
      scripts['charter:doctor'] = doctorCommand;
      updatedEntries.push('charter:doctor');
    }
    if (!scripts['charter:adf:bundle']) {
      scripts['charter:adf:bundle'] = bundleCommand;
      added.push('charter:adf:bundle');
    } else if (scripts['charter:adf:bundle'] !== bundleCommand) {
      scripts['charter:adf:bundle'] = bundleCommand;
      updatedEntries.push('charter:adf:bundle');
    }

    if (syncDependencies) {
      if (!devDependencies['@stackbilt/cli']) {
        devDependencies['@stackbilt/cli'] = pinnedCliVersion;
        depAdded.push('@stackbilt/cli');
      } else if (devDependencies['@stackbilt/cli'] !== pinnedCliVersion) {
        devDependencies['@stackbilt/cli'] = pinnedCliVersion;
        depUpdated.push('@stackbilt/cli');
      }
    }

    const scriptsChanged = added.length > 0 || updatedEntries.length > 0;
    const depsChanged = depAdded.length > 0 || depUpdated.length > 0;

    if (apply && (scriptsChanged || (syncDependencies && depsChanged))) {
      parsed.scripts = scripts;
      if (syncDependencies) {
        parsed.devDependencies = devDependencies;
      }
      fs.writeFileSync(packageJsonPath, JSON.stringify(parsed, null, 2) + '\n');
    }

    return {
      report: {
        scripts: {
          action: scriptsChanged ? (added.length > 0 ? 'create' : 'update') : 'noop',
          path: 'package.json',
          add: added,
          update: updatedEntries,
        },
        dependencies: {
          action: !syncDependencies ? 'skip' : depsChanged ? (depAdded.length > 0 ? 'create' : 'update') : 'noop',
          path: 'package.json',
          add: depAdded,
          update: depUpdated,
          skipped: !syncDependencies,
          reason: !syncDependencies ? '--no-dependency-sync' : undefined,
        },
      },
      legacy: {
        scripts: {
          packageJsonPath: 'package.json',
          updated: scriptsChanged,
          added,
          updatedEntries,
        },
        dependencies: {
          packageJsonPath: 'package.json',
          updated: syncDependencies ? depsChanged : false,
          added: depAdded,
          updatedEntries: depUpdated,
          skipped: !syncDependencies,
          reason: !syncDependencies ? '--no-dependency-sync' : undefined,
        },
      },
    };
  } catch {
    return {
      report: {
        scripts: { action: 'skip', add: [], update: [] },
        dependencies: {
          action: 'skip',
          add: [],
          update: [],
          skipped: !syncDependencies,
          reason: 'package.json parse/write failed',
        },
      },
      legacy: {
        scripts: { updated: false, added: [], updatedEntries: [] },
        dependencies: { updated: false, added: [], updatedEntries: [], skipped: !syncDependencies, reason: 'package.json parse/write failed' },
      },
    };
  }
}

/**
 * charter setup
 *
 * One-command bootstrap for local governance checks.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { CLIError } from '../index';
import { EXIT_CODE } from '../index';
import { initializeCharter, type StackPreset } from './init';

const GITHUB_WORKFLOW = `name: Governance Check

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

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Charter CLI
        run: npm install -g @stackbilt/cli

      - name: Validate Commits
        run: charter validate --ci --format text

      - name: Drift Scan
        run: charter drift --ci --format text

      - name: Audit Report
        run: charter audit --format json > /tmp/audit.json
        if: always()
`;

interface SetupResult {
  configPath: string;
  initialized: boolean;
  detected: DetectionResult;
  selectedPreset: StackPreset;
  inferenceMode: 'auto' | 'preset-override' | 'fallback-conservative';
  workflow: {
    mode: 'none' | 'github';
    path?: string;
    created?: boolean;
  };
}

interface DetectionResult {
  runtime: string[];
  frameworks: string[];
  state: string[];
  signals: {
    hasFrontend: boolean;
    hasBackend: boolean;
    hasWorker: boolean;
    hasCloudflare: boolean;
    hasHono: boolean;
    hasReact: boolean;
    hasVite: boolean;
  };
  mixedStack: boolean;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  suggestedPreset: StackPreset;
}

export async function setupCommand(options: CLIOptions, args: string[]): Promise<number> {
  const ciMode = getFlag(args, '--ci');
  const presetFlag = getFlag(args, '--preset');
  const detectOnly = args.includes('--detect-only');

  if (ciMode && ciMode !== 'github') {
    throw new CLIError(`Unsupported CI target: ${ciMode}. Supported: github`);
  }

  if (presetFlag && !isValidPreset(presetFlag)) {
    throw new CLIError(`Invalid --preset value: ${presetFlag}. Use worker|frontend|backend|fullstack.`);
  }

  const detection = detectStack();
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
      console.log(`  Confidence: ${detection.confidence}`);
      console.log(`  Selected preset: ${selectedPreset} (${inferenceMode})`);
      if (detection.mixedStack) {
        console.log('  Mixed stack detected (frontend + backend/worker). Recommended preset: fullstack');
        console.log('  Example: charter setup --preset fullstack --ci github --yes');
      }
      console.log('');
    }
    return EXIT_CODE.SUCCESS;
  }

  const initResult = initializeCharter(options.configPath, options.yes || args.includes('--force'), {
    preset: selectedPreset,
    projectName: inferProjectName(),
    features: {
      cloudflare: detection.signals.hasCloudflare,
      hono: detection.signals.hasHono,
      react: detection.signals.hasReact,
      vite: detection.signals.hasVite,
    },
  });

  const result: SetupResult = {
    configPath: options.configPath,
    initialized: initResult.created,
    detected: detection,
    selectedPreset,
    inferenceMode,
    workflow: {
      mode: ciMode === 'github' ? 'github' : 'none',
    },
  };

  if (ciMode === 'github') {
    const workflowPath = path.join('.github', 'workflows', 'charter-governance.yml');
    const created = writeFileIfMissing(workflowPath, GITHUB_WORKFLOW, options.yes || args.includes('--force'));

    result.workflow = {
      mode: 'github',
      path: workflowPath,
      created,
    };
  }

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
    console.log('  Mixed stack detected (frontend + backend/worker).');
    console.log('  Recommendation: use --preset fullstack when frontend exists under client/ or apps/web.');
  }

  if (result.workflow.mode === 'github') {
    console.log(`  CI policy gate: ${result.workflow.created ? 'enabled' : 'already present'} (${result.workflow.path})`);
  }

  console.log('');
  console.log('  What this gives you immediately:');
  console.log('    - Merge-time checks for risky changes without governance links');
  console.log('    - Drift detection against your blessed stack');
  console.log('    - Audit-ready governance evidence from repo history');
  console.log('');
  console.log('  Run now:');
  console.log('    1. charter validate --format text');
  console.log('    2. charter drift --format text');
  console.log('    3. charter audit --format text');

  return EXIT_CODE.SUCCESS;
}

function detectStack(): DetectionResult {
  const pkg = loadPackageJson();
  if (!pkg) {
    return {
      runtime: [],
      frameworks: [],
      state: [],
      signals: {
        hasFrontend: false,
        hasBackend: false,
        hasWorker: false,
        hasCloudflare: false,
        hasHono: false,
        hasReact: false,
        hasVite: false,
      },
      mixedStack: false,
      confidence: 'LOW',
      suggestedPreset: 'fullstack',
    };
  }

  const depNames = new Set<string>([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ]);

  const hasFrontendDep = hasAny(depNames, ['next', 'react', 'vite', 'vue', '@angular/core', 'svelte']);
  const hasFrontendPathSignals = hasAnyPath(['client', 'frontend', 'apps/web', 'web']);
  const hasFrontend = hasFrontendDep || hasFrontendPathSignals;
  const hasBackend = hasAny(depNames, ['express', 'fastify', 'nestjs', '@nestjs/core', 'koa', 'hono']);
  const hasWorker = hasAny(depNames, ['wrangler', '@cloudflare/workers-types']);

  const hasCloudflare = hasAny(depNames, ['wrangler', '@cloudflare/workers-types']);
  const hasHono = hasAny(depNames, ['hono']);
  const hasReact = hasAny(depNames, ['react']);
  const hasVite = hasAny(depNames, ['vite']);

  const mixedStack = hasFrontend && (hasBackend || hasWorker);

  const frameworks: string[] = [];
  const runtime: string[] = [];
  const state: string[] = [];

  if (hasFrontendDep) {
    frameworks.push(...pick(depNames, ['next', 'react', 'vite', 'vue', '@angular/core', 'svelte']));
  }
  if (hasBackend) {
    frameworks.push(...pick(depNames, ['express', 'fastify', 'nestjs', '@nestjs/core', 'koa', 'hono']));
  }
  if (hasWorker) {
    runtime.push('edge-worker');
  }
  if (pkg.engines?.node || hasAny(depNames, ['typescript', 'ts-node', 'express', 'fastify', 'next'])) {
    runtime.push('node');
  }
  if (hasAny(depNames, ['zustand', 'redux', '@reduxjs/toolkit', 'mobx', 'xstate'])) {
    state.push(...pick(depNames, ['zustand', 'redux', '@reduxjs/toolkit', 'mobx', 'xstate']));
  }

  const signals = {
    hasFrontend,
    hasBackend,
    hasWorker,
    hasCloudflare,
    hasHono,
    hasReact,
    hasVite,
  };

  if (mixedStack) {
    return { runtime, frameworks, state, signals, mixedStack: true, confidence: 'HIGH', suggestedPreset: 'fullstack' };
  }
  if (hasWorker && !hasFrontend && !hasBackend) {
    return { runtime, frameworks, state, signals, mixedStack: false, confidence: 'HIGH', suggestedPreset: 'worker' };
  }
  if (hasFrontend) {
    return { runtime, frameworks, state, signals, mixedStack: false, confidence: 'HIGH', suggestedPreset: 'frontend' };
  }
  if (hasBackend) {
    return { runtime, frameworks, state, signals, mixedStack: false, confidence: 'HIGH', suggestedPreset: 'backend' };
  }
  if (runtime.length > 0 || state.length > 0) {
    return { runtime, frameworks, state, signals, mixedStack: false, confidence: 'MEDIUM', suggestedPreset: 'fullstack' };
  }
  return { runtime, frameworks, state, signals, mixedStack: false, confidence: 'LOW', suggestedPreset: 'fullstack' };
}

function loadPackageJson(): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  name?: string;
} | null {
  const packageJsonPath = path.resolve('package.json');
  if (!fs.existsSync(packageJsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  } catch {
    return null;
  }
}

function inferProjectName(): string {
  const pkg = loadPackageJson();
  if (pkg?.name && pkg.name.trim().length > 0) {
    return pkg.name.trim();
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

function writeFileIfMissing(targetPath: string, content: string, force: boolean): boolean {
  const absolute = path.resolve(targetPath);
  const exists = fs.existsSync(absolute);

  if (exists && !force) {
    return false;
  }

  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return true;
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

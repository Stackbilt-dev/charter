/**
 * charter bootstrap
 *
 * One-command repo onboarding: detect + setup + ADF init + install + doctor.
 * Replaces the multi-step manual process with a single orchestrated flow.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { isGitRepo } from '../git-helpers';
import { POINTER_MARKERS } from './adf';
import { initializeCharter, type StackPreset } from './init';
import {
  detectStack,
  loadPackageContexts,
  detectPackageManager,
  inferProjectName,
  getGithubWorkflow,
  applyManagedFile,
  syncPackageManifest,
} from './setup';
import {
  MANIFEST_SCAFFOLD,
  MANIFEST_DOCS_SCAFFOLD,
  MANIFEST_FRONTEND_SCAFFOLD,
  MANIFEST_BACKEND_SCAFFOLD,
  CORE_SCAFFOLD,
  STATE_SCAFFOLD,
  FRONTEND_SCAFFOLD,
  BACKEND_SCAFFOLD,
  DECISIONS_SCAFFOLD,
  PLANNING_SCAFFOLD,
  CONTENT_SCAFFOLD,
  POINTER_CLAUDE_MD_HYBRID,
  POINTER_CURSORRULES,
  POINTER_AGENTS_MD,
  POINTER_GEMINI_MD,
  POINTER_COPILOT_MD,
  manifestForPreset,
} from './adf';
import { loadPatterns } from '../config';
import { parseAdf, parseManifest } from '@stackbilt/adf';
import { migrateSource, updateModuleIndex } from './adf-migrate';
import type { SourceMigrationResult } from './adf-migrate';

// ============================================================================
// Types
// ============================================================================

type StepName = 'detect' | 'setup' | 'adf-init' | 'migrate' | 'install' | 'populate' | 'doctor';
type StepStatus = 'pass' | 'fail' | 'skip';

interface StepResult {
  name: StepName;
  status: StepStatus;
  details: Record<string, unknown>;
  warnings: string[];
}

interface BootstrapResult {
  status: 'success' | 'partial' | 'failure';
  steps: StepResult[];
  nextSteps: Array<{ cmd: string; required: boolean; reason: string }>;
}

// ============================================================================
// Command Entry
// ============================================================================

export async function bootstrapCommand(options: CLIOptions, args: string[]): Promise<number> {
  const ciTarget = getFlag(args, '--ci');
  const presetFlag = getFlag(args, '--preset');
  const skipInstall = args.includes('--skip-install');
  const skipDoctor = args.includes('--skip-doctor');
  const force = args.includes('--force');
  const nonInteractive = options.yes;
  const setupOverwrite = options.yes || force;

  if (ciTarget && ciTarget !== 'github') {
    throw new CLIError(`Unsupported CI target: ${ciTarget}. Supported: github`);
  }

  if (presetFlag && !isValidPreset(presetFlag)) {
    throw new CLIError(`Invalid --preset value: ${presetFlag}. Use worker|frontend|backend|fullstack|docs.`);
  }

  const result: BootstrapResult = {
    status: 'success',
    steps: [],
    nextSteps: [],
  };

  let warnings = 0;

  // ========================================================================
  // Phase 1: Detect
  // ========================================================================
  const detectResult = runDetectPhase(options, presetFlag);
  result.steps.push(detectResult.step);
  warnings += detectResult.step.warnings.length;

  const selectedPreset: StackPreset = detectResult.selectedPreset;
  const detection = detectResult.detection;
  const contexts = detectResult.contexts;
  const packageManager = detectResult.packageManager;

  if (options.format === 'text') {
    console.log('[1/7] Detecting stack...');
    console.log(`  Stack: ${selectedPreset} (${detection.confidence} confidence)`);
    console.log(`  Monorepo: ${detection.monorepo ? 'yes' : 'no'}${detection.monorepo && detection.signals.hasPnpm ? ' (pnpm workspace)' : ''}`);
    if (detection.warnings.length > 0) {
      for (const w of detection.warnings) {
        console.log(`  Warning: ${w}`);
      }
    }
    console.log('');
  }

  // ========================================================================
  // Phase 2: Setup
  // ========================================================================
  const setupResult = runSetupPhase(options, selectedPreset, detection, contexts, ciTarget, packageManager, setupOverwrite);
  result.steps.push(setupResult.step);
  warnings += setupResult.step.warnings.length;

  if (options.format === 'text') {
    console.log('[2/7] Setting up governance...');
    for (const f of (setupResult.step.details.created as string[] || [])) {
      console.log(`  Created ${f}`);
    }
    for (const f of (setupResult.step.details.updated as string[] || [])) {
      console.log(`  Updated ${f}`);
    }
    console.log('');
  }

  // ========================================================================
  // Phase 3: ADF Init
  // ========================================================================
  const adfResult = runAdfInitPhase(options, force, selectedPreset);
  result.steps.push(adfResult.step);
  warnings += adfResult.step.warnings.length;

  if (options.format === 'text') {
    console.log('[3/7] Initializing ADF context...');
    for (const f of (adfResult.step.details.files as string[] || [])) {
      console.log(`  Created ${f}`);
    }
    for (const f of (adfResult.step.details.pointers as string[] || [])) {
      console.log(`  Generated ${f}`);
    }
    const backedUp = adfResult.step.details.backedUp as number | undefined;
    if (backedUp && backedUp > 0) {
      console.log(`  Backed up ${backedUp} files to .ai/.backup/`);
    }
    for (const warning of adfResult.step.warnings) {
      console.log(`  Warning: ${warning}`);
    }
    console.log('');
  }

  // Orphan registration: auto-register in --yes mode, prompt interactively otherwise
  const orphans = adfResult.step.details.orphans as string[] || [];
  if (orphans.length > 0) {
    let shouldRegister = false;
    if (nonInteractive) {
      shouldRegister = true;
    } else if (options.format === 'text') {
      shouldRegister = await promptYesNo('  Register these modules now? (y/N) ');
    }
    if (shouldRegister) {
      registerOrphansInManifest(path.join('.ai', 'manifest.adf'), orphans);
      updateModuleIndex('CLAUDE.md', '.ai');
      if (options.format === 'text') {
        console.log(`  Registered ${orphans.length} module(s) as ON_DEMAND in manifest.adf`);
        console.log('');
      }
    }
  }

  // ========================================================================
  // Phase 4: Migrate Agent Configs
  // ========================================================================
  const migrateResult = runMigratePhase(options, nonInteractive);
  result.steps.push(migrateResult.step);
  warnings += migrateResult.step.warnings.length;

  if (options.format === 'text') {
    console.log('[4/7] Migrating agent configs...');
    if (migrateResult.step.status === 'skip') {
      console.log('  Skipped (no migratable files)');
    } else if (migrateResult.step.details.dryRun) {
      for (const w of migrateResult.step.warnings) {
        console.log(`  ${w}`);
      }
    } else {
      const migrated = migrateResult.step.details.migrated as number;
      console.log(`  Migrated ${migrated} file(s)`);
    }
    console.log('');
  }

  // ========================================================================
  // Phase 5: Install
  // ========================================================================
  const installResult = runInstallPhase(options, skipInstall);
  result.steps.push(installResult.step);
  warnings += installResult.step.warnings.length;

  if (options.format === 'text') {
    console.log('[5/7] Installing dependencies...');
    if (skipInstall) {
      console.log('  Skipped (--skip-install)');
    } else {
      console.log(`  Detected: ${installResult.step.details.packageManager}`);
      console.log(`  Running: ${installResult.step.details.command}`);
      if (installResult.step.status === 'pass') {
        console.log('  Done');
      } else {
        console.log(`  Failed: ${installResult.step.details.error}`);
        for (const w of installResult.step.warnings) {
          if (w.startsWith('Hint:') || w.startsWith('Retry')) {
            console.log(`  ${w}`);
          }
        }
        console.log('  (non-fatal)');
      }
    }
    console.log('');
  }

  // ========================================================================
  // Phase 6: Populate (#89)
  // ========================================================================
  const populateResult = await runPopulatePhase(options);
  result.steps.push(populateResult.step);
  warnings += populateResult.step.warnings.length;

  if (options.format === 'text') {
    console.log('[6/7] Auto-populating ADF modules...');
    const populated = populateResult.step.details.populated as number;
    const skipped = populateResult.step.details.skipped as number;
    if (populated > 0) {
      console.log(`  Populated ${populated} module(s), skipped ${skipped} (already customized)`);
    } else {
      console.log('  No scaffold content to replace');
    }
    console.log('');
  }

  // ========================================================================
  // Phase 7: Doctor
  // ========================================================================
  const doctorResult = runDoctorPhase(options, skipDoctor);
  result.steps.push(doctorResult.step);
  warnings += doctorResult.step.warnings.length;

  if (options.format === 'text') {
    console.log('[7/7] Running health check...');
    if (skipDoctor) {
      console.log('  Skipped (--skip-doctor)');
    } else {
      const checks = doctorResult.step.details.checks as Array<{ name: string; status: string; details: string }> || [];
      for (const check of checks) {
        const icon = check.status === 'PASS' ? '[ok]' : '[warn]';
        console.log(`  ${icon} ${check.name}`);
      }
    }
    console.log('');
  }

  // ========================================================================
  // Summary
  // ========================================================================
  const failCount = result.steps.filter(s => s.status === 'fail').length;
  result.status = failCount === 0 ? 'success' : failCount < result.steps.length ? 'partial' : 'failure';

  // Build next steps
  result.nextSteps.push({
    cmd: 'charter serve  # start MCP server for Claude Code / Cursor integration',
    required: false,
    reason: 'Enable real-time governance via MCP (add to .claude/settings.json)',
  });
  result.nextSteps.push({
    cmd: 'Review .charter/patterns/ and customize for your stack',
    required: false,
    reason: 'Customize blessed stack patterns',
  });
  result.nextSteps.push({
    cmd: 'git add .charter .ai CLAUDE.md .cursorrules agents.md && git commit -m "chore: bootstrap charter governance"',
    required: false,
    reason: 'Commit governance baseline',
  });

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Bootstrap complete. ${warnings} warning${warnings === 1 ? '' : 's'}.`);
    console.log('');
    console.log('Next steps:');
    result.nextSteps.forEach((step, i) => {
      console.log(`  ${i + 1}. ${step.cmd}`);
    });
  }

  return EXIT_CODE.SUCCESS;
}

// ============================================================================
// Phase 1: Detect
// ============================================================================

function runDetectPhase(
  _options: CLIOptions,
  presetFlag: string | undefined
): {
  step: StepResult;
  selectedPreset: StackPreset;
  detection: ReturnType<typeof detectStack>;
  contexts: ReturnType<typeof loadPackageContexts>;
  packageManager: 'npm' | 'pnpm';
} {
  const warnings: string[] = [];
  try {
    const contexts = loadPackageContexts();
    const detection = detectStack(contexts);
    const packageManager = detectPackageManager(contexts);
    const selectedPreset: StackPreset = isValidPreset(presetFlag) ? presetFlag : detection.suggestedPreset;

    warnings.push(...detection.warnings);

    return {
      step: {
        name: 'detect',
        status: 'pass',
        details: {
          stack: selectedPreset,
          confidence: detection.confidence,
          monorepo: detection.monorepo,
          runtime: detection.runtime,
          frameworks: detection.frameworks,
        },
        warnings,
      },
      selectedPreset,
      detection,
      contexts,
      packageManager,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Detection failed: ${msg}`);
    const emptyContexts = loadPackageContextsSafe();
    return {
      step: {
        name: 'detect',
        status: 'fail',
        details: { error: msg },
        warnings,
      },
      selectedPreset: isValidPreset(presetFlag) ? presetFlag : 'fullstack',
      detection: {
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
        confidence: 'LOW' as const,
        suggestedPreset: 'fullstack' as StackPreset,
        warnings: [],
      },
      contexts: emptyContexts,
      packageManager: 'npm',
    };
  }
}

function loadPackageContextsSafe(): ReturnType<typeof loadPackageContexts> {
  try {
    return loadPackageContexts();
  } catch {
    return [];
  }
}

// ============================================================================
// Phase 2: Setup
// ============================================================================

function runSetupPhase(
  options: CLIOptions,
  selectedPreset: StackPreset,
  detection: ReturnType<typeof detectStack>,
  contexts: ReturnType<typeof loadPackageContexts>,
  ciTarget: string | undefined,
  packageManager: 'npm' | 'pnpm',
  force: boolean
): { step: StepResult } {
  const warnings: string[] = [];
  const created: string[] = [];
  const updated: string[] = [];

  try {
    // Initialize .charter/ directory
    const initResult = initializeCharter(options.configPath, force, {
      preset: selectedPreset,
      projectName: inferProjectName(contexts),
      features: {
        cloudflare: detection.signals.hasCloudflare,
        hono: detection.signals.hasHono,
        react: detection.signals.hasReact,
        vite: detection.signals.hasVite,
      },
    });

    if (initResult.created) {
      for (const f of initResult.files) {
        created.push(path.join(options.configPath, f));
      }
    }

    // Generate CI workflow if requested
    if (ciTarget === 'github') {
      const workflowPath = path.join('.github', 'workflows', 'charter-governance.yml');
      const workflowWrite = applyManagedFile(
        workflowPath,
        getGithubWorkflow(packageManager),
        true
      );
      if (workflowWrite.created) {
        created.push(workflowPath);
      } else if (workflowWrite.updated) {
        updated.push(workflowPath);
      }
    }

    // Sync package.json scripts + devDependency
    const manifestApplied = syncPackageManifest(selectedPreset, true, true);
    if (manifestApplied.legacy.scripts.updated) {
      updated.push('package.json (scripts)');
    }
    if (manifestApplied.legacy.dependencies.updated) {
      updated.push('package.json (devDependencies)');
    }

    return {
      step: {
        name: 'setup',
        status: 'pass',
        details: { created, updated },
        warnings,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Setup failed: ${msg}`);
    return {
      step: {
        name: 'setup',
        status: 'fail',
        details: { created, updated, error: msg },
        warnings,
      },
    };
  }
}

// ============================================================================
// Phase 3: ADF Init
// ============================================================================

function getAdfScaffolds(preset?: StackPreset): Array<{ name: string; content: string }> {
  const scaffolds = [
    { name: 'manifest.adf', content: manifestForPreset(preset) },
    { name: 'core.adf', content: CORE_SCAFFOLD },
    { name: 'state.adf', content: STATE_SCAFFOLD },
  ];

  if (preset === 'docs') {
    scaffolds.push(
      { name: 'content.adf', content: CONTENT_SCAFFOLD },
      { name: 'decisions.adf', content: DECISIONS_SCAFFOLD },
      { name: 'planning.adf', content: PLANNING_SCAFFOLD },
    );
  } else if (preset === 'frontend') {
    scaffolds.push({ name: 'frontend.adf', content: FRONTEND_SCAFFOLD });
  } else if (preset === 'backend' || preset === 'worker') {
    scaffolds.push({ name: 'backend.adf', content: BACKEND_SCAFFOLD });
  } else {
    scaffolds.push(
      { name: 'frontend.adf', content: FRONTEND_SCAFFOLD },
      { name: 'backend.adf', content: BACKEND_SCAFFOLD },
    );
  }

  return scaffolds;
}

function buildAdfLockContent(aiDir: string): string {
  const lockData: Record<string, string> = {};
  for (const mod of ['core.adf', 'state.adf']) {
    const modPath = path.join(aiDir, mod);
    if (!fs.existsSync(modPath)) continue;
    lockData[mod] = hashContent(fs.readFileSync(modPath, 'utf-8'));
  }
  return JSON.stringify(lockData, null, 2) + '\n';
}

function writeAdfScaffolds(
  aiDir: string,
  force: boolean,
  preset?: StackPreset,
): { files: string[]; warnings: string[]; backedUp: number } {
  fs.mkdirSync(aiDir, { recursive: true });

  const files: string[] = [];
  const warnings: string[] = [];
  let backedUp = 0;
  let backupDir: string | undefined;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (const scaffold of getAdfScaffolds(preset)) {
    const targetPath = path.join(aiDir, scaffold.name);
    const label = `.ai/${scaffold.name}`;

    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, scaffold.content);
      files.push(label);
      continue;
    }

    const existing = fs.readFileSync(targetPath, 'utf-8');
    if (existing.trim() === scaffold.content.trim()) {
      continue;
    }

    const byteCount = Buffer.byteLength(existing, 'utf-8');

    if (!force) {
      warnings.push(`${label} has custom content (${byteCount} bytes); skipping scaffold overwrite`);
      continue;
    }

    backupDir ||= path.join(aiDir, '.backup');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupName = `${scaffold.name}.${timestamp}`;
    fs.copyFileSync(targetPath, path.join(backupDir, backupName));
    warnings.push(`Backed up ${label} (${byteCount} bytes) → .ai/.backup/${backupName}`);
    backedUp++;

    fs.writeFileSync(targetPath, scaffold.content);
    files.push(label);
  }

  const lockPath = path.join(aiDir, '.adf.lock');
  const lockContent = buildAdfLockContent(aiDir);
  if (!fs.existsSync(lockPath) || fs.readFileSync(lockPath, 'utf-8') !== lockContent) {
    fs.writeFileSync(lockPath, lockContent);
    files.push('.ai/.adf.lock');
  }

  return { files, warnings, backedUp };
}

function runAdfInitPhase(
  options: CLIOptions,
  force: boolean,
  preset?: StackPreset,
): { step: StepResult } {
  const warnings: string[] = [];
  const files: string[] = [];
  const pointers: string[] = [];
  const detectedOrphans: string[] = [];

  try {
    const aiDir = '.ai';
    const scaffoldResult = writeAdfScaffolds(aiDir, force, preset);
    files.push(...scaffoldResult.files);
    warnings.push(...scaffoldResult.warnings);

    // Detect orphaned ADF modules not registered in manifest (#65)
    const manifestPath2 = path.join(aiDir, 'manifest.adf');
    if (fs.existsSync(manifestPath2)) {
      try {
        const manifestContent = fs.readFileSync(manifestPath2, 'utf-8');
        const allAdfFiles = fs.readdirSync(aiDir).filter(f => f.endsWith('.adf') && f !== 'manifest.adf');
        const doc = parseAdf(manifestContent);
        const manifest = parseManifest(doc);
        const registeredModules = new Set<string>([
          ...manifest.defaultLoad,
          ...manifest.onDemand.map(m => m.path),
        ]);
        const orphans = allAdfFiles.filter(f => !registeredModules.has(f));
        if (orphans.length > 0) {
          detectedOrphans.push(...orphans);
          warnings.push(`Found ${orphans.length} unregistered .adf module(s): ${orphans.join(', ')}`);
          warnings.push('Run `charter adf register` to add them to the manifest.');
        }
      } catch {
        // Non-critical — manifest parse failure shouldn't block bootstrap
      }
    }

    // Generate pointer files (CLAUDE.md uses hybrid template with module index)
    const pointerFiles: Array<{ name: string; content: string; label: string }> = [
      { name: 'CLAUDE.md', content: POINTER_CLAUDE_MD_HYBRID, label: 'CLAUDE.md (hybrid pointer)' },
      { name: '.cursorrules', content: POINTER_CURSORRULES, label: '.cursorrules (thin pointer)' },
      { name: 'agents.md', content: POINTER_AGENTS_MD, label: 'agents.md (thin pointer)' },
      { name: 'GEMINI.md', content: POINTER_GEMINI_MD, label: 'GEMINI.md (thin pointer)' },
      { name: 'copilot-instructions.md', content: POINTER_COPILOT_MD, label: 'copilot-instructions.md (thin pointer)' },
    ];

    for (const pf of pointerFiles) {
      const pointerPath = path.resolve(pf.name);
      const exists = fs.existsSync(pointerPath);
      if (!exists) {
        fs.writeFileSync(pointerPath, pf.content);
        pointers.push(pf.label);
      } else if (force) {
        fs.writeFileSync(pointerPath, pf.content);
        pointers.push(pf.label);
      } else if (!isAlreadyThinPointer(pointerPath)) {
        // File has custom content — don't overwrite, suggest migrate
        warnings.push(`${pf.name} has custom content; skipping pointer (run 'charter adf migrate' first or use --force to overwrite)`);
      } else {
        warnings.push(`${pf.name} already exists; skipping (use --force to overwrite)`);
      }
    }

    // Populate module index in CLAUDE.md from manifest
    updateModuleIndex('CLAUDE.md', aiDir);

    return {
      step: {
        name: 'adf-init',
        status: 'pass',
        details: { files, pointers, backedUp: scaffoldResult.backedUp, orphans: detectedOrphans },
        warnings,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`ADF init failed: ${msg}`);
    return {
      step: {
        name: 'adf-init',
        status: 'fail',
        details: { files, pointers, orphans: detectedOrphans, error: msg },
        warnings,
      },
    };
  }
}

// ============================================================================
// Phase 4: Migrate Agent Configs
// ============================================================================

const AGENT_CONFIG_FILES = [
  'CLAUDE.md', '.cursorrules', 'agents.md',
  'GEMINI.md', 'copilot-instructions.md',
];

function runMigratePhase(
  options: CLIOptions,
  force: boolean,
): { step: StepResult } {
  const warnings: string[] = [];
  const aiDir = '.ai';

  try {
    // Find agent config files that aren't already thin pointers
    const sources = AGENT_CONFIG_FILES.filter(f => {
      const fullPath = path.resolve(f);
      if (!fs.existsSync(fullPath)) return false;
      const content = fs.readFileSync(fullPath, 'utf-8');
      return !POINTER_MARKERS.some(marker => content.includes(marker));
    });

    if (sources.length === 0) {
      return {
        step: {
          name: 'migrate',
          status: 'skip',
          details: { skipped: true, reason: 'No migratable agent config files found' },
          warnings,
        },
      };
    }

    if (!force) {
      warnings.push(`Found ${sources.length} agent config file(s) with migratable content: ${sources.join(', ')}`);
      warnings.push("Run with --yes to auto-migrate, or run 'charter adf migrate' separately");
      return {
        step: {
          name: 'migrate',
          status: 'pass',
          details: { dryRun: true, sources, migrated: 0 },
          warnings,
        },
      };
    }

    // Auto-migrate with --yes
    const results: SourceMigrationResult[] = [];
    for (const source of sources) {
      const result = migrateSource(source, aiDir, 'dedupe', false, false, false, options);
      results.push(result);
    }

    const migrated = results.filter(r => !r.skipped).length;
    return {
      step: {
        name: 'migrate',
        status: 'pass',
        details: {
          sources,
          migrated,
          results: results.map(r => ({
            source: r.source,
            skipped: r.skipped,
            itemsMigrated: r.plan?.migrateItems.length ?? 0,
          })),
        },
        warnings,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Migration failed: ${msg}`);
    return {
      step: {
        name: 'migrate',
        status: 'fail',
        details: { error: msg },
        warnings,
      },
    };
  }
}

// ============================================================================
// Phase 5: Install
// ============================================================================

function runInstallPhase(
  _options: CLIOptions,
  skipInstall: boolean
): { step: StepResult } {
  const warnings: string[] = [];

  if (skipInstall) {
    return {
      step: {
        name: 'install',
        status: 'skip',
        details: { skipped: true, reason: '--skip-install' },
        warnings,
      },
    };
  }

  // Detect package manager from lockfiles
  const pm = detectPackageManagerFromLockfiles();
  const command = `${pm} install`;

  try {
    execSync(command, {
      stdio: 'pipe',
      env: { ...process.env, CI: 'true' },
      timeout: 120_000,
    });

    return {
      step: {
        name: 'install',
        status: 'pass',
        details: { packageManager: pm, command },
        warnings,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isPermError = msg.includes('EPERM') || msg.includes('EACCES') || msg.includes('permission denied');
    warnings.push(`Install failed: ${msg}`);
    if (isPermError) {
      warnings.push(`Hint: permission error detected. Retry outside the sandbox or with elevated privileges: ${command}`);
    }
    warnings.push(`Retry manually: ${command}`);
    return {
      step: {
        name: 'install',
        status: 'fail',
        details: { packageManager: pm, command, error: msg },
        warnings,
      },
    };
  }
}

function detectPackageManagerFromLockfiles(): 'pnpm' | 'npm' | 'yarn' {
  if (fs.existsSync(path.resolve('pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.resolve('yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.resolve('package-lock.json'))) return 'npm';
  return 'npm';
}

// ============================================================================
// Phase 6: Populate (#89)
// ============================================================================

async function runPopulatePhase(
  options: CLIOptions,
): Promise<{ step: StepResult }> {
  const warnings: string[] = [];
  const aiDir = '.ai';

  if (!fs.existsSync(path.join(aiDir, 'manifest.adf'))) {
    return {
      step: {
        name: 'populate',
        status: 'skip',
        details: { populated: 0, skipped: 0, reason: 'no manifest.adf' },
        warnings,
      },
    };
  }

  try {
    const { adfPopulateCommand } = require('./adf-populate');
    const code = await adfPopulateCommand(options, ['--force']);

    return {
      step: {
        name: 'populate',
        status: code === 0 ? 'pass' : 'fail',
        details: { populated: code === 0 ? 1 : 0, skipped: 0 },
        warnings,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Populate failed (non-fatal): ${msg}`);
    return {
      step: {
        name: 'populate',
        status: 'pass', // non-fatal — bootstrap shouldn't fail on populate
        details: { populated: 0, skipped: 0, error: msg },
        warnings,
      },
    };
  }
}

// ============================================================================
// Phase 7: Doctor
// ============================================================================

function runDoctorPhase(
  options: CLIOptions,
  skipDoctor: boolean
): { step: StepResult } {
  const warnings: string[] = [];

  if (skipDoctor) {
    return {
      step: {
        name: 'doctor',
        status: 'skip',
        details: { skipped: true, reason: '--skip-doctor' },
        warnings,
      },
    };
  }

  const checks: Array<{ name: string; status: 'PASS' | 'WARN'; details: string }> = [];

  try {
    // Git repository check
    const inGitRepo = isGitRepo();
    checks.push({
      name: 'Git repository',
      status: inGitRepo ? 'PASS' : 'WARN',
      details: inGitRepo ? 'Repository detected.' : 'Not inside a git repository.',
    });

    // config.json check
    const configFile = path.join(options.configPath, 'config.json');
    const hasConfig = fs.existsSync(configFile);
    checks.push({
      name: 'config.json',
      status: hasConfig ? 'PASS' : 'WARN',
      details: hasConfig ? `${configFile} exists.` : `${configFile} not found.`,
    });

    // Patterns check
    const patterns = loadPatterns(options.configPath);
    checks.push({
      name: 'Patterns loaded',
      status: patterns.length > 0 ? 'PASS' : 'WARN',
      details: patterns.length > 0
        ? `${patterns.length} pattern(s) loaded.`
        : 'No patterns found.',
    });

    // ADF manifest check
    const manifestPath = path.join('.ai', 'manifest.adf');
    const hasManifest = fs.existsSync(manifestPath);
    checks.push({
      name: 'ADF manifest',
      status: hasManifest ? 'PASS' : 'WARN',
      details: hasManifest ? `${manifestPath} exists.` : `${manifestPath} not found.`,
    });

    // ADF sync lock check
    if (hasManifest) {
      try {
        const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
        const manifestDoc = parseAdf(manifestContent);
        const manifest = parseManifest(manifestDoc);

        if (manifest.sync.length > 0) {
          const lockFile = path.join('.ai', '.adf.lock');
          const hasLock = fs.existsSync(lockFile);
          checks.push({
            name: 'ADF sync lock',
            status: hasLock ? 'PASS' : 'WARN',
            details: hasLock ? `${lockFile} exists.` : `${lockFile} not found.`,
          });
        }
      } catch {
        // Manifest parse failed — just check for lock file presence
        const lockFile = path.join('.ai', '.adf.lock');
        const hasLock = fs.existsSync(lockFile);
        checks.push({
          name: 'ADF sync lock',
          status: hasLock ? 'PASS' : 'WARN',
          details: hasLock ? `${lockFile} exists.` : `${lockFile} not found.`,
        });
      }
    }

    const hasWarn = checks.some(c => c.status === 'WARN');
    if (hasWarn) {
      warnings.push('Some health checks returned warnings.');
    }

    return {
      step: {
        name: 'doctor',
        status: hasWarn ? 'fail' : 'pass',
        details: { checks },
        warnings,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Doctor failed: ${msg}`);
    return {
      step: {
        name: 'doctor',
        status: 'fail',
        details: { checks, error: msg },
        warnings,
      },
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isValidPreset(value: string | undefined): value is StackPreset {
  return value === 'worker' || value === 'frontend' || value === 'backend' || value === 'fullstack' || value === 'docs';
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Check if a file is already a thin ADF pointer.
 */
function isAlreadyThinPointer(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return POINTER_MARKERS.some(marker => content.includes(marker));
  } catch {
    return false;
  }
}

/**
 * Prompt user for a yes/no answer via readline.
 */
function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/**
 * Append orphaned modules to the ON_DEMAND section of manifest.adf.
 */
function registerOrphansInManifest(manifestPath: string, orphans: string[]): void {
  const content = fs.readFileSync(manifestPath, 'utf-8');
  const lines = content.split('\n');

  // Find ON_DEMAND section
  const onDemandIdx = lines.findIndex(l => l.includes('ON_DEMAND:'));

  if (onDemandIdx === -1) {
    // No ON_DEMAND section — append one
    const newEntries = orphans.map(name => {
      const stem = name.replace('.adf', '');
      return `  - ${name} (Triggers on: ${stem})`;
    });
    fs.writeFileSync(
      manifestPath,
      content.trimEnd() + '\n\n📂 ON_DEMAND:\n' + newEntries.join('\n') + '\n',
    );
    return;
  }

  // Find end of ON_DEMAND entries
  let insertIdx = onDemandIdx + 1;
  while (insertIdx < lines.length && lines[insertIdx].match(/^\s+-\s/)) {
    insertIdx++;
  }

  const newEntries = orphans.map(name => {
    const stem = name.replace('.adf', '');
    return `  - ${name} (Triggers on: ${stem})`;
  });
  lines.splice(insertIdx, 0, ...newEntries);
  fs.writeFileSync(manifestPath, lines.join('\n'));
}

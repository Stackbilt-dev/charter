/**
 * charter bootstrap
 *
 * One-command repo onboarding: detect + setup + ADF init + install + doctor.
 * Replaces the multi-step manual process with a single orchestrated flow.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
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
  CORE_SCAFFOLD,
  STATE_SCAFFOLD,
  POINTER_CLAUDE_MD,
  POINTER_CURSORRULES,
  POINTER_AGENTS_MD,
} from './adf';
import { loadPatterns } from '../config';
import { parseAdf, parseManifest } from '@stackbilt/adf';

// ============================================================================
// Types
// ============================================================================

type StepName = 'detect' | 'setup' | 'adf-init' | 'install' | 'doctor';
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
  const force = options.yes;

  if (ciTarget && ciTarget !== 'github') {
    throw new CLIError(`Unsupported CI target: ${ciTarget}. Supported: github`);
  }

  if (presetFlag && !isValidPreset(presetFlag)) {
    throw new CLIError(`Invalid --preset value: ${presetFlag}. Use worker|frontend|backend|fullstack.`);
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
  if (detectResult.step.status === 'fail') warnings++;

  const selectedPreset: StackPreset = detectResult.selectedPreset;
  const detection = detectResult.detection;
  const contexts = detectResult.contexts;
  const packageManager = detectResult.packageManager;

  if (options.format === 'text') {
    console.log('[1/5] Detecting stack...');
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
  const setupResult = runSetupPhase(options, selectedPreset, detection, contexts, ciTarget, packageManager, force);
  result.steps.push(setupResult.step);
  if (setupResult.step.status === 'fail') warnings++;

  if (options.format === 'text') {
    console.log('[2/5] Setting up governance...');
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
  const adfResult = runAdfInitPhase(options, force);
  result.steps.push(adfResult.step);
  if (adfResult.step.status === 'fail') warnings++;

  if (options.format === 'text') {
    console.log('[3/5] Initializing ADF context...');
    for (const f of (adfResult.step.details.files as string[] || [])) {
      console.log(`  Created ${f}`);
    }
    for (const f of (adfResult.step.details.pointers as string[] || [])) {
      console.log(`  Generated ${f}`);
    }
    console.log('');
  }

  // ========================================================================
  // Phase 4: Install
  // ========================================================================
  const installResult = runInstallPhase(options, skipInstall);
  result.steps.push(installResult.step);
  if (installResult.step.status === 'fail') warnings++;

  if (options.format === 'text') {
    console.log('[4/5] Installing dependencies...');
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
  // Phase 5: Doctor
  // ========================================================================
  const doctorResult = runDoctorPhase(options, skipDoctor);
  result.steps.push(doctorResult.step);
  if (doctorResult.step.status === 'fail') warnings++;

  if (options.format === 'text') {
    console.log('[5/5] Running health check...');
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
    cmd: 'Review .charter/patterns/ and customize for your stack',
    required: false,
    reason: 'Customize blessed stack patterns',
  });
  result.nextSteps.push({
    cmd: 'Add project-specific rules to .ai/core.adf',
    required: false,
    reason: 'Add project-specific ADF rules',
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

function runAdfInitPhase(
  options: CLIOptions,
  force: boolean
): { step: StepResult } {
  const warnings: string[] = [];
  const files: string[] = [];
  const pointers: string[] = [];

  try {
    const aiDir = '.ai';
    const manifestPath = path.join(aiDir, 'manifest.adf');

    // Create .ai/ scaffolds
    const alreadyExists = fs.existsSync(manifestPath);
    const hasCustomContent = alreadyExists && hasCustomAdfContent(aiDir);
    if (!alreadyExists) {
      // Greenfield: write scaffolds
      fs.mkdirSync(aiDir, { recursive: true });
      fs.writeFileSync(path.join(aiDir, 'manifest.adf'), MANIFEST_SCAFFOLD);
      fs.writeFileSync(path.join(aiDir, 'core.adf'), CORE_SCAFFOLD);
      fs.writeFileSync(path.join(aiDir, 'state.adf'), STATE_SCAFFOLD);
      files.push('.ai/manifest.adf', '.ai/core.adf', '.ai/state.adf');

      // Write .adf.lock
      const lockData: Record<string, string> = {};
      for (const mod of ['core.adf', 'state.adf']) {
        const content = fs.readFileSync(path.join(aiDir, mod), 'utf-8');
        lockData[mod] = hashContent(content);
      }
      fs.writeFileSync(path.join(aiDir, '.adf.lock'), JSON.stringify(lockData, null, 2) + '\n');
      files.push('.ai/.adf.lock');
    } else if (hasCustomContent && !force) {
      // Custom ADF content exists — don't overwrite, suggest migrate
      warnings.push('.ai/ contains custom ADF content; skipping scaffold overwrite');
      warnings.push("Run 'charter adf migrate' to consolidate agent configs into ADF");
    } else if (force) {
      // Force overwrite
      fs.mkdirSync(aiDir, { recursive: true });
      fs.writeFileSync(path.join(aiDir, 'manifest.adf'), MANIFEST_SCAFFOLD);
      fs.writeFileSync(path.join(aiDir, 'core.adf'), CORE_SCAFFOLD);
      fs.writeFileSync(path.join(aiDir, 'state.adf'), STATE_SCAFFOLD);
      files.push('.ai/manifest.adf', '.ai/core.adf', '.ai/state.adf');

      const lockData: Record<string, string> = {};
      for (const mod of ['core.adf', 'state.adf']) {
        const content = fs.readFileSync(path.join(aiDir, mod), 'utf-8');
        lockData[mod] = hashContent(content);
      }
      fs.writeFileSync(path.join(aiDir, '.adf.lock'), JSON.stringify(lockData, null, 2) + '\n');
      files.push('.ai/.adf.lock');
    } else {
      warnings.push('.ai/ already exists; skipping scaffold (use --yes to overwrite)');
    }

    // Generate thin pointer files
    const pointerFiles: Array<{ name: string; content: string; label: string }> = [
      { name: 'CLAUDE.md', content: POINTER_CLAUDE_MD, label: 'CLAUDE.md (thin pointer)' },
      { name: '.cursorrules', content: POINTER_CURSORRULES, label: '.cursorrules (thin pointer)' },
      { name: 'agents.md', content: POINTER_AGENTS_MD, label: 'agents.md (thin pointer)' },
    ];

    for (const pf of pointerFiles) {
      const pointerPath = path.resolve(pf.name);
      const exists = fs.existsSync(pointerPath);
      if (!exists) {
        fs.writeFileSync(pointerPath, pf.content);
        pointers.push(pf.label);
      } else if (exists && !isAlreadyThinPointer(pointerPath)) {
        // File has custom content — don't overwrite, suggest migrate
        warnings.push(`${pf.name} has custom content; skipping pointer (use 'charter adf migrate' first)`);
      } else if (force) {
        fs.writeFileSync(pointerPath, pf.content);
        pointers.push(pf.label);
      } else {
        warnings.push(`${pf.name} already exists; skipping (use --yes to overwrite)`);
      }
    }

    return {
      step: {
        name: 'adf-init',
        status: 'pass',
        details: { files, pointers },
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
        details: { files, pointers, error: msg },
        warnings,
      },
    };
  }
}

// ============================================================================
// Phase 4: Install
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
// Phase 5: Doctor
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
  return value === 'worker' || value === 'frontend' || value === 'backend' || value === 'fullstack';
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Check if .ai/core.adf has content beyond the scaffold template.
 */
function hasCustomAdfContent(aiDir: string): boolean {
  const coreAdfPath = path.join(aiDir, 'core.adf');
  if (!fs.existsSync(coreAdfPath)) return false;
  try {
    const content = fs.readFileSync(coreAdfPath, 'utf-8');
    // Check if the file has been modified from default scaffold
    // A custom file will have different content than the CORE_SCAFFOLD
    return content.trim() !== CORE_SCAFFOLD.trim();
  } catch {
    return false;
  }
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

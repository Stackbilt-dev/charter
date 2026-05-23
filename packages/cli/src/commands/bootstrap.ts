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
import { parseAdf, parseManifest, formatAdf } from '@stackbilt/adf';
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
  const securitySensitive = args.includes('--security-sensitive');
  const nonInteractive = options.yes;
  const setupOverwrite = options.yes || force;
  const leanMode = getFlag(args, '--mode') === 'lean';

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

  // Check git repo status once — used for preflight warning and gating hook next-steps
  const inGitRepo = isGitRepo();
  if (!inGitRepo) {
    detectResult.step.warnings.push(
      "Not inside a git repository. Run 'git init && git add -A && git commit -m \"initial commit\"' before installing hooks. Continuing — governance files will be written but hooks cannot be installed yet."
    );
    warnings++;
  }

  if (options.format === 'text') {
    console.log(`[1/${leanMode ? '4' : '7'}] Detecting stack...`);
    console.log(`  Stack: ${selectedPreset} (${detection.confidence} confidence)`);
    console.log(`  Monorepo: ${detection.monorepo ? 'yes' : 'no'}${detection.monorepo && detection.signals.hasPnpm ? ' (pnpm workspace)' : ''}`);
    if (detection.warnings.length > 0) {
      for (const w of detection.warnings) {
        console.log(`  Warning: ${w}`);
      }
    }
    if (!inGitRepo) {
      console.log(`  Warning: Not inside a git repository.`);
      console.log(`  Run 'git init && git add -A && git commit -m "initial commit"' before installing hooks.`);
      console.log(`  Continuing — governance files will be written but hooks cannot be installed yet.`);
    }
    console.log('');
  }

  // ========================================================================
  // Phase 2: Setup
  // ========================================================================
  const setupResult = runSetupPhase(options, selectedPreset, detection, contexts, ciTarget, packageManager, setupOverwrite, securitySensitive);
  result.steps.push(setupResult.step);
  warnings += setupResult.step.warnings.length;

  if (options.format === 'text') {
    console.log(`[2/${leanMode ? '4' : '7'}] Setting up governance...`);
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
    console.log(`[3/${leanMode ? '4' : '7'}] Initializing ADF context...`);
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
      const manifestFilePath = path.join('.ai', 'manifest.adf');
      // Split orphans: core.adf and state.adf belong in DEFAULT_LOAD, everything else in ON_DEMAND
      const defaultLoadOrphans = orphans.filter(m => DEFAULT_LOAD_MODULES.has(m));
      const onDemandOrphans = orphans.filter(m => !DEFAULT_LOAD_MODULES.has(m));

      if (defaultLoadOrphans.length > 0) {
        registerModulesInDefaultLoad(manifestFilePath, defaultLoadOrphans);
        if (options.format === 'text') {
          console.log(`  Registered ${defaultLoadOrphans.length} module(s) as DEFAULT_LOAD in manifest.adf`);
        }
      }
      if (onDemandOrphans.length > 0) {
        registerOrphansInManifest(manifestFilePath, onDemandOrphans);
        if (options.format === 'text') {
          console.log(`  Registered ${onDemandOrphans.length} module(s) as ON_DEMAND in manifest.adf`);
        }
      }

      updateModuleIndex('CLAUDE.md', '.ai');
      if (options.format === 'text') {
        console.log('');
      }
    }
  }

  // Post-write manifest self-check: warn if DEFAULT_LOAD is empty but core.adf exists
  if (fs.existsSync(path.join('.ai', 'core.adf'))) {
    const manifestCheckPath = path.join('.ai', 'manifest.adf');
    if (fs.existsSync(manifestCheckPath)) {
      try {
        const manifestDoc = parseAdf(fs.readFileSync(manifestCheckPath, 'utf-8'));
        const manifestParsed = parseManifest(manifestDoc);
        if (manifestParsed.defaultLoad.length === 0 && options.format === 'text') {
          console.log("  Warning: manifest.adf parsed with 0 DEFAULT_LOAD entries — run 'charter adf register core.adf --load default' to repair.");
        }
      } catch {
        // Parse failure already flagged elsewhere
      }
    }
  }

  // ========================================================================
  // Phase 4: Migrate Agent Configs
  // ========================================================================
  const migrateResult = leanMode
    ? { step: { name: 'migrate' as StepName, status: 'skip' as StepStatus, details: { reason: 'lean mode' }, warnings: [] as string[] } }
    : runMigratePhase(options, nonInteractive);
  result.steps.push(migrateResult.step);
  warnings += migrateResult.step.warnings.length;

  if (options.format === 'text' && !leanMode) {
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
  const installResult = leanMode
    ? { step: { name: 'install' as StepName, status: 'skip' as StepStatus, details: { reason: 'lean mode' }, warnings: [] as string[] } }
    : runInstallPhase(options, skipInstall);
  result.steps.push(installResult.step);
  warnings += installResult.step.warnings.length;

  if (options.format === 'text' && !leanMode) {
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
  const populateResult = leanMode
    ? { step: { name: 'populate' as StepName, status: 'skip' as StepStatus, details: { reason: 'lean mode' }, warnings: [] as string[] } }
    : await runPopulatePhase(options);
  result.steps.push(populateResult.step);
  warnings += populateResult.step.warnings.length;

  if (options.format === 'text' && !leanMode) {
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
    console.log(`[${leanMode ? '4/4' : '7/7'}] Running health check...`);
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

  if (leanMode) {
    const leanPm = detectPackageManagerFromLockfiles();
    result.nextSteps.push({
      cmd: `${leanPm} install`,
      required: true,
      reason: 'Install dependencies (skipped in lean mode)',
    });
    if (inGitRepo) {
      result.nextSteps.push({
        cmd: 'charter hook install --commit-msg',
        required: false,
        reason: 'Install commit-msg hook for trailer enforcement',
      });
      result.nextSteps.push({
        cmd: 'charter hook install --pre-commit',
        required: false,
        reason: 'Install pre-commit hook for ADF evidence gate',
      });
    }
    result.nextSteps.push({
      cmd: 'charter serve',
      required: false,
      reason: 'Enable real-time governance via MCP (wire in .mcp.json or .claude/settings.json)',
    });
  } else {
    // Build next steps
    result.nextSteps.push({
      cmd: 'charter serve  # start MCP server for Claude Code / Codex / Cursor integration',
      required: false,
      reason: 'Enable real-time governance via MCP (wire in .mcp.json or .claude/settings.json)',
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

    // Gate hook next-steps on being inside a git repo
    if (inGitRepo) {
      result.nextSteps.push({
        cmd: 'charter hook install --pre-commit',
        required: false,
        reason: 'Install pre-commit hook for ADF evidence gate',
      });
      result.nextSteps.push({
        cmd: 'charter hook install --commit-msg',
        required: false,
        reason: 'Install commit-msg hook for trailer enforcement',
      });
      result.nextSteps.push({
        cmd: 'echo \'charter context --write\' >> .git/hooks/post-commit && chmod +x .git/hooks/post-commit',
        required: false,
        reason: 'Keep .charter/context.md fresh after each commit (charter brief auto-refresh)',
      });
    }

    result.nextSteps.push({
      cmd: 'charter hook print --claude  # paste output into .claude/settings.json → hooks.UserPromptSubmit',
      required: false,
      reason: 'Auto-refresh context at session start so charter_context returns live state, not a cold snapshot, before the agent acts',
    });
  }

  // ========================================================================
  // Governance Gaps — surface what's configured but not enforced
  // ========================================================================
  const gaps: Array<{ gap: string; fix: string }> = [];

  // Check: trailers enabled but no commit-msg hook
  if (fs.existsSync('.charter/config.json')) {
    try {
      const cfg = JSON.parse(fs.readFileSync('.charter/config.json', 'utf-8'));
      if (cfg.git?.requireTrailers) {
        const hookPath = path.resolve('.githooks/commit-msg');
        const gitHookPath = path.resolve('.git/hooks/commit-msg');
        if (!fs.existsSync(hookPath) && !fs.existsSync(gitHookPath)) {
          gaps.push({
            gap: 'requireTrailers enabled but no commit-msg hook installed',
            fix: 'charter hook install --commit-msg',
          });
        }
      }
      if (cfg.drift?.enabled && !ciTarget) {
        const workflowPath = path.resolve('.github/workflows/charter.yml');
        if (!fs.existsSync(workflowPath)) {
          gaps.push({
            gap: 'drift detection enabled but no CI workflow',
            fix: 'charter bootstrap --ci github (or add manually)',
          });
        }
      }
    } catch { /* config not parseable — doctor already caught it */ }
  }

  // Check: no SECURITY.md
  if (!fs.existsSync('SECURITY.md')) {
    gaps.push({
      gap: 'no SECURITY.md for responsible disclosure',
      fix: 'add SECURITY.md with reporting contact and supported versions',
    });
  }

  // Check: no pre-commit hook for ADF evidence
  const preCommitHook = path.resolve('.githooks/pre-commit');
  const gitPreCommit = path.resolve('.git/hooks/pre-commit');
  if (!fs.existsSync(preCommitHook) && !fs.existsSync(gitPreCommit)) {
    gaps.push({
      gap: 'no pre-commit hook for ADF evidence gate',
      fix: 'charter hook install --pre-commit',
    });
  }

  if (options.format === 'json') {
    (result as unknown as Record<string, unknown>).governanceGaps = gaps;
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Bootstrap complete. ${warnings} warning${warnings === 1 ? '' : 's'}.`);

    if (gaps.length > 0) {
      console.log('');
      console.log('Governance gaps (configured but not enforced):');
      for (const { gap, fix } of gaps) {
        console.log(`  ⚠ ${gap}`);
        console.log(`    → ${fix}`);
      }
    }

    console.log('');
    console.log('Next steps:');
    result.nextSteps.forEach((step, i) => {
      console.log(`  ${i + 1}. ${step.cmd}`);
    });

    // Partial/failure summary banner
    if (result.status === 'partial' || result.status === 'failure') {
      const failedSteps = result.steps.filter(s => s.status === 'fail');
      console.log('');
      console.log(`⚠  Bootstrap partially complete — ${failedSteps.length} step${failedSteps.length === 1 ? '' : 's'} failed:`);
      for (const s of failedSteps) {
        const rawErr = s.details.error ? String(s.details.error).split('\n')[0].slice(0, 120) : '';
        const errDetail = rawErr ? ` (${rawErr})` : '';
        const hintLine = s.warnings.find(w => w.startsWith('Hint:'));
        const hint = hintLine ? ` — ${hintLine}` : '';
        console.log(`   • ${s.name}${errDetail}${hint}`);
      }
      console.log('');
      console.log('Next steps to complete setup:');
      let n = 1;
      const installFailed = failedSteps.some(s => s.name === 'install');
      if (installFailed) {
        const installStep = failedSteps.find(s => s.name === 'install');
        const frozenHint = installStep?.warnings.find(w => w.includes('--no-frozen-lockfile'));
        if (frozenHint) {
          console.log(`   ${n++}. pnpm install --no-frozen-lockfile   (or see hint above)`);
        } else {
          console.log(`   ${n++}. ${installStep?.details.command ?? 'npm install'}   (see hint above)`);
        }
        console.log(`   ${n++}. charter doctor`);
        if (inGitRepo) {
          console.log(`   ${n++}. charter hook install --pre-commit`);
        }
      } else {
        console.log(`   ${n++}. charter doctor`);
      }
    }
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
  force: boolean,
  securitySensitive: boolean
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
      securitySensitive,
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

    const mcpConfig = ensureProjectMcpConfig('.ai', force);
    if (mcpConfig.created) {
      created.push('.mcp.json');
    } else if (mcpConfig.updated) {
      updated.push('.mcp.json');
    }
    if (mcpConfig.warning) {
      warnings.push(mcpConfig.warning);
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

function ensureProjectMcpConfig(
  aiDir: string,
  force: boolean,
): { created: boolean; updated: boolean; warning?: string } {
  const configPath = path.resolve('.mcp.json');
  const desiredServer = {
    command: 'npx',
    args: ['@stackbilt/cli', 'serve', '--ai-dir', path.resolve(aiDir)],
  };

  const configExists = fs.existsSync(configPath);
  let root: Record<string, unknown> = {};
  if (configExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          created: false,
          updated: false,
          warning: 'Skipped MCP config update: .mcp.json must contain a JSON object at the top level.',
        };
      }
      root = { ...(parsed as Record<string, unknown>) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        created: false,
        updated: false,
        warning: `Skipped MCP config update: .mcp.json is not valid JSON (${msg}).`,
      };
    }
  }

  const mcpServersRaw = root.mcpServers;
  if (mcpServersRaw !== undefined && (typeof mcpServersRaw !== 'object' || mcpServersRaw === null || Array.isArray(mcpServersRaw))) {
    return {
      created: false,
      updated: false,
      warning: 'Skipped MCP config update: .mcp.json#mcpServers must be a JSON object.',
    };
  }

  const mcpServers = { ...((mcpServersRaw as Record<string, unknown> | undefined) ?? {}) };
  const existingCharter = mcpServers.charter;
  const sameServer = JSON.stringify(existingCharter) === JSON.stringify(desiredServer);
  if (sameServer) {
    return { created: false, updated: false };
  }

  if (existingCharter !== undefined && !force) {
    return {
      created: false,
      updated: false,
      warning: 'Skipped MCP config update: .mcp.json already defines mcpServers.charter (use --force to replace it).',
    };
  }

  mcpServers.charter = desiredServer;
  root.mcpServers = mcpServers;
  fs.writeFileSync(configPath, JSON.stringify(root, null, 2) + '\n');
  const absolutePathWarning = 'Generated .mcp.json uses an absolute --ai-dir path. Update it if you share this file across machines.';

  if (!configExists) {
    return { created: true, updated: false, warning: absolutePathWarning };
  }

  return { created: false, updated: true, warning: absolutePathWarning };
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
    warnings.push(`Install failed: ${msg}`);
    const hint = classifyInstallError(msg, pm);
    if (hint) {
      warnings.push(`Hint: ${hint}`);
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

function classifyInstallError(msg: string, pm: string): string {
  if (/ERR_PNPM_FROZEN_LOCKFILE|frozen[-. ]lockfile|--frozen-lockfile/i.test(msg))
    return 'Lockfile is out of date. Retry with: pnpm install --no-frozen-lockfile';
  if (/EPERM|EACCES|permission denied/i.test(msg))
    return 'Permission error. On WSL/NTFS try: pnpm install --force  (or move project to ~/projects/)';
  if (/ENOTFOUND|ETIMEDOUT|fetch failed|503|network/i.test(msg))
    return `Network error. Check connectivity and retry: ${pm} install`;
  return '';
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

/**
 * Modules that must always appear in DEFAULT_LOAD rather than ON_DEMAND.
 * core.adf and state.adf are always loaded — they are not optional.
 */
const DEFAULT_LOAD_MODULES = new Set(['core.adf', 'state.adf']);

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
  if (!process.stdin.isTTY) {
    return Promise.resolve(false);
  }
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

/**
 * Register modules in the DEFAULT_LOAD section of manifest.adf.
 * Uses the structured parseAdf/formatAdf round-trip so the result is canonical.
 * DEFAULT_LOAD entries are plain filenames with no "(Triggers on: ...)" suffix.
 */
function registerModulesInDefaultLoad(manifestPath: string, modules: string[]): void {
  const manifestDoc = parseAdf(fs.readFileSync(manifestPath, 'utf-8'));
  const sectionKey = 'DEFAULT_LOAD';

  let section = manifestDoc.sections.find(s => s.key === sectionKey);
  if (!section) {
    section = {
      key: sectionKey,
      decoration: '📦',
      content: { type: 'list', items: [] },
    };
    // Prepend DEFAULT_LOAD before any ON_DEMAND section
    const onDemandIdx = manifestDoc.sections.findIndex(s => s.key === 'ON_DEMAND');
    if (onDemandIdx !== -1) {
      manifestDoc.sections.splice(onDemandIdx, 0, section);
    } else {
      manifestDoc.sections.push(section);
    }
  }

  if (section.content.type !== 'list') {
    // Fallback: append raw text rather than throwing — bootstrap should not crash
    const raw = '\n\n📦 DEFAULT_LOAD:\n' + modules.map(m => `  - ${m}`).join('\n') + '\n';
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf-8').trimEnd() + raw);
    return;
  }

  let updated = false;
  for (const mod of modules) {
    if (!section.content.items.includes(mod)) {
      section.content.items.push(mod);
      updated = true;
    }
  }

  if (updated) {
    fs.writeFileSync(manifestPath, formatAdf(manifestDoc));
  }
}

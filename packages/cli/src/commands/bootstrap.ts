/**
 * charter bootstrap
 *
 * One-command repo onboarding: detect + setup + ADF init + install + doctor.
 * Replaces the multi-step manual process with a single orchestrated flow.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { isGitRepo, runGit } from '../git-helpers';
import { CHARTER_OWNED_MARKERS } from './adf';
import { initializeCharter, type StackPreset } from './init';
import {
  detectStack,
  loadPackageContexts,
  detectPackageManager,
  inferProjectName,
  getGithubWorkflow,
  syncPackageManifest,
} from './setup';
import { applyGovernanceWorkflow } from './github-workflow';
import type { PackageManagerChange, WorkflowKeepReason } from './github-workflow';

/** The governance workflow as the #374 JSON fields and messages name it. */
const WORKFLOW_FILE = '.github/workflows/charter-governance.yml';
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
  RUST_WASM_SCAFFOLD,
  POINTER_CLAUDE_MD_HYBRID,
  POINTER_CURSORRULES,
  POINTER_AGENTS_MD,
  POINTER_GEMINI_MD,
  POINTER_COPILOT_MD,
  manifestForPreset,
} from './adf';
import { loadPatterns } from '../config';
import { parseAdf, parseManifest, TARGET_FILENAMES } from '@stackbilt/adf';
import type { CompileTarget } from '@stackbilt/adf';
import { discoverAgentConfigFiles, migrateSource, updateModuleIndex } from './adf-migrate';
import { inferVendorMode, recordedModeOf, recordWrittenVendorModes, resolveVendorMode } from './adf-vendor';
import type { VendorFile } from './adf-vendor';
import { isCaseInsensitiveDir, moduleKey, registerModules } from './adf-manifest-register';
import { backupFile, describeMerge, dirLabel, formatLossLines, tryEnsureBackupGitignore } from './adf-scaffold-merge';
import type { ScaffoldMode, ScaffoldOutcome } from './adf-scaffold-merge';
import { confirmReset, finalizeLoss, promptYesNo, resetDeclinedMessage, resetRefusalMessage, writeAdfScaffolds } from './adf-scaffold-write';
import type { ResetConfirmation, ScaffoldSpec } from './adf-scaffold-write';
import type { SourceMigrationResult } from './adf-migrate';
import type { PopulateResult } from './adf-populate';

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
  /** Present only when --reset-adf was passed (#354). */
  resetAdf?: ResetConfirmation;
}

const NOT_IN_GIT_REPO_WARNING =
  "Not inside a git repository. Run 'git init && git add -A && git commit -m \"initial commit\"' before installing hooks. Continuing — governance files will be written but hooks cannot be installed yet.";

/**
 * Records a finished phase and, under `--format text`, draws it.
 *
 * This is the only path a phase has into `result.steps`, so a phase cannot reach
 * the JSON payload without its warnings also reaching the screen. `render` draws
 * the phase's own section and returns the warnings it already put on screen in
 * its own wording; everything it left over is printed here as `  Warning: <text>`,
 * immediately before the section's trailing blank line. Omit `render` for a phase
 * that draws no section at all, such as one skipped by `--mode lean`.
 *
 * Nothing type-checks that return value: a `render` that claims a warning it did
 * not draw silently swallows it. So claim strings that were actually printed,
 * never the whole `step.warnings` array.
 */
export function completePhase(
  result: BootstrapResult,
  options: CLIOptions,
  step: StepResult,
  render?: () => readonly string[],
): number {
  result.steps.push(step);

  if (options.format === 'text') {
    const alreadyRendered = render ? render() : [];
    let printedWarning = false;
    for (const warning of step.warnings) {
      if (alreadyRendered.includes(warning)) continue;
      console.log(`  Warning: ${warning}`);
      printedWarning = true;
    }
    if (render || printedWarning) {
      console.log('');
    }
  }

  return step.warnings.length;
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
  // --reset-adf governs .ai/ scaffolds only; it does not imply --force (#354).
  const resetAdf = args.includes('--reset-adf');
  const scaffoldMode: ScaffoldMode = resetAdf ? 'reset' : force ? 'merge' : 'skip';
  const securitySensitive = args.includes('--security-sensitive');
  const nonInteractive = options.yes;
  const leanMode = getFlag(args, '--mode') === 'lean';

  if (ciTarget && ciTarget !== 'github') {
    throw new CLIError(`Unsupported CI target: ${ciTarget}. Supported: github`);
  }

  if (presetFlag && !isValidPreset(presetFlag)) {
    throw new CLIError(`Invalid --preset value: ${presetFlag}. Use worker|frontend|backend|fullstack|docs|rust-wasm.`);
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

  // --reset-adf preflight: confirm before any phase writes, so a refusal writes nothing.
  if (resetAdf) {
    const resetScaffolds = getAdfScaffolds(detectResult.selectedPreset);
    result.resetAdf = await confirmReset(options, '.ai', resetScaffolds);
    if (result.resetAdf.kind === 'declined-at-prompt' || result.resetAdf.kind === 'refused-non-interactive') {
      const message = result.resetAdf.kind === 'declined-at-prompt'
        ? resetDeclinedMessage('.ai')
        : resetRefusalMessage('.ai', resetScaffolds);
      result.status = 'failure';
      if (options.format === 'json') {
        console.log(JSON.stringify({ ...result, message }, null, 2));
      } else {
        console.error(message);
      }
      return EXIT_CODE.POLICY_VIOLATION;
    }
  }

  const selectedPreset: StackPreset = detectResult.selectedPreset;
  const detection = detectResult.detection;
  const contexts = detectResult.contexts;
  const packageManager = detectResult.packageManager;

  // Check git repo status once — used for preflight warning and gating hook next-steps
  const inGitRepo = isGitRepo();
  if (!inGitRepo) {
    detectResult.step.warnings.push(NOT_IN_GIT_REPO_WARNING);
  }

  warnings += completePhase(result, options, detectResult.step, () => {
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
      // Rendered just above as three wrapped lines instead of one long one.
      return [...detection.warnings, NOT_IN_GIT_REPO_WARNING];
    }
    return detection.warnings;
  });

  // ========================================================================
  // Phase 2: Setup
  // ========================================================================
  // #369: only --force replaces .mcp.json's mcpServers.charter (backed up first); --yes never does.
  const setupResult = runSetupPhase(options, selectedPreset, detection, contexts, ciTarget, packageManager, force, securitySensitive);

  warnings += completePhase(result, options, setupResult.step, () => {
    console.log(`[2/${leanMode ? '4' : '7'}] Setting up governance...`);
    for (const f of (setupResult.step.details.created as string[] || [])) {
      console.log(`  Created ${f}`);
    }
    const mcpBackup = setupResult.step.details.mcpBackup as string | undefined;
    const pmChange = (setupResult.step.details.workflow as { packageManagerChange?: PackageManagerChange } | undefined)?.packageManagerChange;
    const workflowPath = path.normalize(WORKFLOW_FILE);
    for (const f of (setupResult.step.details.updated as string[] || [])) {
      const suffix = f === '.mcp.json' && mcpBackup
        ? ` (backup: ${mcpBackup})`
        : f === workflowPath && pmChange ? ` (package manager ${pmChange.from} → ${pmChange.to}; ${pmChange.detail})` : '';
      console.log(`  Updated ${f}${suffix}`);
    }
    for (const r of (setupResult.step.details.replaced as Array<{ file: string; backup: string; note?: string }> | undefined) ?? []) {
      console.log(`  Replaced ${r.file} (backup: ${r.backup}${r.note ? `; ${r.note}` : ''})`);
    }
    for (const n of (setupResult.step.details.notReplaced as Array<{ file: string }> | undefined) ?? []) {
      console.log(`  Not replaced ${n.file} (backup failed; see warning)`);
    }
    // #369: bootstrap never overwrites .charter/; name what it kept rather than claiming it created it.
    // A kept workflow (#374) is named by its own warning instead.
    const kept = ((setupResult.step.details.kept as string[] | undefined) ?? []).filter(f => f !== workflowPath);
    if (kept.length > 0) console.log(`  Kept existing ${kept.join(', ')} (not overwritten; 'charter init --force' replaces them, with a backup)`);
    // Setup's warnings — such as the stale absolute --ai-dir in .mcp.json — are
    // printed by completePhase, in this same position (#304, #307).
    return [];
  });

  // ========================================================================
  // Phase 3: ADF Init
  // ========================================================================
  const adfResult = runAdfInitPhase(options, scaffoldMode, force, selectedPreset);

  warnings += completePhase(result, options, adfResult.step, () => {
    console.log(`[3/${leanMode ? '4' : '7'}] Initializing ADF context...`);
    const outcomes = (adfResult.step.details.scaffolds as ScaffoldOutcome[] | undefined) ?? [];
    for (const o of outcomes) {
      if (o.kind === 'created') console.log(`  Created ${o.file}`);
      else if (o.kind === 'merged') console.log(`  ${describeMerge(o)}`);
      // Scoped wording: phase 6 may still fill a scaffold section in this file (#354).
      else if (o.kind === 'unchanged' && scaffoldMode === 'merge') console.log(`  Unchanged by merge: ${o.file}`);
      else if (o.kind === 'unchanged' && scaffoldMode === 'reset') console.log(`  Already the template: ${o.file}`);
      else if (o.kind === 'replaced') console.log(`  Replaced ${o.file} (backup: ${o.backupPath})`);
    }
    const notReset = adfResult.step.details.notReset as Array<{ file: string; detail: string }> | undefined;
    if (notReset && notReset.length > 0) {
      const requested = outcomes.filter(o => o.kind === 'replaced').length + notReset.length;
      console.log(`  ${notReset.length} of ${requested} file(s) not reset: ${notReset.map(n => n.file).join(', ')} (see warnings)`);
    }
    if (outcomes.some(o => o.kind === 'replaced')) {
      console.log('  The loss report follows the populate phase, compared with the final files.');
    }
    // Files phase 3 wrote that are not scaffolds (the sync lock).
    const scaffoldFiles = new Set(outcomes.map(o => o.file));
    for (const f of (adfResult.step.details.files as string[] || [])) {
      if (scaffoldFiles.has(f)) continue;
      console.log(`  ${f === '.ai/.adf.lock' && adfResult.lockExisted ? 'Updated' : 'Created'} ${f}`);
    }
    for (const f of (adfResult.step.details.pointers as string[] || [])) {
      console.log(`  Generated ${f}`);
    }
    const backedUp = adfResult.step.details.backedUp as number | undefined;
    if (backedUp && backedUp > 0) {
      console.log(`  Backed up ${backedUp} files to .ai/.backup/`);
    }
    return [];
  });

  // Orphan registration: auto-register in --yes mode, prompt interactively otherwise
  const orphans = adfResult.step.details.orphans as string[] || [];
  if (orphans.length > 0) {
    let shouldRegister = false;
    if (nonInteractive) {
      shouldRegister = true;
    } else if (options.format === 'text') {
      shouldRegister = await promptYesNo('  Register these modules now? (y/N) ');
    }
    if (!shouldRegister) {
      // #347: name a command that exists. Printed only when the orphans were left unregistered.
      const hint = 'Run `charter adf create <module> --load default|on-demand` for each to add them to the manifest, or re-run with --yes.';
      adfResult.step.warnings.push(hint);
      warnings++;
      if (options.format === 'text') console.log(`  Warning: ${hint}`);
    }
    if (shouldRegister) {
      const manifestFilePath = path.join('.ai', 'manifest.adf');
      // Shared append-only writer (#239): core.adf and state.adf go to DEFAULT_LOAD,
      // everything else to ON_DEMAND with the module stem as its trigger.
      // Writer warnings join phase 3's step so they also reach the JSON payload (#307).
      const { registrations } = registerModules(manifestFilePath, orphans, [], {
        onWarning: w => {
          adfResult.step.warnings.push(w);
          warnings++;
          if (options.format === 'text') console.log(`  Warning: ${w}`);
        },
      });
      for (const policy of ['DEFAULT_LOAD', 'ON_DEMAND'] as const) {
        const added = registrations.filter(r => r.status === 'added' && r.loadPolicy === policy).length;
        if (added > 0 && options.format === 'text') {
          console.log(`  Registered ${added} module(s) as ${policy} in manifest.adf`);
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
          console.log("  Warning: manifest.adf parsed with 0 DEFAULT_LOAD entries — run 'charter adf create core.adf --load default' to repair.");
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
  warnings += completePhase(result, options, migrateResult.step, leanMode ? undefined : () => {
    console.log('[4/7] Migrating agent configs...');
    if (migrateResult.step.status === 'skip') {
      console.log('  Skipped (no migratable files)');
    } else if (migrateResult.step.details.dryRun) {
      for (const w of migrateResult.step.warnings) {
        console.log(`  ${w}`);
      }
      // The dry-run summary is spelled out above, without the `Warning:` prefix.
      return migrateResult.step.warnings;
    } else {
      const migrated = migrateResult.step.details.migrated as number;
      console.log(`  Migrated ${migrated} file(s)`);
    }
    return [];
  });

  // ========================================================================
  // Phase 5: Install
  // ========================================================================
  const installResult = leanMode
    ? { step: { name: 'install' as StepName, status: 'skip' as StepStatus, details: { reason: 'lean mode' }, warnings: [] as string[] } }
    : runInstallPhase(options, skipInstall);
  warnings += completePhase(result, options, installResult.step, leanMode ? undefined : () => {
    console.log('[5/7] Installing dependencies...');
    if (skipInstall) {
      console.log('  Skipped (--skip-install)');
      return [];
    }
    console.log(`  Detected: ${installResult.step.details.packageManager}`);
    console.log(`  Running: ${installResult.step.details.command}`);
    if (installResult.step.status === 'pass') {
      console.log('  Done');
      return [];
    }
    console.log(`  Failed: ${installResult.step.details.error}`);
    const drawn: string[] = [];
    for (const w of installResult.step.warnings) {
      if (w.startsWith('Hint:') || w.startsWith('Retry')) {
        console.log(`  ${w}`);
        drawn.push(w);
      } else if (w === `Install failed: ${installResult.step.details.error}`) {
        // The `Failed:` line above is this warning, reworded.
        drawn.push(w);
      }
    }
    console.log('  (non-fatal)');
    // Only the lines actually drawn are claimed. Any other warning this phase
    // grows later falls through to completePhase and prints, rather than being
    // swallowed by a wholesale claim on step.warnings.
    return drawn;
  });

  // ========================================================================
  // Phase 6: Populate (#89)
  // ========================================================================
  const populateResult = leanMode
    ? { step: { name: 'populate' as StepName, status: 'skip' as StepStatus, details: { reason: 'lean mode' }, warnings: [] as string[] } }
    : await runPopulatePhase(options);
  warnings += completePhase(result, options, populateResult.step, leanMode ? undefined : () => {
    console.log('[6/7] Auto-populating ADF modules...');
    const changes = (populateResult.step.details.changes as Array<{ file: string; change: string }> | undefined) ?? [];
    for (const c of changes) {
      console.log(c.change.startsWith('Filled ') ? `  ${c.change} in ${c.file}` : `  ${c.change.replace(/ item: /, ` item in ${c.file}: `)}`);
    }
    if (changes.length === 0) console.log('  No scaffold content to replace');
    return [];
  });

  // --reset-adf loss report (#354): compared with each file as the run left it,
  // so content populate or orphan registration put back is not reported lost.
  if (scaffoldMode === 'reset') {
    const outcomes = (adfResult.step.details.scaffolds as ScaffoldOutcome[] | undefined) ?? [];
    const replaced = finalizeLoss(outcomes, adfResult.replacedText, '.ai/manifest.adf');
    if (replaced.length > 0 && options.format === 'text') {
      console.log('Reset report (--reset-adf): what each replaced file no longer holds (the backup has it):');
      for (const o of replaced) {
        const lines = formatLossLines(o.lost, adfResult.replacedText.get(o.file) ?? '');
        console.log(`  ${o.file} (backup: ${o.backupPath})${lines.length === 0 ? ': nothing lost' : ''}`);
        for (const line of lines) console.log(`    ${line}`);
      }
      console.log('');
    }
  }

  // ========================================================================
  // Phase 7: Doctor
  // ========================================================================
  const doctorResult = runDoctorPhase(options, skipDoctor);
  warnings += completePhase(result, options, doctorResult.step, () => {
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
    return [];
  });

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
      cmd: 'git add .charter .ai CLAUDE.md .cursorrules AGENTS.md GEMINI.md copilot-instructions.md && git commit -m "chore: bootstrap charter governance"',
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
        // The file `--ci github` generates; `charter.yml` is also accepted, as the
        // name this check used to look for (a repo may have added one by hand).
        const hasWorkflow = ['charter-governance.yml', 'charter.yml']
          .some(f => fs.existsSync(path.resolve('.github', 'workflows', f)));
        if (!hasWorkflow) {
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

  // --reset-adf --yes that could not replace any file it had to (every backup failed) exits 1 (#354).
  const resetNone = scaffoldMode === 'reset'
    && ((adfResult.step.details.notReset as unknown[] | undefined)?.length ?? 0) > 0
    && ((adfResult.step.details.replaced as unknown[] | undefined)?.length ?? 0) === 0;
  // --force that could not replace the workflow or mcpServers.charter because the
  // backup failed exits 1, as an all-failed --reset-adf and `charter init --force` do (#374).
  const setupNotReplaced = (setupResult.step.details.notReplaced as Array<{ file: string }> | undefined) ?? [];
  const exitCode = resetNone || setupNotReplaced.length > 0 ? EXIT_CODE.POLICY_VIOLATION : EXIT_CODE.SUCCESS;
  const backupDirLabel = `${dirLabel(options.configPath)}.backup`;

  if (options.format === 'json') {
    (result as unknown as Record<string, unknown>).governanceGaps = gaps;
    console.log(JSON.stringify(result, null, 2));
  } else {
    // A run that exits 1 (a file --force could not replace, #374) is not "complete".
    // A failed step that still exits 0 (e.g. doctor WARN checks) keeps the old line;
    // the partial/failure banner below names it either way.
    const plural = `${warnings} warning${warnings === 1 ? '' : 's'}`;
    console.log(exitCode === EXIT_CODE.SUCCESS ? `Bootstrap complete. ${plural}.` : `Bootstrap finished with failures. ${plural}.`);

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
        // #374: a setup step failed by a backup names the files it could not replace.
        const backupDetail = s.name === 'setup' && setupNotReplaced.length > 0
          ? `: ${backupDirLabel} not writable: ${setupNotReplaced.map(n => n.file).join(', ')} not replaced`
          : '';
        console.log(`   • ${s.name}${backupDetail}${errDetail}${hint}`);
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
      } else if (setupNotReplaced.length > 0) {
        console.log(`   ${n++}. Make ${backupDirLabel} a writable directory (fix its permissions, or move aside a file of that name), then re-run charter bootstrap --force`);
        console.log(`   ${n++}. charter doctor`);
      } else {
        console.log(`   ${n++}. charter doctor`);
      }
    }
  }

  return exitCode;
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
  const kept: string[] = [];
  const replaced: Array<{ file: string; backup: string; reason: WorkflowKeepReason; note: string }> = [];
  const notReplaced: Array<{ file: string; detail: string; reason?: WorkflowKeepReason }> = [];
  let workflowDetails: Record<string, unknown> | undefined;
  let mcpBackup: string | undefined;

  try {
    // Initialize .charter/: create each missing file; never overwrite one (#369),
    // whatever --yes, --force or --reset-adf say. `charter init --force` replaces.
    const initResult = initializeCharter(options.configPath, false, {
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

    // Platform separators, as phase 2 printed them before #369 (path.join).
    created.push(...initResult.createdFiles.map(f => path.normalize(f)));
    kept.push(...initResult.kept.map(f => path.normalize(f)));
    warnings.push(...(initResult.warnings ?? []));

    // Generate CI workflow if requested
    if (ciTarget === 'github') {
      const workflowPath = path.join('.github', 'workflows', 'charter-governance.yml');
      // #374: refresh only a safe Charter template; any other workflow is kept,
      // or under --force backed up to .charter/.backup/ and replaced.
      // created/updated/kept use the platform separator, as the .charter/
      // entries do; replaced/notReplaced/workflow use '/', as backups do.
      const workflowFile = WORKFLOW_FILE;
      const workflow = applyGovernanceWorkflow(workflowPath, getGithubWorkflow(packageManager), {
        force,
        configDir: options.configPath,
        command: 'bootstrap',
        packageManager,
      });
      if (workflow.action === 'created') {
        created.push(workflowPath);
      } else if (workflow.action === 'updated') {
        updated.push(workflowPath);
      } else if (workflow.action === 'kept') {
        kept.push(workflowPath);
        warnings.push(workflow.warning);
      } else if (workflow.action === 'replaced') {
        replaced.push({ file: workflowFile, backup: workflow.backup, reason: workflow.reason, note: workflow.note });
        if (workflow.warning) warnings.push(workflow.warning);
      } else if (workflow.action === 'not-replaced') {
        notReplaced.push({ file: workflowFile, detail: workflow.warning, reason: workflow.reason });
        warnings.push(workflow.warning);
      }
      workflowDetails = {
        file: workflowFile,
        action: workflow.action,
        ...('reason' in workflow ? { reason: workflow.reason } : {}),
        ...('changes' in workflow && workflow.changes ? { changes: workflow.changes } : {}),
        ...('templatePermissions' in workflow ? { templatePermissions: workflow.templatePermissions } : {}),
        ...(workflow.action === 'replaced' ? { backup: workflow.backup } : {}),
        ...('packageManagerChange' in workflow && workflow.packageManagerChange ? { packageManagerChange: workflow.packageManagerChange } : {}),
      };
    }

    // Sync package.json scripts + devDependency
    const manifestApplied = syncPackageManifest(selectedPreset, true, true);
    if (manifestApplied.legacy.scripts.updated) {
      updated.push('package.json (scripts)');
    }
    if (manifestApplied.legacy.dependencies.updated) {
      updated.push('package.json (devDependencies)');
    }

    const mcpConfig = ensureProjectMcpConfig('.ai', force, options.configPath);
    if (mcpConfig.created) {
      created.push('.mcp.json');
    } else if (mcpConfig.updated) {
      updated.push('.mcp.json');
    }
    if (mcpConfig.warning) {
      warnings.push(mcpConfig.warning);
    }
    // --force could not replace mcpServers.charter because the backup failed:
    // not replaced, a failed step and exit 1, as for the workflow (#374).
    if (mcpConfig.notReplaced) notReplaced.push({ file: '.mcp.json', detail: mcpConfig.warning ?? '' });
    mcpBackup = mcpConfig.backup;

    return {
      step: {
        name: 'setup',
        // A file --force had to replace but could not (its backup failed) fails the step (#374).
        status: notReplaced.length > 0 ? 'fail' : 'pass',
        details: {
          created,
          updated,
          kept,
          ...(replaced.length > 0 ? { replaced } : {}),
          ...(notReplaced.length > 0 ? { notReplaced } : {}),
          ...(workflowDetails ? { workflow: workflowDetails } : {}),
          ...(mcpBackup ? { mcpBackup } : {}),
        },
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
        details: { created, updated, kept, error: msg },
        warnings,
      },
    };
  }
}

/**
 * Returns the `--ai-dir` value of an existing mcpServers.charter entry when it is an
 * absolute path, otherwise undefined. Used to detect a .mcp.json generated before
 * bootstrap switched to a repo-relative path.
 *
 * "Absolute" is judged under both path flavours, not just the host's. `path.isAbsolute`
 * is the POSIX implementation on a POSIX host, so it reports false for `C:\Users\...`
 * and `\\server\share\...` — and a .mcp.json authored on native Windows is read on
 * Linux every time it reaches CI, a container or a colleague's checkout. `path.win32`
 * covers drive-letter and UNC roots there. It also treats a rooted, driveless
 * `\project\.ai` as absolute, which is a superset of the drive-letter and UNC forms
 * and is machine-specific for the same reason. Drive-relative `C:project` is not
 * absolute under either flavour and stays unflagged.
 */
function absoluteAiDirArg(existingCharter: unknown): string | undefined {
  if (!existingCharter || typeof existingCharter !== 'object' || Array.isArray(existingCharter)) {
    return undefined;
  }
  const args = (existingCharter as { args?: unknown }).args;
  if (!Array.isArray(args)) return undefined;

  const flagIndex = args.indexOf('--ai-dir');
  if (flagIndex === -1) return undefined;

  const value = args[flagIndex + 1];
  if (typeof value !== 'string') return undefined;
  if (!path.isAbsolute(value) && !path.win32.isAbsolute(value)) return undefined;
  return value;
}

/**
 * Returns `true` only when git demonstrably tracks `relPath`.
 *
 * An absolute path is only harmful inside a committed, shared file — in an
 * untracked or gitignored `.mcp.json` it is the supported escape hatch for
 * clients that spawn the server outside the repo root. Fails closed: outside a
 * git repo, before `git init`, or with git unavailable, this reports false and
 * the caller stays quiet rather than warning on a guess.
 */
function isTrackedByGit(relPath: string): boolean {
  try {
    return runGit(['ls-files', '--error-unmatch', '--', relPath]).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Adds mcpServers.charter to .mcp.json. An existing, differing entry is replaced
 * only under `bootstrap --force` (#369; `--yes` alone never replaces it), after
 * .mcp.json is copied to `<configDir>/.backup/mcp.json.<timestamp>`. Adding the
 * entry re-serializes the file, so an existing .mcp.json that is not already in
 * that exact formatting is backed up the same way first (#374). A failed backup
 * leaves the file as is, with a warning.
 */
function ensureProjectMcpConfig(
  aiDir: string,
  force: boolean,
  configDir: string,
): { created: boolean; updated: boolean; warning?: string; backup?: string; notReplaced?: boolean } {
  const configPath = path.resolve('.mcp.json');
  const desiredServer = {
    command: 'npx',
    // Repo-relative on purpose: .mcp.json is committed and shared, and `charter serve`
    // resolves --ai-dir against its own cwd, which MCP clients set to the repo root.
    args: ['@stackbilt/cli', 'serve', '--ai-dir', aiDir],
  };

  const configExists = fs.existsSync(configPath);
  let root: Record<string, unknown> = {};
  // True when re-serializing the file would change bytes other than the added entry (#374).
  let reformats = false;
  if (configExists) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          created: false,
          updated: false,
          warning: 'Skipped MCP config update: .mcp.json must contain a JSON object at the top level.',
        };
      }
      root = { ...(parsed as Record<string, unknown>) };
      reformats = raw !== JSON.stringify(parsed, null, 2) + '\n';
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
    // Repos bootstrapped before the relative --ai-dir fix carry the generating
    // machine's absolute path. That only harms anyone when the file is shared,
    // so gate on tracked-ness: an absolute path in an untracked or gitignored
    // .mcp.json is the documented escape hatch, not a defect to nag about.
    // Name the fix rather than sending the user to --force, which replaces the
    // whole mcpServers.charter entry.
    const staleAbsolute = absoluteAiDirArg(existingCharter);
    if (staleAbsolute !== undefined && isTrackedByGit('.mcp.json')) {
      return {
        created: false,
        updated: false,
        warning:
          `Skipped MCP config update: git tracks .mcp.json and it pins an absolute --ai-dir (${staleAbsolute}), ` +
          `which breaks the MCP server for every other clone and for CI. ` +
          `Edit .mcp.json and replace that path with "${aiDir}", ` +
          `or, if this config is meant to stay machine-local, add .mcp.json to .gitignore and run 'git rm --cached .mcp.json'. ` +
          `Do not use --force for this: it replaces the whole mcpServers.charter entry, including any other settings in it.`,
      };
    }

    return {
      created: false,
      updated: false,
      warning: 'Skipped MCP config update: .mcp.json already defines mcpServers.charter (edit it by hand, or use --force to replace it; --yes alone never does. ' +
        '--force backs .mcp.json up to .charter/.backup/ first, and also rewrites every Charter-managed pointer and merges the preset template into .ai/*.adf without rewriting existing content).',
    };
  }

  // Replacing an existing entry (--force), or adding one to a file whose formatting
  // the rewrite would change (#374): back the file up first; no backup, no write.
  let backup: string | undefined;
  let gitignoreWarning: string | undefined;
  if (existingCharter !== undefined || reformats) {
    const backupDir = path.join(configDir, '.backup');
    const prefix = dirLabel(configDir);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backup = `${prefix}.backup/${backupFile(configPath, backupDir, 'mcp.json', stamp)}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      tryEnsureBackupGitignore(configDir, () => undefined);
      return {
        created: false,
        updated: false,
        // Only --force replaces an existing entry; failing to is a failed step (#374).
        // Not adding one to a reformatted file stays a warning: plain bootstrap never fails over a kept file.
        ...(existingCharter !== undefined ? { notReplaced: true } : {}),
        warning: existingCharter !== undefined
          ? `Skipped MCP config update: could not back up .mcp.json to ${prefix}.backup/ (${msg}); mcpServers.charter was not replaced.`
          : `Skipped MCP config update: could not back up .mcp.json to ${prefix}.backup/ (${msg}); mcpServers.charter was not added, ` +
            'because adding it rewrites the file in standard JSON formatting (2-space indent). Add the entry by hand, or fix the backup directory and re-run.',
      };
    }
    // A .gitignore that cannot be written is a warning, never a failed setup step.
    tryEnsureBackupGitignore(configDir, w => { gitignoreWarning = w; });
  }

  mcpServers.charter = desiredServer;
  root.mcpServers = mcpServers;
  fs.writeFileSync(configPath, JSON.stringify(root, null, 2) + '\n');

  if (!configExists) {
    return { created: true, updated: false };
  }

  return { created: false, updated: true, ...(backup ? { backup } : {}), ...(gitignoreWarning ? { warning: gitignoreWarning } : {}) };
}

// ============================================================================
// Phase 3: ADF Init
// ============================================================================

function getAdfScaffolds(preset?: StackPreset): ScaffoldSpec[] {
  const scaffolds: ScaffoldSpec[] = [
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
  } else if (preset === 'rust-wasm') {
    scaffolds.push({ name: 'rust-wasm.adf', content: RUST_WASM_SCAFFOLD });
  } else {
    scaffolds.push(
      { name: 'frontend.adf', content: FRONTEND_SCAFFOLD },
      { name: 'backend.adf', content: BACKEND_SCAFFOLD },
    );
  }

  return scaffolds;
}

function runAdfInitPhase(
  options: CLIOptions,
  mode: ScaffoldMode,
  force: boolean,
  preset?: StackPreset,
): { step: StepResult; lockExisted: boolean; replacedText: Map<string, string> } {
  const warnings: string[] = [];
  let lockExisted = false;
  let replacedText = new Map<string, string>();
  const files: string[] = [];
  const pointers: string[] = [];
  const detectedOrphans: string[] = [];

  try {
    const aiDir = '.ai';
    // The shared engine (#370) also carries the VENDORS record over a reset of
    // manifest.adf (#318), add-if-absent; under a merge that is a no-op.
    const scaffoldResult = writeAdfScaffolds({
      aiDir,
      mode,
      scaffolds: getAdfScaffolds(preset),
      manifestTemplate: manifestForPreset(preset),
      command: 'charter bootstrap',
      lock: 'hash',
    });
    files.push(...scaffoldResult.files);
    warnings.push(...scaffoldResult.warnings);
    lockExisted = scaffoldResult.lockExisted;
    replacedText = scaffoldResult.replacedText;
    const backupGitignore = tryEnsureBackupGitignore(aiDir, w => warnings.push(w));

    // Detect orphaned ADF modules not registered in manifest (#65)
    const manifestPath2 = path.join(aiDir, 'manifest.adf');
    if (fs.existsSync(manifestPath2)) {
      try {
        const manifestContent = fs.readFileSync(manifestPath2, 'utf-8');
        const allAdfFiles = fs.readdirSync(aiDir).filter(f => f.endsWith('.adf') && f !== 'manifest.adf');
        const doc = parseAdf(manifestContent);
        const manifest = parseManifest(doc);
        // Compared as the manifest writer compares them (#349): on a case-insensitive
        // filesystem an `infra.adf` entry registers `Infra.adf`.
        const fold = isCaseInsensitiveDir(aiDir);
        const registeredModules = new Set<string>([
          ...manifest.defaultLoad,
          ...manifest.onDemand.map(m => m.path),
        ].map(m => moduleKey(m, fold)));
        const orphans = allAdfFiles.filter(f => !registeredModules.has(moduleKey(f, fold)));
        if (orphans.length > 0) {
          detectedOrphans.push(...orphans);
          warnings.push(`Found ${orphans.length} unregistered .adf module(s): ${orphans.join(', ')}`);
        }
      } catch {
        // Non-critical — manifest parse failure shouldn't block bootstrap
      }
    }

    const replacedFiles = scaffoldResult.scaffolds.filter(o => o.kind === 'replaced').map(o => o.file);
    const notReset = scaffoldResult.scaffolds
      .filter((o): o is Extract<ScaffoldOutcome, { kind: 'skipped' }> => o.kind === 'skipped' && o.reason === 'backup-failed')
      .map(o => ({ file: o.file, detail: o.detail }));

    // Generate pointer files (CLAUDE.md uses hybrid template with module index)
    const pointerFiles: Array<{ name: string; content: string; label: string }> = [
      { name: 'CLAUDE.md', content: POINTER_CLAUDE_MD_HYBRID, label: 'CLAUDE.md (hybrid pointer)' },
      { name: '.cursorrules', content: POINTER_CURSORRULES, label: '.cursorrules (thin pointer)' },
      { name: 'AGENTS.md', content: POINTER_AGENTS_MD, label: 'AGENTS.md (thin pointer)' },
      { name: 'GEMINI.md', content: POINTER_GEMINI_MD, label: 'GEMINI.md (thin pointer)' },
      { name: 'copilot-instructions.md', content: POINTER_COPILOT_MD, label: 'copilot-instructions.md (thin pointer)' },
    ];

    const writtenPointers: string[] = [];
    for (const pf of pointerFiles) {
      const pointerPath = path.resolve(pf.name);
      const action = pointerAction(aiDir, pf.name as VendorFile, force);
      if (action === 'write-pointer') {
        fs.writeFileSync(pointerPath, pf.content);
        pointers.push(pf.label);
        writtenPointers.push(pf.name);
      } else if (action === 'skip-compiled' || action === 'skip-recorded-compiled-absent') {
        const target = (Object.keys(TARGET_FILENAMES) as CompileTarget[]).find(t => TARGET_FILENAMES[t] === pf.name) ?? 'all';
        const source = recordedModeOf(aiDir, pf.name as VendorFile) === 'compiled' ? 'recorded' : 'compile banner';
        warnings.push(action === 'skip-compiled'
          ? fill(BOOTSTRAP_MSG.skipCompiled, { file: pf.name, source })
          : fill(BOOTSTRAP_MSG.skipRecordedCompiledAbsent, { file: pf.name, target }));
      } else if (action === 'skip-recorded-unmanaged') {
        warnings.push(fill(BOOTSTRAP_MSG.skipRecordedUnmanaged, { file: pf.name }));
      } else if (action === 'skip-custom' && force) {
        // --force no longer overwrites a hand-authored file: vendor files are not
        // backed up, so its rules would be gone before phase 4 could migrate them.
        warnings.push(fill(options.yes && recordedModeOf(aiDir, pf.name as VendorFile) === null ? BOOTSTRAP_MSG.skipCustomForceYes : BOOTSTRAP_MSG.skipCustomForce, { file: pf.name }));
      } else if (action === 'skip-custom') {
        // File has custom content — don't overwrite. Name the narrow remedy rather
        // than sending the user to --force, which skips a hand-authored file too
        // (#305, #353). --source scopes migration to the one file named here; a
        // bare `adf migrate` would also take every other agent config file it discovers.
        warnings.push(
          `${pf.name} has custom content; skipping pointer. ` +
          `Run 'charter adf migrate --source ${pf.name}' to move its rules into .ai/ and replace it with a thin pointer, ` +
          `or hand-edit or delete ${pf.name} and re-run bootstrap. ` +
          `Do not use --force for this: bootstrap never overwrites a hand-authored file, even with --force.`,
        );
      } else {
        warnings.push(
          `${pf.name} is already Charter-managed; leaving it as is. ` +
          `To regenerate it from the current template, delete ${pf.name} and re-run bootstrap. ` +
          `(--force also regenerates it, but it rewrites every Charter-managed pointer, replaces .mcp.json's mcpServers.charter entry, ` +
          `and merges the preset template into .ai/*.adf without rewriting existing content.)`,
        );
      }
    }

    // Record the mode of each pointer written (#318); warnings join this step (CP-7).
    recordWrittenVendorModes(aiDir, writtenPointers, 'pointer', 'bootstrap', w => warnings.push(w));

    // Populate module index in CLAUDE.md from manifest
    updateModuleIndex('CLAUDE.md', aiDir);

    return {
      step: {
        name: 'adf-init',
        // --reset-adf that replaced none of the files it had to: a failed step (#354).
        status: notReset.length > 0 && replacedFiles.length === 0 ? 'fail' : 'pass',
        details: {
          files,
          pointers,
          backedUp: scaffoldResult.backedUp,
          orphans: detectedOrphans,
          scaffolds: scaffoldResult.scaffolds,
          replaced: replacedFiles,
          mode,
          backupGitignore,
          ...(mode === 'reset' ? { notReset } : {}),
        },
        warnings,
      },
      lockExisted,
      replacedText,
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
      lockExisted,
      replacedText,
    };
  }
}

// ============================================================================
// Phase 4: Migrate Agent Configs
// ============================================================================

function runMigratePhase(
  options: CLIOptions,
  force: boolean,
): { step: StepResult } {
  const warnings: string[] = [];
  const aiDir = '.ai';

  try {
    // Migrate hand-authored files with no recorded mode (#318). A file recorded
    // unmanaged is left alone with a note; any other recorded file is not a source.
    const sources = discoverAgentConfigFiles().filter(f => {
      const fullPath = path.resolve(f);
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (CHARTER_OWNED_MARKERS.some(marker => content.includes(marker))) return false;
      const resolved = resolveVendorMode(aiDir, f as VendorFile);
      if (resolved.source === 'recorded' && resolved.mode === 'unmanaged') {
        warnings.push(fill(BOOTSTRAP_MSG.migrateRecordedUnmanaged, { file: f }));
      }
      return resolved.source === 'inferred';
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
    // Scaffold-only (#354): a CONTEXT/STATE section is replaced only while it still
    // holds scaffold text, whatever bootstrap's own --yes/--force say.
    let results: PopulateResult[] = [];
    const code = await adfPopulateCommand(options, [], { mode: 'scaffold-only', embedded: true, report: (r: PopulateResult[]) => { results = r; } });
    const label = (f: string) => f.split(path.sep).join('/');
    for (const r of results) {
      if (r.reason) warnings.push(`${label(r.file)} ${r.reason}; left as is.`);
    }

    return {
      step: {
        name: 'populate',
        status: code === 0 ? 'pass' : 'fail',
        details: {
          populated: results.filter(r => r.status === 'populated').length,
          skipped: results.filter(r => r.status === 'skipped').length,
          refused: results.filter(r => r.status === 'refused').map(r => ({ file: label(r.file), reason: r.reason ?? '' })),
          changes: results.flatMap(r => (r.changes ?? []).map(change => ({ file: label(r.file), change }))),
          // #371: stack constraints detected but not added (reported once, then recorded as offered).
          notAdded: results.flatMap(r => (r.notAdded ? [{ file: label(r.file), ...r.notAdded }] : [])),
        },
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
  return value === 'worker' || value === 'frontend' || value === 'backend' || value === 'fullstack' || value === 'docs' || value === 'rust-wasm';
}

export const BOOTSTRAP_MSG = {
  skipCompiled: '{file} is compiled output from .ai/ ({source}); bootstrap will not replace it with a pointer. To make it a pointer: charter adf vendor set {file} pointer && charter adf vendor restore {file}',
  skipCustomForce: "{file} has custom content; skipping pointer even with --force, because bootstrap does not back up vendor files. Run 'charter adf migrate --source {file}' to move its rules into .ai/ first.",
  skipCustomForceYes: '{file} has custom content; skipping pointer even with --force, because bootstrap does not back up vendor files. Phase 4 below migrates its rules into .ai/ and then writes the pointer.',
  skipRecordedUnmanaged: '{file} is recorded as unmanaged; leaving it as is.',
  skipRecordedCompiledAbsent: '{file} is recorded as compiled but is not on disk; not writing a pointer. Generate it: charter adf compile --target {target} --write',
  migrateRecordedUnmanaged: '{file} is recorded as unmanaged; not migrating. To migrate it anyway: charter adf migrate --source {file}',
} as const;

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

export type BootstrapPointerAction =
  | 'write-pointer'
  | 'keep-managed'
  | 'skip-compiled'
  | 'skip-custom'
  | 'skip-recorded-unmanaged'
  | 'skip-recorded-compiled-absent';

/**
 * Phase 3's decision for one pointer file (#318). `record` is the valid VENDORS
 * entry for the file's physical file; the evidence is the file at the repo root.
 * The first matching row wins:
 *   recorded compiled            → skip-compiled (absent: skip-recorded-compiled-absent)
 *   compile banner on disk       → skip-compiled
 *   recorded unmanaged           → skip-recorded-unmanaged
 *   absent                       → write-pointer
 *   no Charter marker (custom)   → skip-custom, with or without --force
 *   pointer markers              → keep-managed, or write-pointer under --force
 */
export function pointerAction(aiDir: string, file: VendorFile, force: boolean): BootstrapPointerAction {
  const record = recordedModeOf(aiDir, file);
  let content: string | null = null;
  try {
    content = fs.readFileSync(path.resolve(file), 'utf-8');
  } catch {
    content = null;
  }
  const ev = inferVendorMode(file, content);
  if (record === 'compiled') return ev.exists ? 'skip-compiled' : 'skip-recorded-compiled-absent';
  if (ev.banner) return 'skip-compiled';
  if (record === 'unmanaged') return 'skip-recorded-unmanaged';
  if (!ev.exists) return 'write-pointer';
  if (ev.pointerMarkers.length === 0) return 'skip-custom';
  return force ? 'write-pointer' : 'keep-managed';
}

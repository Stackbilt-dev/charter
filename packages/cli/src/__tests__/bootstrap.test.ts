import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapCommand } from '../commands/bootstrap';
import { doctorCommand } from '../commands/doctor';
import { driftCommand } from '../commands/drift';
import type { CLIOptions } from '../index';
import { parseAdf, parseManifest, TARGET_FILENAMES } from '@stackbilt/adf';

// Controlled per-test override for isGitRepo (git-helpers uses execFileSync, not execSync)
let mockIsGitRepo: boolean | null = null;
vi.mock('../git-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-helpers')>();
  return { ...actual, isGitRepo: () => mockIsGitRepo !== null ? mockIsGitRepo : actual.isGitRepo() };
});

// Controlled per-test override for execSync (module-level mock needed for ESM-treated builtins)
let execSyncOverride: (((...args: unknown[]) => unknown) | null) = null;
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: (...args: unknown[]) => {
      if (execSyncOverride) return execSyncOverride(...args);
      return actual.execSync(...(args as Parameters<typeof actual.execSync>));
    },
  };
});

const baseOptions: CLIOptions = {
  configPath: '.charter',
  format: 'text',
  ciMode: false,
  yes: false,
};

describe('bootstrapCommand', () => {
  let originalCwd: string;
  let tempDir: string;
  let logs: string[];

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-bootstrap-test-'));
    process.chdir(tempDir);
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps custom ADF files when run with --yes but without --force', async () => {
    fs.mkdirSync('.ai', { recursive: true });
    const customCore = `ADF: 0.1

CONTEXT:
  - Custom core instructions
`;
    fs.writeFileSync(path.join('.ai', 'core.adf'), customCore);

    const exitCode = await bootstrapCommand(
      { ...baseOptions, yes: true },
      ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'],
    );

    expect(exitCode).toBe(0);
    expect(fs.readFileSync(path.join('.ai', 'core.adf'), 'utf-8')).toBe(customCore);
    expect(fs.existsSync(path.join('.ai', '.backup'))).toBe(false);
    expect(fs.existsSync(path.join('.ai', 'manifest.adf'))).toBe(true);
    expect(fs.existsSync(path.join('.ai', 'state.adf'))).toBe(true);
    const skipWarning = logs.find(l => l.includes('.ai/core.adf has custom content') && l.includes('skipping scaffold overwrite'));
    expect(skipWarning).toBeDefined();
    expect(skipWarning).toMatch(/\d+ bytes/);
  });

  it('backs up and overwrites custom ADF files when run with --force', async () => {
    fs.mkdirSync('.ai', { recursive: true });
    const customCore = `ADF: 0.1

CONTEXT:
  - Preserve me in backup
`;
    const customState = `ADF: 0.1
STATE:
  CURRENT: Custom state
`;
    fs.writeFileSync(path.join('.ai', 'core.adf'), customCore);
    fs.writeFileSync(path.join('.ai', 'state.adf'), customState);

    const exitCode = await bootstrapCommand(
      baseOptions,
      ['--force', '--preset', 'worker', '--skip-install', '--skip-doctor'],
    );

    expect(exitCode).toBe(0);

    // Backup files should exist with timestamp suffix
    const backupDir = path.join('.ai', '.backup');
    expect(fs.existsSync(backupDir)).toBe(true);
    const backupFiles = fs.readdirSync(backupDir);
    const coreBackup = backupFiles.find(f => f.startsWith('core.adf.'));
    const stateBackup = backupFiles.find(f => f.startsWith('state.adf.'));
    expect(coreBackup).toBeDefined();
    expect(stateBackup).toBeDefined();
    expect(fs.readFileSync(path.join(backupDir, coreBackup!), 'utf-8')).toBe(customCore);
    expect(fs.readFileSync(path.join(backupDir, stateBackup!), 'utf-8')).toBe(customState);

    // Originals should be overwritten with scaffold content
    expect(fs.readFileSync(path.join('.ai', 'core.adf'), 'utf-8')).not.toBe(customCore);
    expect(fs.readFileSync(path.join('.ai', 'state.adf'), 'utf-8')).not.toBe(customState);
    expect(logs).toContain('  Backed up 2 files to .ai/.backup/');
  });

  it('detects orphaned .adf modules and auto-registers them in --yes mode', async () => {
    // Pre-create .ai/ with extra modules that won't be in the scaffold manifest
    fs.mkdirSync('.ai', { recursive: true });
    fs.writeFileSync(path.join('.ai', 'agent.adf'), 'ADF: 0.1\n\nCONTEXT:\n  - Agent rules\n');
    fs.writeFileSync(path.join('.ai', 'persona.adf'), 'ADF: 0.1\n\nCONTEXT:\n  - Persona rules\n');

    const exitCode = await bootstrapCommand(
      { ...baseOptions, yes: true },
      ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'],
    );

    expect(exitCode).toBe(0);
    // Should warn about the two unregistered modules
    const orphanWarning = logs.find(l => l.includes('unregistered .adf module'));
    expect(orphanWarning).toBeDefined();
    expect(orphanWarning).toContain('agent.adf');
    expect(orphanWarning).toContain('persona.adf');

    // In --yes mode, orphans should be auto-registered in manifest
    const registerLog = logs.find(l => l.includes('Registered 2 module(s) as ON_DEMAND'));
    expect(registerLog).toBeDefined();

    // Verify manifest contains the orphan entries
    const manifest = fs.readFileSync(path.join('.ai', 'manifest.adf'), 'utf-8');
    expect(manifest).toContain('agent.adf');
    expect(manifest).toContain('persona.adf');
  });

  it('seeds security-sensitive bootstrap files and warns when security tests are absent', async () => {
    const exitCode = await bootstrapCommand(
      { ...baseOptions, yes: true },
      ['--yes', '--preset', 'worker', '--security-sensitive', '--skip-install', '--skip-doctor'],
    );

    expect(exitCode).toBe(0);
    expect(fs.existsSync('SECURITY.md')).toBe(true);
    expect(fs.existsSync(path.join('.charter', 'patterns', 'security-deny.json'))).toBe(true);

    logs = [];
    await doctorCommand({ ...baseOptions, format: 'json' }, []);
    const report = JSON.parse(logs[0]);
    const securityCheck = report.checks.find((check: { name: string }) => check.name === 'security test coverage');
    expect(securityCheck.status).toBe('WARN');

    fs.mkdirSync('tests', { recursive: true });
    fs.writeFileSync(path.join('tests', 'security-l4.test.ts'), 'export {};');

    logs = [];
    await doctorCommand({ ...baseOptions, format: 'json' }, []);
    const updatedReport = JSON.parse(logs[0]);
    const updatedSecurityCheck = updatedReport.checks.find((check: { name: string }) => check.name === 'security test coverage');
    expect(updatedSecurityCheck.status).toBe('PASS');
  });

  it('creates .mcp.json with charter MCP server wiring for Codex/Cursor', async () => {
    const exitCode = await bootstrapCommand(
      { ...baseOptions, yes: true },
      ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'],
    );

    expect(exitCode).toBe(0);
    expect(fs.existsSync('.mcp.json')).toBe(true);

    const raw = fs.readFileSync('.mcp.json', 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('mcpServers.charter');
    expect(parsed.mcpServers.charter.command).toBe('npx');
    expect(parsed.mcpServers.charter.args).toEqual([
      '@stackbilt/cli',
      'serve',
      '--ai-dir',
      '.ai',
    ]);
  });

  // #298: .mcp.json is committed and shared, so it must carry no machine-local path.
  it('writes a repo-relative --ai-dir into .mcp.json, never an absolute path', async () => {
    const exitCode = await bootstrapCommand(
      { ...baseOptions, yes: true },
      ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'],
    );

    expect(exitCode).toBe(0);

    const raw = fs.readFileSync('.mcp.json', 'utf-8');
    // The generated file must not leak the machine's directory layout.
    expect(raw).not.toContain(tempDir);
    expect(raw).not.toContain(path.resolve('.ai'));

    const args: string[] = JSON.parse(raw).mcpServers.charter.args;
    expect(args.some(arg => path.isAbsolute(arg))).toBe(false);
    expect(args[args.indexOf('--ai-dir') + 1]).toBe('.ai');
  });

  it('does not overwrite existing mcpServers.charter without --force', async () => {
    fs.writeFileSync(
      '.mcp.json',
      JSON.stringify(
        {
          mcpServers: {
            charter: {
              command: 'charter',
              args: ['serve'],
            },
            github: {
              command: 'npx',
              args: ['@modelcontextprotocol/server-github'],
            },
          },
        },
        null,
        2,
      ) + '\n',
    );

    const before = fs.readFileSync('.mcp.json', 'utf-8');
    const exitCode = await bootstrapCommand(
      baseOptions,
      ['--preset', 'worker', '--skip-install', '--skip-doctor'],
    );

    expect(exitCode).toBe(0);
    expect(fs.readFileSync('.mcp.json', 'utf-8')).toBe(before);
  });

  // #298: a repo bootstrapped before the relative --ai-dir fix carries another
  // machine's absolute path. The warning must name that case and the safe fix --
  // and must NOT send the user to --force, which re-scaffolds .ai/*.adf.
  // It is gated on tracked-ness: the harm is a machine path in a SHARED file.
  const STALE_ABSOLUTE = path.join(path.sep, 'home', 'someone-else', 'project', '.ai');

  function writeStaleMcpConfig(): void {
    fs.writeFileSync(
      '.mcp.json',
      JSON.stringify(
        {
          mcpServers: {
            charter: {
              command: 'npx',
              args: ['@stackbilt/cli', 'serve', '--ai-dir', STALE_ABSOLUTE],
            },
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  it('warns about a stale absolute --ai-dir when git tracks .mcp.json, without recommending --force', async () => {
    execFileSync('git', ['init'], { stdio: 'ignore' });
    writeStaleMcpConfig();
    // Staged, not committed: `git ls-files` reads the index, which is what the
    // tracked-ness check consults.
    execFileSync('git', ['add', '.mcp.json'], { stdio: 'ignore' });

    const exitCode = await bootstrapCommand(
      baseOptions,
      ['--preset', 'worker', '--skip-install', '--skip-doctor'],
    );

    expect(exitCode).toBe(0);

    // Asserted against printed output, not the JSON result: a warning the default
    // text run never prints is a warning the user never reads.
    const warning = logs.find(l => l.includes('pins an absolute --ai-dir'));

    expect(warning).toBeDefined();
    // Names the offending path and the exact replacement.
    expect(warning).toContain(STALE_ABSOLUTE);
    expect(warning).toContain('".ai"');
    // Offers the gitignore route, which is the remedy that actually works.
    expect(warning).toContain('.gitignore');
    // Steers away from the destructive remedy rather than toward it.
    expect(warning).toContain('Do not use --force');
  });

  // The docs offer an absolute --ai-dir as the escape hatch for clients that spawn
  // outside the repo root. Warning on that would make the tool contradict its own
  // manual, so an untracked .mcp.json must stay silent.
  it('stays silent about an absolute --ai-dir when .mcp.json is untracked', async () => {
    execFileSync('git', ['init'], { stdio: 'ignore' });
    writeStaleMcpConfig();
    // Deliberately NOT added to the index — the machine-local escape hatch.

    const exitCode = await bootstrapCommand(
      baseOptions,
      ['--preset', 'worker', '--skip-install', '--skip-doctor'],
    );

    expect(exitCode).toBe(0);
    expect(logs.find(l => l.includes('pins an absolute --ai-dir'))).toBeUndefined();
    // The file is still left alone, as with any pre-existing charter entry.
    expect(JSON.parse(fs.readFileSync('.mcp.json', 'utf-8')).mcpServers.charter.args)
      .toContain(STALE_ABSOLUTE);
  });

  it('stays silent about an absolute --ai-dir outside a git repo', async () => {
    // No `git init` here: tracked-ness cannot be determined, so the check fails
    // closed and bootstrap must not warn on a guess.
    writeStaleMcpConfig();

    const exitCode = await bootstrapCommand(
      baseOptions,
      ['--preset', 'worker', '--skip-install', '--skip-doctor'],
    );

    expect(exitCode).toBe(0);
    expect(logs.find(l => l.includes('pins an absolute --ai-dir'))).toBeUndefined();
  });

  // #298: telemetry is per-machine usage data and must never be staged by `git add -A`.
  it('ignores the telemetry directory in the generated .charter/.gitignore', async () => {
    const exitCode = await bootstrapCommand(
      { ...baseOptions, yes: true },
      ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'],
    );

    expect(exitCode).toBe(0);

    const gitignorePath = path.join('.charter', '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);

    // Line-based, not substring: a comment mentioning telemetry must not satisfy this.
    // The pattern is relative to .charter/, so it covers the <configPath>/telemetry/
    // directory that telemetry.ts writes events.ndjson into.
    const lines = fs.readFileSync(gitignorePath, 'utf-8').split('\n').map(l => l.trim());
    expect(lines).toContain('telemetry/');
  });

  it('treats security deny drift matches as CI policy violations', async () => {
    await bootstrapCommand(
      { ...baseOptions, yes: true },
      ['--yes', '--preset', 'worker', '--security-sensitive', '--skip-install', '--skip-doctor'],
    );
    fs.mkdirSync('src', { recursive: true });
    fs.writeFileSync(path.join('src', 'verify.ts'), 'export function verify(computed: string, signature: string) { return computed === signature; }\n');

    logs = [];
    const exitCode = await driftCommand({ ...baseOptions, format: 'json', ciMode: true }, ['--path', '.']);
    const report = JSON.parse(logs[0]);

    expect(exitCode).toBe(1);
    expect(report.status).toBe('FAIL');
    expect(report.securityBlockers).toBeGreaterThan(0);
    expect(report.violations.some((violation: { severity: string; patternName: string }) =>
      violation.severity === 'BLOCKER' && violation.patternName.includes('Timing-Sensitive Equality')
    )).toBe(true);
  });


  it('registers core.adf and state.adf in DEFAULT_LOAD when manifest uses non-canonical syntax', async () => {
    // Set up a .ai/ directory with core.adf, state.adf, and a manifest that uses
    // non-canonical syntax ('load X always') — no '📦 DEFAULT_LOAD:' section.
    // This replicates issue #150: parseManifest returns empty defaultLoad,
    // so core.adf and state.adf appear as orphans and were incorrectly registered
    // as ON_DEMAND before this fix.
    fs.mkdirSync('.ai', { recursive: true });

    const nonCanonicalManifest = `ADF: 0.1

load core.adf always
load state.adf always
`;
    fs.writeFileSync(path.join('.ai', 'manifest.adf'), nonCanonicalManifest);
    fs.writeFileSync(path.join('.ai', 'core.adf'), 'ADF: 0.1\n\nCONTEXT:\n  - Core rules\n');
    fs.writeFileSync(path.join('.ai', 'state.adf'), 'ADF: 0.1\n\nSTATE:\n  CURRENT: active\n');

    const exitCode = await bootstrapCommand(
      { ...baseOptions, yes: true },
      ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'],
    );

    expect(exitCode).toBe(0);

    // Parse the resulting manifest with the structured parser — not string.includes —
    // because that's what verify:adf uses, and it's what was broken.
    const resultManifest = fs.readFileSync(path.join('.ai', 'manifest.adf'), 'utf-8');
    const doc = parseAdf(resultManifest);
    const manifest = parseManifest(doc);

    expect(manifest.defaultLoad).toContain('core.adf');
    expect(manifest.defaultLoad).toContain('state.adf');

    // Neither should appear in ON_DEMAND
    const onDemandPaths = manifest.onDemand.map(m => m.path);
    expect(onDemandPaths).not.toContain('core.adf');
    expect(onDemandPaths).not.toContain('state.adf');
  });

  it('classifies frozen-lockfile install errors and sets status to partial', async () => {
    // Override execSync to throw an ERR_PNPM_FROZEN_LOCKFILE error for this test only
    execSyncOverride = () => {
      throw new Error('ERR_PNPM_FROZEN_LOCKFILE: Lockfile is not up-to-date');
    };

    logs = [];
    try {
      await bootstrapCommand(
        { ...baseOptions, format: 'json' },
        ['--preset', 'worker', '--skip-doctor'],
      );
    } finally {
      execSyncOverride = null;
    }

    const report = JSON.parse(logs[0]);
    expect(report.status).toBe('partial');

    const installStep = report.steps.find((s: { name: string }) => s.name === 'install');
    expect(installStep).toBeDefined();
    expect(installStep.status).toBe('fail');
    const hasHint = installStep.warnings.some((w: string) => w.includes('--no-frozen-lockfile'));
    expect(hasHint).toBe(true);
  });

  describe('--mode lean', () => {
    it('skips migrate, install, and populate phases (status: skip)', async () => {
      logs = [];
      await bootstrapCommand(
        { ...baseOptions, format: 'json' },
        ['--preset', 'worker', '--mode', 'lean', '--skip-doctor'],
      );

      const report = JSON.parse(logs[0]);
      const migrateStep = report.steps.find((s: { name: string }) => s.name === 'migrate');
      const installStep = report.steps.find((s: { name: string }) => s.name === 'install');
      const populateStep = report.steps.find((s: { name: string }) => s.name === 'populate');
      expect(migrateStep.status).toBe('skip');
      expect(installStep.status).toBe('skip');
      expect(populateStep.status).toBe('skip');
    });

    it('exits with status success even when install would have failed', async () => {
      execSyncOverride = () => {
        throw new Error('ERR_PNPM_FROZEN_LOCKFILE: Lockfile is not up-to-date');
      };

      logs = [];
      try {
        await bootstrapCommand(
          { ...baseOptions, format: 'json' },
          ['--preset', 'worker', '--mode', 'lean', '--skip-doctor'],
        );
      } finally {
        execSyncOverride = null;
      }

      const report = JSON.parse(logs[0]);
      expect(report.status).toBe('success');
      const installStep = report.steps.find((s: { name: string }) => s.name === 'install');
      expect(installStep.status).toBe('skip');
    });

    it('emits the detected package manager install command as the first required next step', async () => {
      fs.writeFileSync('pnpm-lock.yaml', '');
      mockIsGitRepo = true;
      logs = [];
      await bootstrapCommand(
        { ...baseOptions, format: 'json' },
        ['--preset', 'worker', '--mode', 'lean', '--skip-doctor'],
      );
      mockIsGitRepo = null;

      const report = JSON.parse(logs[0]);
      expect(report.nextSteps.length).toBe(4);
      const first = report.nextSteps[0];
      expect(first.cmd).toBe('pnpm install');
      expect(first.required).toBe(true);
    });

    it('emits exactly 4 deterministic next steps in the correct order (in a git repo)', async () => {
      mockIsGitRepo = true;
      logs = [];
      await bootstrapCommand(
        { ...baseOptions, format: 'json' },
        ['--preset', 'worker', '--mode', 'lean', '--skip-doctor'],
      );
      mockIsGitRepo = null;

      const report = JSON.parse(logs[0]);
      expect(report.nextSteps.length).toBe(4);
      expect(report.nextSteps[0].cmd).toMatch(/install$/);
      expect(report.nextSteps[1].cmd).toBe('charter hook install --commit-msg');
      expect(report.nextSteps[2].cmd).toBe('charter hook install --pre-commit');
      expect(report.nextSteps[3].cmd).toBe('charter serve');
    });

    it('emits only install + serve next steps outside a git repo', async () => {
      logs = [];
      await bootstrapCommand(
        { ...baseOptions, format: 'json' },
        ['--preset', 'worker', '--mode', 'lean', '--skip-doctor'],
      );

      const report = JSON.parse(logs[0]);
      expect(report.nextSteps.length).toBe(2);
      expect(report.nextSteps[0].cmd).toMatch(/install$/);
      expect(report.nextSteps[1].cmd).toBe('charter serve');
    });

    it('--mode lean combined with --skip-install is not an error', async () => {
      logs = [];
      const exitCode = await bootstrapCommand(
        { ...baseOptions, format: 'json' },
        ['--preset', 'worker', '--mode', 'lean', '--skip-install', '--skip-doctor'],
      );

      expect(exitCode).toBe(0);
      const report = JSON.parse(logs[0]);
      const installStep = report.steps.find((s: { name: string }) => s.name === 'install');
      expect(installStep.status).toBe('skip');
    });
  });
});

// #297 — the pointer file must carry the uppercase AGENTS.md spelling that the
// compiler targets. On a case-insensitive filesystem fs.existsSync() cannot
// tell the two spellings apart, so these assertions compare the names the code
// actually produces (pointer labels, readdir entries) against TARGET_FILENAMES.
describe('bootstrapCommand — AGENTS.md pointer casing (#297)', () => {
  let originalCwd: string;
  let tempDir: string;
  let logs: string[];

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'charter-agents-case-')));
    process.chdir(tempDir);
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    mockIsGitRepo = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('labels the emitted agents pointer with TARGET_FILENAMES.agents, not agents.md', async () => {
    const exitCode = await bootstrapCommand(
      { ...baseOptions, yes: true, format: 'json' },
      ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'],
    );
    expect(exitCode).toBe(0);

    const report = JSON.parse(logs[0]);
    const adfInit = report.steps.find((s: { name: string }) => s.name === 'adf-init');
    const pointers: string[] = adfInit.details.pointers;

    expect(pointers).toContain(`${TARGET_FILENAMES.agents} (thin pointer)`);
    expect(pointers.some(p => p.startsWith('agents.md'))).toBe(false);
  });

  it('writes the pointer at the exact on-disk name the compiler targets', async () => {
    await bootstrapCommand(
      { ...baseOptions, yes: true },
      ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'],
    );

    // readdirSync reports the case the file was created with, even where
    // existsSync would match either spelling.
    const agentsEntries = fs.readdirSync(tempDir).filter(f => f.toLowerCase() === 'agents.md');
    expect(agentsEntries).toEqual([TARGET_FILENAMES.agents]);
  });

  it('names AGENTS.md and GEMINI.md in the git add next step', async () => {
    mockIsGitRepo = true;
    await bootstrapCommand(
      { ...baseOptions, yes: true, format: 'json' },
      ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'],
    );

    const report = JSON.parse(logs[0]);
    const gitAdd = report.nextSteps.find((s: { cmd: string }) => s.cmd.startsWith('git add '));
    expect(gitAdd).toBeDefined();
    expect(gitAdd.cmd).toContain(TARGET_FILENAMES.agents);
    expect(gitAdd.cmd).toContain(TARGET_FILENAMES.gemini);
    expect(gitAdd.cmd).not.toMatch(/\bagents\.md\b/);
  });
});

// #307: every phase counts its warnings into `Bootstrap complete. N warnings.`,
// but phases 6 (populate) and 7 (doctor) never printed the text, so a plain
// `charter bootstrap` run reported a number with nothing to read. The same class
// of silence hid the destructive `--force` advice fixed in #305.
describe('bootstrapCommand — every phase prints its warnings (#307)', () => {
  let originalCwd: string;
  let tempDir: string;
  let logs: string[];

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'charter-phase-warnings-')));
    process.chdir(tempDir);
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    mockIsGitRepo = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Runs bootstrap twice over identical inputs and returns both views of the run. */
  async function runBothFormats(args: string[]): Promise<{ steps: Array<{ name: string; warnings: string[] }>; text: string[] }> {
    logs = [];
    await bootstrapCommand({ ...baseOptions, format: 'json' }, args);
    const steps = JSON.parse(logs[0]).steps;

    // Second run over the files the first one wrote; the phases under test warn
    // on repo state, not on first-run-ness.
    logs = [];
    await bootstrapCommand(baseOptions, args);
    return { steps, text: logs };
  }

  function warningsOf(steps: Array<{ name: string; warnings: string[] }>, name: string): string[] {
    const step = steps.find(s => s.name === name);
    expect(step, `no ${name} step in the JSON report`).toBeDefined();
    return step!.warnings;
  }

  // Bug detector, phase 7. `doctor` raises "Some health checks returned warnings."
  // whenever any check is WARN — here, the missing git repository.
  it('prints the doctor phase warning in text output', async () => {
    mockIsGitRepo = false;

    await bootstrapCommand(baseOptions, ['--preset', 'worker', '--skip-install']);

    expect(logs).toContain('  Warning: Some health checks returned warnings.');
  });

  // Bug detector, phase 6. Whatever `populate` records must reach the screen.
  // The precondition assertion is deliberate: if populate ever stops warning in
  // this environment this test must fail loudly rather than pass vacuously.
  it('prints the populate phase warnings in text output', async () => {
    mockIsGitRepo = false;

    const { steps, text } = await runBothFormats(['--preset', 'worker', '--skip-install', '--skip-doctor']);
    const populateWarnings = warningsOf(steps, 'populate');

    expect(populateWarnings.length).toBeGreaterThan(0);
    for (const warning of populateWarnings) {
      expect(text.some(line => line.includes(warning))).toBe(true);
    }
  });

  // Guard against an over-eager hoist: phase 2 already printed its own warnings
  // (#304), so a hoisted printer must not print them a second time.
  it('prints the setup phase stale --ai-dir warning exactly once', async () => {
    execFileSync('git', ['init'], { stdio: 'ignore' });
    fs.writeFileSync(
      '.mcp.json',
      JSON.stringify({
        mcpServers: { charter: { command: 'npx', args: ['@stackbilt/cli', 'serve', '--ai-dir', '/home/someone-else/project/.ai'] } },
      }, null, 2) + '\n',
    );
    execFileSync('git', ['add', '.mcp.json'], { stdio: 'ignore' });

    await bootstrapCommand(baseOptions, ['--preset', 'worker', '--skip-install', '--skip-doctor']);

    expect(logs.filter(l => l.includes('pins an absolute --ai-dir'))).toHaveLength(1);
  });

  // Guard: phase 1 renders the not-a-git-repo warning as three wrapped lines. A
  // hoisted printer must not append the raw one-line form on top of them.
  it('prints the not-a-git-repo warning only in its wrapped three-line form', async () => {
    mockIsGitRepo = false;

    await bootstrapCommand(baseOptions, ['--preset', 'worker', '--skip-install', '--skip-doctor']);

    expect(logs.filter(l => l.includes('Not inside a git repository'))).toHaveLength(1);
    expect(logs.filter(l => l.includes('governance files will be written'))).toHaveLength(1);
  });

  // Guard: lean mode never runs phases 4-6, so it must not gain their headers or
  // stray blank sections.
  it('does not print skipped lean-mode phase sections', async () => {
    mockIsGitRepo = false;

    await bootstrapCommand(baseOptions, ['--preset', 'worker', '--mode', 'lean', '--skip-doctor']);

    expect(logs.some(l => l.includes('Migrating agent configs'))).toBe(false);
    expect(logs.some(l => l.includes('Installing dependencies'))).toBe(false);
    expect(logs.some(l => l.includes('Auto-populating ADF modules'))).toBe(false);
  });
});

// #307 part 2: `absoluteAiDirArg` gated on `path.isAbsolute`, which is the POSIX
// implementation on a POSIX host and returns false for a Windows absolute path.
// A .mcp.json authored on native Windows and read in CI, a container or a
// colleague's Linux checkout therefore pinned a machine path with no warning.
describe('bootstrapCommand — Windows absolute --ai-dir detected on a POSIX host (#307)', () => {
  let originalCwd: string;
  let tempDir: string;
  let logs: string[];

  // String.raw so the literals carry single backslashes, exactly as a Windows
  // .mcp.json stores them after JSON parsing.
  const DRIVE_LETTER = String.raw`C:\Users\someone-else\project\.ai`;
  const DRIVE_LETTER_FORWARD = String.raw`C:/Users/someone-else/project/.ai`;
  const UNC = String.raw`\\build-server\share\project\.ai`;
  // Drive-relative, NOT absolute: `C:foo` resolves against the current directory
  // on drive C. Must stay silent.
  const DRIVE_RELATIVE = String.raw`C:project\.ai`;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'charter-win-aidir-')));
    process.chdir(tempDir);
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    mockIsGitRepo = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Proves the fixtures are what they claim before anything asserts on them: a
  // test that fed the source a single-backslash UNC path would pass for the
  // wrong reason.
  it('uses fixtures with the literal separators a Windows path has', () => {
    expect(DRIVE_LETTER.slice(0, 3).split('').map(c => c.charCodeAt(0))).toEqual([67, 58, 92]);
    expect(UNC.charCodeAt(0)).toBe(92);
    expect(UNC.charCodeAt(1)).toBe(92);
    expect(UNC.charCodeAt(2)).not.toBe(92);
    expect(DRIVE_RELATIVE.charCodeAt(2)).toBe('p'.charCodeAt(0));
    // The premise of the whole describe block: this host does not see these as absolute.
    expect(path.isAbsolute(DRIVE_LETTER)).toBe(false);
    expect(path.isAbsolute(UNC)).toBe(false);
  });

  function writeTrackedMcpConfig(aiDir: string): void {
    execFileSync('git', ['init'], { stdio: 'ignore' });
    fs.writeFileSync(
      '.mcp.json',
      JSON.stringify({
        mcpServers: { charter: { command: 'npx', args: ['@stackbilt/cli', 'serve', '--ai-dir', aiDir] } },
      }, null, 2) + '\n',
    );
    execFileSync('git', ['add', '.mcp.json'], { stdio: 'ignore' });
  }

  async function runBootstrap(): Promise<string | undefined> {
    const exitCode = await bootstrapCommand(baseOptions, ['--preset', 'worker', '--skip-install', '--skip-doctor']);
    expect(exitCode).toBe(0);
    return logs.find(l => l.includes('pins an absolute --ai-dir'));
  }

  // Bug detectors.
  it('warns about a drive-letter --ai-dir with backslashes', async () => {
    writeTrackedMcpConfig(DRIVE_LETTER);
    const warning = await runBootstrap();
    expect(warning).toBeDefined();
    expect(warning).toContain(DRIVE_LETTER);
  });

  it('warns about a drive-letter --ai-dir with forward slashes', async () => {
    writeTrackedMcpConfig(DRIVE_LETTER_FORWARD);
    const warning = await runBootstrap();
    expect(warning).toBeDefined();
    expect(warning).toContain(DRIVE_LETTER_FORWARD);
  });

  it('warns about a UNC --ai-dir', async () => {
    writeTrackedMcpConfig(UNC);
    const warning = await runBootstrap();
    expect(warning).toBeDefined();
    expect(warning).toContain(UNC);
  });

  // Guards against an over-eager matcher.
  it('stays silent about a drive-relative --ai-dir', async () => {
    writeTrackedMcpConfig(DRIVE_RELATIVE);
    expect(await runBootstrap()).toBeUndefined();
  });

  it('stays silent about the repo-relative --ai-dir bootstrap itself writes', async () => {
    writeTrackedMcpConfig('.ai');
    expect(await runBootstrap()).toBeUndefined();
  });

  // The tracked-ness gate from #298 still governs: an untracked .mcp.json is the
  // documented machine-local escape hatch, on Windows paths too.
  it('stays silent about a Windows --ai-dir when .mcp.json is untracked', async () => {
    execFileSync('git', ['init'], { stdio: 'ignore' });
    fs.writeFileSync(
      '.mcp.json',
      JSON.stringify({
        mcpServers: { charter: { command: 'npx', args: ['@stackbilt/cli', 'serve', '--ai-dir', DRIVE_LETTER] } },
      }, null, 2) + '\n',
    );

    expect(await runBootstrap()).toBeUndefined();
  });
});

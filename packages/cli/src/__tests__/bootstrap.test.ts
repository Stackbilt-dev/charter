import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapCommand } from '../commands/bootstrap';
import { doctorCommand } from '../commands/doctor';
import { driftCommand } from '../commands/drift';
import type { CLIOptions } from '../index';
import { parseAdf, parseManifest } from '@stackbilt/adf';

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

    const parsed = JSON.parse(fs.readFileSync('.mcp.json', 'utf-8'));
    expect(parsed).toHaveProperty('mcpServers.charter');
    expect(parsed.mcpServers.charter.command).toBe('npx');
    expect(parsed.mcpServers.charter.args).toEqual([
      '@stackbilt/cli',
      'serve',
      '--ai-dir',
      path.resolve('.ai'),
    ]);
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

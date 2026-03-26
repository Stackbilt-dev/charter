import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapCommand } from '../commands/bootstrap';
import type { CLIOptions } from '../index';

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
});

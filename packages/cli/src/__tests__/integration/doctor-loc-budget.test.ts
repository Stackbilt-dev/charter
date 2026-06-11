/**
 * Integration tests: charter doctor source LOC budget enforcement (#186)
 *
 * Verifies the per-path LOC budget feature surfaces through `charter doctor`:
 * - fail-ceiling breach → WARN check → CI exit 1 (POLICY_VIOLATION)
 * - warn-ceiling breach → advisory INFO → CI exit 0 (does not break the build)
 * - within budget → PASS
 * - no coverage configured → soft INFO nudge (never WARN, never breaks CI)
 *
 * Runs under --adf-only (the invocation in the issue repro) against a git-init'd
 * temp repo with a minimal valid .ai, so the budget check is the only variable.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../../index';
import { EXIT_CODE } from '../../index';
import { doctorCommand } from '../../commands/doctor';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(label: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `charter-doctor-loc-${label}-`));
  tempDirs.push(tmp);
  return tmp;
}

const ciOptions: CLIOptions = {
  configPath: '.charter',
  format: 'json',
  ciMode: true,
  yes: false,
};

interface DoctorOutput {
  status: 'PASS' | 'WARN';
  checks: Array<{ name: string; status: 'PASS' | 'WARN' | 'INFO'; details: string }>;
}

/**
 * Lay down a git repo with a minimal valid .ai so the only non-PASS doctor
 * check can be the LOC budget. `srcLines` source lines become a measured value
 * of srcLines+1 (trailing newline; same convention as adf evidence).
 */
function writeFixture(tmp: string, opts: { srcLines: number; config?: unknown }): void {
  execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore' });

  fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), `ADF: 0.1

📦 DEFAULT_LOAD:
  - core.adf
  - state.adf
`);
  fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), 'ADF: 0.1\n\n📊 METRICS:\n  entry_loc: 0 / 500 [lines]\n');
  fs.writeFileSync(path.join(tmp, '.ai', 'state.adf'), 'ADF: 0.1\n\n📋 STATE:\n  - CURRENT: testing\n');

  if (opts.config !== undefined) {
    fs.mkdirSync(path.join(tmp, '.charter'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.charter', 'config.json'), JSON.stringify(opts.config, null, 2));
  }

  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  const content = Array.from({ length: opts.srcLines }, (_, i) => `// line ${i + 1}`).join('\n') + '\n';
  fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), content);
}

async function runDoctor(args: string[]): Promise<{ exitCode: number; output: DoctorOutput }> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...msgs: unknown[]) => {
    logs.push(msgs.map(String).join(' '));
  });
  let exitCode: number;
  try {
    exitCode = await doctorCommand(ciOptions, args);
  } finally {
    spy.mockRestore();
  }
  return { exitCode, output: JSON.parse(logs.join('\n').trim()) as DoctorOutput };
}

function budgetCheck(output: DoctorOutput) {
  return output.checks.find(c => c.name === 'source loc budget');
}

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('charter doctor source LOC budget (integration)', () => {
  const budgetConfig = {
    project: 'fixture',
    locBudgets: { paths: [{ pattern: 'src/index.ts', warn: 300, fail: 500 }] },
  };

  it('fails CI (exit 1) when a file exceeds its fail ceiling', async () => {
    const tmp = makeTempDir('fail');
    process.chdir(tmp);
    writeFixture(tmp, { srcLines: 600, config: budgetConfig }); // measured 601 > 500

    const { exitCode, output } = await runDoctor(['--adf-only']);
    const check = budgetCheck(output);

    expect(check?.status).toBe('WARN');
    expect(check?.details).toContain('src/index.ts');
    expect(check?.details).toContain('FAIL');
    expect(exitCode).toBe(EXIT_CODE.POLICY_VIOLATION);
  });

  it('does NOT fail CI when a file only exceeds its warn ceiling (advisory INFO)', async () => {
    const tmp = makeTempDir('warn');
    process.chdir(tmp);
    writeFixture(tmp, { srcLines: 400, config: budgetConfig }); // measured 401: >300 warn, <=500 fail

    const { exitCode, output } = await runDoctor(['--adf-only']);
    const check = budgetCheck(output);

    expect(check?.status).toBe('INFO');
    expect(check?.details).toContain('warn ceiling');
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
  });

  it('passes when the file is within budget', async () => {
    const tmp = makeTempDir('pass');
    process.chdir(tmp);
    writeFixture(tmp, { srcLines: 100, config: budgetConfig }); // measured 101

    const { exitCode, output } = await runDoctor(['--adf-only']);
    const check = budgetCheck(output);

    expect(check?.status).toBe('PASS');
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
  });

  it('emits a soft INFO nudge (no CI failure) when no LOC coverage is configured', async () => {
    const tmp = makeTempDir('nocov');
    process.chdir(tmp);
    writeFixture(tmp, { srcLines: 5000 }); // huge file, but no locBudgets and no manifest METRICS

    const { exitCode, output } = await runDoctor(['--adf-only']);
    const check = budgetCheck(output);

    expect(check?.status).toBe('INFO');
    expect(check?.details).toContain('No runtime source LOC coverage');
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
  });

  it('respects enabled:false (no enforcement)', async () => {
    const tmp = makeTempDir('disabled');
    process.chdir(tmp);
    writeFixture(tmp, {
      srcLines: 600,
      config: { project: 'fixture', locBudgets: { enabled: false, paths: [{ pattern: 'src/index.ts', fail: 500 }] } },
    });

    const { exitCode, output } = await runDoctor(['--adf-only']);
    const check = budgetCheck(output);

    // Disabled → falls through to the coverage nudge, never a WARN.
    expect(check?.status).toBe('INFO');
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
  });
});

describe('charter doctor --mcp (MCP wiring detection)', () => {
  async function runMcpDoctor(): Promise<{ exitCode: number; output: DoctorOutput }> {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...msgs: unknown[]) => {
      logs.push(msgs.map(String).join(' '));
    });
    let exitCode: number;
    try {
      exitCode = await doctorCommand(ciOptions, ['--mcp']);
    } finally {
      spy.mockRestore();
    }
    return { exitCode, output: JSON.parse(logs.join('\n').trim()) as DoctorOutput };
  }

  it('WARN when no MCP config files exist at all', async () => {
    const tmp = makeTempDir('mcp-none');
    process.chdir(tmp);
    execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore' });

    const { exitCode, output } = await runMcpDoctor();
    const check = output.checks.find(c => c.name === 'mcp wiring');
    expect(check?.status).toBe('WARN');
    expect(check?.details).toContain('charter hook print --mcp-config');
    expect(exitCode).toBe(EXIT_CODE.POLICY_VIOLATION);
  });

  it('WARN when config file exists but has no mcpServers.charter entry', async () => {
    const tmp = makeTempDir('mcp-missing-entry');
    process.chdir(tmp);
    execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore' });
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({ mcpServers: {} }));

    const { exitCode, output } = await runMcpDoctor();
    const check = output.checks.find(c => c.name === 'mcp wiring');
    expect(check?.status).toBe('WARN');
    expect(check?.details).toContain('no mcpServers.charter entry');
    expect(exitCode).toBe(EXIT_CODE.POLICY_VIOLATION);
  });

  it('PASS when mcpServers.charter is present in .claude/settings.json', async () => {
    const tmp = makeTempDir('mcp-wired');
    process.chdir(tmp);
    execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore' });
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { charter: { command: 'charter', args: ['serve'] } } }),
    );

    const { exitCode, output } = await runMcpDoctor();
    const check = output.checks.find(c => c.name === 'mcp wiring');
    expect(check?.status).toBe('PASS');
    expect(check?.details).toContain('charter serve wired in');
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
  });

  it('WARN when config file contains invalid JSON', async () => {
    const tmp = makeTempDir('mcp-bad-json');
    process.chdir(tmp);
    execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore' });
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), '{ bad json }');

    const { exitCode, output } = await runMcpDoctor();
    const check = output.checks.find(c => c.name === 'mcp wiring');
    expect(check?.status).toBe('WARN');
    expect(check?.details).toContain('invalid JSON');
    expect(exitCode).toBe(EXIT_CODE.POLICY_VIOLATION);
  });

  it('PASS with partial wiring mentions unwired files in details', async () => {
    const tmp = makeTempDir('mcp-partial');
    process.chdir(tmp);
    execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore' });
    // Wire in settings.json but leave .mcp.json unwired
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { charter: { command: 'charter', args: ['serve'] } } }),
    );
    fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: {} }));

    const { exitCode, output } = await runMcpDoctor();
    const check = output.checks.find(c => c.name === 'mcp wiring');
    expect(check?.status).toBe('PASS');
    expect(check?.details).toContain('Not wired');
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
  });
});

describe('charter doctor packages check (#90)', () => {
  async function runPackagesDoctor(configPkg: unknown): Promise<{ exitCode: number; output: DoctorOutput }> {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'charter-doctor-pkgs-'));
    tempDirs.push(tmp);
    process.chdir(tmp);
    execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore' });

    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.charter'), { recursive: true });

    fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), 'ADF: 0.1\n\n📦 DEFAULT_LOAD:\n  - core.adf\n  - state.adf\n');
    fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), 'ADF: 0.1\n\n📐 RULES:\n  - Example\n');
    fs.writeFileSync(path.join(tmp, '.ai', 'state.adf'), 'ADF: 0.1\n\n📋 STATE:\n  - CURRENT: test\n');
    fs.writeFileSync(path.join(tmp, '.charter', 'config.json'), JSON.stringify({ packages: configPkg }, null, 2));

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...msgs: unknown[]) => {
      logs.push(msgs.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let exitCode: number;
    try {
      exitCode = await doctorCommand(ciOptions, ['--adf-only']);
    } finally {
      spy.mockRestore();
    }
    return { exitCode, output: JSON.parse(logs.join('\n').trim()) as DoctorOutput };
  }

  it('no packages check emitted when config.packages is absent', async () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'charter-doctor-pkgs-absent-'));
    tempDirs.push(tmp);
    process.chdir(tmp);
    execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore' });
    writeFixture(tmp, { srcLines: 0 });

    const { output } = await runDoctor(['--adf-only']);
    const check = output.checks.find(c => c.name === 'packages');
    expect(check).toBeUndefined();
  });

  it('PASS when all enabled packages are resolvable', async () => {
    // 'path' is a built-in module — always resolvable
    const { exitCode, output } = await runPackagesDoctor({ path: { enabled: true } });
    const check = output.checks.find(c => c.name === 'packages');
    expect(check?.status).toBe('PASS');
    expect(check?.details).toContain('1 enabled package(s)');
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
  });

  it('WARN when an enabled package is not installed', async () => {
    const { exitCode, output } = await runPackagesDoctor({
      '@some-org/definitely-not-installed-pkg-12345': { enabled: true },
    });
    const check = output.checks.find(c => c.name === 'packages');
    expect(check?.status).toBe('WARN');
    expect(check?.details).toContain('@some-org/definitely-not-installed-pkg-12345');
    expect(exitCode).toBe(EXIT_CODE.POLICY_VIOLATION);
  });

  it('skips disabled packages in the check', async () => {
    const { exitCode, output } = await runPackagesDoctor({
      '@some-org/definitely-not-installed-pkg-12345': { enabled: false },
    });
    const check = output.checks.find(c => c.name === 'packages');
    // disabled → no check emitted (no enabled entries)
    expect(check).toBeUndefined();
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
  });
});

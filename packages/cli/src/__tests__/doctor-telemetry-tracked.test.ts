import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { doctorCommand } from '../commands/doctor';

const originalCwd = process.cwd();
const tempDirs: string[] = [];
const options: CLIOptions = {
  configPath: '.charter',
  format: 'json',
  ciMode: false,
  yes: false,
};

interface DoctorOutput {
  checks: Array<{ name: string; status: string; details: string }>;
}

/** Create a git repo with a Charter config dir and a telemetry log on disk. */
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-doctor-telemetry-'));
  tempDirs.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, '.charter', 'telemetry'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.charter', 'config.json'), JSON.stringify({
    project: 'telemetry-fixture',
  }));
  fs.writeFileSync(
    path.join(repo, '.charter', 'telemetry', 'events.ndjson'),
    '{"command":"doctor","timestamp":"2026-01-01T00:00:00.000Z"}\n',
  );
  process.chdir(repo);
  return repo;
}

async function telemetryCheck(args: string[] = []) {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.map(String).join(' ')));
  await doctorCommand(options, args);
  const output = JSON.parse(logs.join('\n')) as DoctorOutput;
  return output.checks.find(check => check.name === 'telemetry tracking');
}

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('charter doctor telemetry tracking', () => {
  it('warns when the telemetry directory is tracked in the git index', async () => {
    makeRepo();
    execFileSync('git', ['add', '.charter/telemetry/events.ndjson'], { stdio: 'ignore' });

    const check = await telemetryCheck();

    expect(check?.status).toBe('WARN');
    expect(check?.details).toContain('git rm -r --cached .charter/telemetry');
    expect(check?.details).toContain('charter telemetry report');
  });

  it('names the tracked file so the remedy can be verified', async () => {
    makeRepo();
    execFileSync('git', ['add', '.charter/telemetry/events.ndjson'], { stdio: 'ignore' });

    const check = await telemetryCheck();

    expect(check?.details).toContain('.charter/telemetry/events.ndjson');
  });

  it('passes when telemetry exists on disk but is untracked', async () => {
    makeRepo();

    const check = await telemetryCheck();

    expect(check?.status).toBe('PASS');
  });

  it('respects a custom --config directory', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'custom-cfg', 'telemetry'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'custom-cfg', 'telemetry', 'events.ndjson'), '{}\n');
    execFileSync('git', ['add', 'custom-cfg/telemetry/events.ndjson'], { stdio: 'ignore' });

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.map(String).join(' ')));
    await doctorCommand({ ...options, configPath: 'custom-cfg' }, []);
    const output = JSON.parse(logs.join('\n')) as DoctorOutput;
    const check = output.checks.find(c => c.name === 'telemetry tracking');

    expect(check?.status).toBe('WARN');
    expect(check?.details).toContain('git rm -r --cached custom-cfg/telemetry');
  });

  it('omits the check under --adf-only so the ADF CI gate is unaffected', async () => {
    makeRepo();
    execFileSync('git', ['add', '.charter/telemetry/events.ndjson'], { stdio: 'ignore' });

    expect(await telemetryCheck(['--adf-only'])).toBeUndefined();
  });

  it('omits the check outside a git repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-doctor-telemetry-nogit-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.charter', 'telemetry'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.charter', 'config.json'), JSON.stringify({ project: 'x' }));
    process.chdir(dir);

    expect(await telemetryCheck()).toBeUndefined();
  });
});

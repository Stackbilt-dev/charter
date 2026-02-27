import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../index';
import { telemetryCommand } from '../commands/telemetry';
import type { CLIOptions } from '../index';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  vi.restoreAllMocks();
});

describe('telemetry', () => {
  it('records local telemetry events during command execution', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-telemetry-test-'));
    tempDirs.push(tmp);
    process.chdir(tmp);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await run(['classify', 'update', 'readme', '--format', 'json', '--config', '.charter']);
    expect(exitCode).toBe(0);

    const telemetryFile = path.join(tmp, '.charter', 'telemetry', 'events.ndjson');
    expect(fs.existsSync(telemetryFile)).toBe(true);

    const lines = fs.readFileSync(telemetryFile, 'utf-8').trim().split('\n');
    const event = JSON.parse(lines[lines.length - 1]) as { commandPath: string; exitCode: number; flags: string[] };
    expect(event.commandPath).toBe('classify');
    expect(event.exitCode).toBe(0);
    expect(event.flags).toContain('--format');
    expect(event.flags).toContain('--config');
  });

  it('generates telemetry report from local event log', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-telemetry-report-'));
    tempDirs.push(tmp);
    process.chdir(tmp);

    const telemetryDir = path.join(tmp, '.charter', 'telemetry');
    fs.mkdirSync(telemetryDir, { recursive: true });
    const now = Date.now();
    const events = [
      {
        version: 1,
        timestamp: new Date(now - 60_000).toISOString(),
        commandPath: 'adf.bundle',
        flags: ['--task'],
        format: 'json',
        ciMode: false,
        durationMs: 120,
        exitCode: 0,
        success: true,
      },
      {
        version: 1,
        timestamp: new Date(now - 30_000).toISOString(),
        commandPath: 'doctor',
        flags: ['--ci'],
        format: 'json',
        ciMode: true,
        durationMs: 90,
        exitCode: 1,
        success: false,
      },
    ];
    fs.writeFileSync(path.join(telemetryDir, 'events.ndjson'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    const options: CLIOptions = {
      configPath: '.charter',
      format: 'json',
      ciMode: false,
      yes: false,
    };

    const exitCode = await telemetryCommand(options, ['report', '--period', '24h']);
    expect(exitCode).toBe(0);
    const report = JSON.parse(logs[0]) as { totalEvents: number; failureCount: number; byCommand: Array<{ command: string }> };
    expect(report.totalEvents).toBe(2);
    expect(report.failureCount).toBe(1);
    expect(report.byCommand.some((entry) => entry.command === 'doctor')).toBe(true);
  });
});

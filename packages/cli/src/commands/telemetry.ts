/**
 * charter telemetry
 *
 * Local telemetry reporting for passive command observability.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import type { CliTelemetryEvent } from '../telemetry';

interface TelemetryReport {
  period: string;
  windowStart: string;
  windowEnd: string;
  totalEvents: number;
  successCount: number;
  failureCount: number;
  policyViolationCount: number;
  runtimeErrorCount: number;
  avgDurationMs: number;
  p95DurationMs: number;
  byCommand: Array<{ command: string; count: number; failures: number }>;
  sourceFile: string;
}

export async function telemetryCommand(options: CLIOptions, args: string[]): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return EXIT_CODE.SUCCESS;
  }

  const subcommand = args[0];
  const rest = args.slice(1);

  switch (subcommand) {
    case 'report':
      return telemetryReport(options, rest);
    default:
      throw new CLIError(`Unknown telemetry subcommand: ${subcommand}. Supported: report`);
  }
}

function telemetryReport(options: CLIOptions, args: string[]): number {
  const period = getFlag(args, '--period') || '7d';
  const periodMs = parsePeriod(period);
  const now = Date.now();
  const windowStartMs = now - periodMs;

  const telemetryFile = path.join(options.configPath, 'telemetry', 'events.ndjson');
  const events = readEvents(telemetryFile).filter((event) => {
    const ts = Date.parse(event.timestamp);
    return Number.isFinite(ts) && ts >= windowStartMs && ts <= now;
  });

  const report = summarizeEvents(events, period, windowStartMs, now, telemetryFile);

  if (options.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
    console.log('  Charter Telemetry Report');
    console.log('  ========================');
    console.log(`  Window: ${report.windowStart} -> ${report.windowEnd} (${report.period})`);
    console.log(`  Events: ${report.totalEvents}`);
    console.log(`  Success: ${report.successCount}`);
    console.log(`  Failures: ${report.failureCount} (policy: ${report.policyViolationCount}, runtime: ${report.runtimeErrorCount})`);
    console.log(`  Latency: avg ${report.avgDurationMs}ms, p95 ${report.p95DurationMs}ms`);
    if (report.byCommand.length > 0) {
      console.log('');
      console.log('  By command:');
      for (const c of report.byCommand) {
        console.log(`    - ${c.command}: ${c.count} run(s), ${c.failures} failure(s)`);
      }
    }
    console.log('');
    console.log(`  Source: ${report.sourceFile}`);
    console.log('');
  }

  return EXIT_CODE.SUCCESS;
}

function summarizeEvents(
  events: CliTelemetryEvent[],
  period: string,
  windowStartMs: number,
  nowMs: number,
  sourceFile: string
): TelemetryReport {
  const successCount = events.filter((e) => e.exitCode === 0).length;
  const failureCount = events.length - successCount;
  const policyViolationCount = events.filter((e) => e.exitCode === 1).length;
  const runtimeErrorCount = events.filter((e) => e.exitCode === 2).length;

  const durations = events.map((e) => e.durationMs).sort((a, b) => a - b);
  const avgDurationMs = durations.length > 0
    ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
    : 0;
  const p95DurationMs = durations.length > 0
    ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]
    : 0;

  const byCommandMap = new Map<string, { count: number; failures: number }>();
  for (const event of events) {
    const existing = byCommandMap.get(event.commandPath) || { count: 0, failures: 0 };
    existing.count += 1;
    if (event.exitCode !== 0) {
      existing.failures += 1;
    }
    byCommandMap.set(event.commandPath, existing);
  }

  const byCommand = [...byCommandMap.entries()]
    .map(([command, v]) => ({ command, count: v.count, failures: v.failures }))
    .sort((a, b) => b.count - a.count);

  return {
    period,
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(nowMs).toISOString(),
    totalEvents: events.length,
    successCount,
    failureCount,
    policyViolationCount,
    runtimeErrorCount,
    avgDurationMs,
    p95DurationMs,
    byCommand,
    sourceFile: sourceFile.replace(/\\/g, '/'),
  };
}

function readEvents(telemetryFile: string): CliTelemetryEvent[] {
  if (!fs.existsSync(telemetryFile)) {
    return [];
  }

  const content = fs.readFileSync(telemetryFile, 'utf-8');
  const events: CliTelemetryEvent[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as CliTelemetryEvent;
      if (typeof parsed.timestamp === 'string' && typeof parsed.commandPath === 'string' && typeof parsed.exitCode === 'number') {
        events.push(parsed);
      }
    } catch {
      // Ignore malformed lines.
    }
  }
  return events;
}

function parsePeriod(value: string): number {
  const match = value.match(/^(\d+)([smhd])$/i);
  if (!match) {
    throw new CLIError(`Invalid --period value: ${value}. Use formats like 30m, 24h, 7d.`);
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const unitMs: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * unitMs[unit];
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function printHelp(): void {
  console.log('');
  console.log('  charter telemetry');
  console.log('');
  console.log('  Usage:');
  console.log('    charter telemetry report [--period <30m|24h|7d>]');
  console.log('');
  console.log('  Notes:');
  console.log('    - Reads local events from .charter/telemetry/events.ndjson');
  console.log('    - Captures command metadata only (no prompt or code content)');
  console.log('');
}

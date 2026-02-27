/**
 * CLI telemetry (local-first, append-only).
 *
 * Writes command execution metadata to .charter/telemetry/events.ndjson
 * with no prompt/content capture.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CliTelemetryEvent {
  version: 1;
  timestamp: string;
  commandPath: string;
  flags: string[];
  format: string;
  ciMode: boolean;
  durationMs: number;
  exitCode: number;
  success: boolean;
  errorName?: string;
}

export interface RecordEventInput {
  args: string[];
  format: string;
  ciMode: boolean;
  durationMs: number;
  exitCode: number;
  errorName?: string;
}

export function recordTelemetryEvent(configPath: string, input: RecordEventInput): void {
  try {
    const telemetryDir = path.join(configPath, 'telemetry');
    const telemetryFile = path.join(telemetryDir, 'events.ndjson');
    fs.mkdirSync(telemetryDir, { recursive: true });

    const event: CliTelemetryEvent = {
      version: 1,
      timestamp: new Date().toISOString(),
      commandPath: inferCommandPath(input.args),
      flags: extractFlagNames(input.args),
      format: input.format,
      ciMode: input.ciMode,
      durationMs: input.durationMs,
      exitCode: input.exitCode,
      success: input.exitCode === 0,
      errorName: input.errorName,
    };

    fs.appendFileSync(telemetryFile, `${JSON.stringify(event)}\n`);
  } catch {
    // Telemetry is best-effort and must never block command execution.
  }
}

export function inferCommandPath(args: string[]): string {
  if (args.length === 0 || args[0].startsWith('-')) {
    return 'quickstart';
  }

  const command = args[0];
  if ((command === 'adf' || command === 'hook' || command === 'telemetry') && args[1] && !args[1].startsWith('-')) {
    return `${command}.${args[1]}`;
  }
  return command;
}

function extractFlagNames(args: string[]): string[] {
  const flags: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('-')) {
      flags.push(arg);
    }
  }
  return [...new Set(flags)];
}

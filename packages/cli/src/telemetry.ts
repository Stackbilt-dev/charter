/**
 * CLI telemetry (local-first, append-only).
 *
 * Writes command execution metadata to .charter/telemetry/events.ndjson
 * with no prompt/content capture.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BundleResult, ConstraintStatus } from '@stackbilt/adf';

export interface CliTelemetryEvent {
  version: 1;
  eventType?: 'command';
  timestamp: string;
  commandPath: string;
  flags: string[];
  format: string;
  ciMode: boolean;
  durationMs: number;
  exitCode: number;
  success: boolean;
  errorName?: string;
  sessionId?: string;
}

/**
 * Sibling event recording which ADF modules were candidates/resolved for a
 * task, and the trigger-match detail behind that resolution. Joinable
 * against subsequent command events (same sessionId, or a time-window
 * fallback) to detect misses: triggers that never fire, or modules that
 * load but whose constraints get violated anyway.
 */
export interface AdfResolutionEvent {
  version: 1;
  eventType: 'adf.resolution';
  timestamp: string;
  sessionId: string | null;
  resolutionId: string;
  source: 'bundle' | 'context' | 'mcp.getProjectContext';
  keywords: string[];
  candidateModules: string[];
  resolvedModules: string[];
  triggerMatches: BundleResult['triggerMatches'];
  tokenEstimate?: number;
}

/**
 * Sibling event recording a single failed METRICS constraint, attributed to
 * the specific `.ai/*.adf` module it was checked against (see
 * `validateConstraints`'s `module` parameter). Unlike AdfResolutionEvent's
 * command-success correlation, this is exact evidence: `charter adf
 * suggest`'s `loadedButViolated` detector can join this directly on module
 * (plus sessionId/time-window) instead of guessing from a downstream
 * command's exit code.
 */
export interface AdfConstraintEvent {
  version: 1;
  eventType: 'adf.constraint';
  timestamp: string;
  sessionId: string | null;
  module: string;
  metric: string;
  status: ConstraintStatus;
}

export interface RecordAdfConstraintInput {
  results: Array<{ module?: string; metric: string; status: ConstraintStatus }>;
  /** Override the CHARTER_SESSION_ID env lookup, same as RecordAdfResolutionInput. */
  sessionId?: string | null;
}

/**
 * Persist one event per failing, module-attributed constraint (best-effort,
 * never throws). Passing/warning constraints aren't recorded — only `fail`
 * is a "violation" in the sense `loadedButViolated` cares about — and
 * results with no `module` are skipped since there's nothing to attribute.
 */
export function recordAdfConstraintEvents(configPath: string, input: RecordAdfConstraintInput): void {
  try {
    const violated = input.results.filter(
      (r): r is { module: string; metric: string; status: ConstraintStatus } =>
        r.module !== undefined && r.status === 'fail',
    );
    if (violated.length === 0) return;

    const telemetryDir = path.join(configPath, 'telemetry');
    const telemetryFile = path.join(telemetryDir, 'events.ndjson');
    fs.mkdirSync(telemetryDir, { recursive: true });

    const timestamp = new Date().toISOString();
    const sessionId = input.sessionId ?? getSessionId() ?? null;
    const lines = violated
      .map((r) => {
        const event: AdfConstraintEvent = {
          version: 1,
          eventType: 'adf.constraint',
          timestamp,
          sessionId,
          module: r.module,
          metric: r.metric,
          status: r.status,
        };
        return JSON.stringify(event);
      })
      .join('\n');

    fs.appendFileSync(telemetryFile, `${lines}\n`);
  } catch {
    // Telemetry is best-effort and must never block command execution.
  }
}

export interface RecordAdfResolutionInput {
  source: AdfResolutionEvent['source'];
  keywords: string[];
  candidateModules: string[];
  resolvedModules: string[];
  triggerMatches: BundleResult['triggerMatches'];
  tokenEstimate?: number;
  /** Override the CHARTER_SESSION_ID env lookup — used by long-lived processes (e.g. `charter serve`) that mint one session id at startup. */
  sessionId?: string | null;
}

/**
 * Read the ambient session id from the environment, treating an empty
 * string the same as unset — a wrapper script that exports
 * CHARTER_SESSION_ID="" should not produce a literal empty-string session
 * id. Exported so long-lived processes (e.g. `charter serve`) that mint
 * their own session id can share this same empty-string handling.
 */
export function getSessionId(): string | undefined {
  return process.env.CHARTER_SESSION_ID || undefined;
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
      eventType: 'command',
      timestamp: new Date().toISOString(),
      commandPath: inferCommandPath(input.args),
      flags: extractFlagNames(input.args),
      format: input.format,
      ciMode: input.ciMode,
      durationMs: input.durationMs,
      exitCode: input.exitCode,
      success: input.exitCode === 0,
      errorName: input.errorName,
      sessionId: getSessionId(),
    };

    fs.appendFileSync(telemetryFile, `${JSON.stringify(event)}\n`);
  } catch {
    // Telemetry is best-effort and must never block command execution.
  }
}

/**
 * Persist an ADF module-resolution event (best-effort, never throws).
 * Sibling to recordTelemetryEvent — same file, discriminated by eventType.
 */
export function recordAdfResolutionEvent(configPath: string, input: RecordAdfResolutionInput): void {
  try {
    const telemetryDir = path.join(configPath, 'telemetry');
    const telemetryFile = path.join(telemetryDir, 'events.ndjson');
    fs.mkdirSync(telemetryDir, { recursive: true });

    const event: AdfResolutionEvent = {
      version: 1,
      eventType: 'adf.resolution',
      timestamp: new Date().toISOString(),
      sessionId: input.sessionId ?? getSessionId() ?? null,
      resolutionId: randomUUID(),
      source: input.source,
      keywords: input.keywords,
      candidateModules: input.candidateModules,
      resolvedModules: input.resolvedModules,
      triggerMatches: input.triggerMatches,
      tokenEstimate: input.tokenEstimate,
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

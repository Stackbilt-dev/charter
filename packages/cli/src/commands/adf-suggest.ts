/**
 * charter adf suggest
 *
 * Report-only diagnostics over .charter/telemetry/events.ndjson: which ADF
 * modules never fire, which task keywords never match a trigger anywhere,
 * and which modules load yet a downstream command still fails. No patch
 * ops are emitted — attributing a keyword or failure to a specific module's
 * trigger list would require knowing *which* module's constraint was
 * violated, and nothing in the current telemetry (validate/drift/evidence
 * check commit trailers, CLAUDE.md sync, and METRICS ceilings respectively)
 * records that. That attribution is a human (or strong-model) call.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import type { AdfResolutionEvent, CliTelemetryEvent } from '../telemetry';

const DEFAULT_MIN_OCCURRENCES = 3;
const DEFAULT_WINDOW_MINUTES = 60;

/**
 * Generic English function words filtered out of the near-miss keyword
 * detector. Without this, "the"/"a"/"and" dominate the report purely on
 * frequency, drowning out keywords that are actually candidate triggers.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'this', 'that', 'these', 'those',
  'it', 'its', 'as', 'at', 'by', 'from', 'into', 'about', 'my', 'our', 'your',
]);

export interface DeadModuleFinding {
  module: string;
  occurrences: number;
}

export interface NearMissKeywordFinding {
  keyword: string;
  occurrences: number;
  correlatedFailures: number;
}

export interface LoadedButViolatedFinding {
  module: string;
  occurrences: number;
  correlatedFailures: number;
}

export interface SuggestReport {
  resolutionEvents: number;
  commandEvents: number;
  minOccurrences: number;
  windowMinutes: number;
  insufficientData: boolean;
  deadModules: DeadModuleFinding[];
  nearMissKeywords: NearMissKeywordFinding[];
  loadedButViolated: LoadedButViolatedFinding[];
  sourceFile: string;
}

export function adfSuggestCommand(options: CLIOptions, args: string[]): number {
  const minOccurrences = parsePositiveInt(getFlag(args, '--min-occurrences')) ?? DEFAULT_MIN_OCCURRENCES;
  const windowMinutes = parsePositiveInt(getFlag(args, '--window-minutes')) ?? DEFAULT_WINDOW_MINUTES;

  const telemetryFile = path.join(options.configPath, 'telemetry', 'events.ndjson');
  const { resolutionEvents, commandEvents } = readEvents(telemetryFile);
  const report = buildSuggestReport(resolutionEvents, commandEvents, minOccurrences, windowMinutes, telemetryFile);

  if (options.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  return EXIT_CODE.SUCCESS;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function readEvents(telemetryFile: string): {
  resolutionEvents: AdfResolutionEvent[];
  commandEvents: CliTelemetryEvent[];
} {
  const resolutionEvents: AdfResolutionEvent[] = [];
  const commandEvents: CliTelemetryEvent[] = [];

  let raw: string;
  try {
    raw = fs.readFileSync(telemetryFile, 'utf-8');
  } catch {
    return { resolutionEvents, commandEvents };
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;

    const record = parsed as { eventType?: string; timestamp?: unknown };
    if (typeof record.timestamp !== 'string') continue;

    if (record.eventType === 'adf.resolution') {
      resolutionEvents.push(parsed as AdfResolutionEvent);
    } else if (record.eventType === 'command' || record.eventType === undefined) {
      // Events written before eventType existed have no discriminator;
      // treat those as command events for backward compatibility.
      commandEvents.push(parsed as CliTelemetryEvent);
    }
  }

  return { resolutionEvents, commandEvents };
}

/**
 * Whether a command event falls within the join window of a resolution
 * event: same sessionId (high confidence) if both are stamped, else a
 * forward-only time-window fallback (heuristic).
 */
function isJoined(resolution: AdfResolutionEvent, command: CliTelemetryEvent, windowMinutes: number): boolean {
  if (resolution.sessionId && command.sessionId) {
    return resolution.sessionId === command.sessionId;
  }

  const resTime = Date.parse(resolution.timestamp);
  const cmdTime = Date.parse(command.timestamp);
  if (!Number.isFinite(resTime) || !Number.isFinite(cmdTime)) return false;

  const deltaMs = cmdTime - resTime;
  return deltaMs >= 0 && deltaMs <= windowMinutes * 60_000;
}

function hasCorrelatedFailure(
  resolution: AdfResolutionEvent,
  commandEvents: CliTelemetryEvent[],
  windowMinutes: number,
): boolean {
  return commandEvents.some((c) => c.success === false && isJoined(resolution, c, windowMinutes));
}

export function buildSuggestReport(
  resolutionEvents: AdfResolutionEvent[],
  commandEvents: CliTelemetryEvent[],
  minOccurrences: number,
  windowMinutes: number,
  sourceFile: string,
): SuggestReport {
  const moduleOccurrences = new Map<string, number>();
  const moduleMatched = new Map<string, number>();
  const globallyMatchedKeywords = new Set<string>();
  const loadedOccurrences = new Map<string, number>();
  const loadedCorrelatedFailures = new Map<string, number>();
  const keywordOccurrences = new Map<string, number>();
  const keywordCorrelatedFailures = new Map<string, number>();

  for (const res of resolutionEvents) {
    for (const tm of res.triggerMatches) {
      moduleOccurrences.set(tm.module, (moduleOccurrences.get(tm.module) ?? 0) + 1);
      if (tm.matched) {
        moduleMatched.set(tm.module, (moduleMatched.get(tm.module) ?? 0) + 1);
      }
      for (const kw of tm.matchedKeywords) {
        globallyMatchedKeywords.add(kw);
      }
    }
    for (const mod of res.resolvedModules) {
      loadedOccurrences.set(mod, (loadedOccurrences.get(mod) ?? 0) + 1);
    }
  }

  // Second pass: needs globallyMatchedKeywords fully populated first.
  for (const res of resolutionEvents) {
    const failed = hasCorrelatedFailure(res, commandEvents, windowMinutes);

    for (const rawKw of res.keywords) {
      // matchedKeywords (buildTriggerReport) are always lowercased; normalize
      // here too so "Audit" and "audit" aren't treated as different keywords
      // and a capitalized keyword that DID match isn't falsely reported as a miss.
      const kw = rawKw.toLowerCase();
      if (globallyMatchedKeywords.has(kw) || STOPWORDS.has(kw)) continue;
      keywordOccurrences.set(kw, (keywordOccurrences.get(kw) ?? 0) + 1);
      if (failed) {
        keywordCorrelatedFailures.set(kw, (keywordCorrelatedFailures.get(kw) ?? 0) + 1);
      }
    }

    if (failed) {
      for (const mod of res.resolvedModules) {
        loadedCorrelatedFailures.set(mod, (loadedCorrelatedFailures.get(mod) ?? 0) + 1);
      }
    }
  }

  const deadModules: DeadModuleFinding[] = [...moduleOccurrences.entries()]
    .filter(([module, occurrences]) => occurrences >= minOccurrences && (moduleMatched.get(module) ?? 0) === 0)
    .map(([module, occurrences]) => ({ module, occurrences }))
    .sort((a, b) => b.occurrences - a.occurrences);

  const nearMissKeywords: NearMissKeywordFinding[] = [...keywordOccurrences.entries()]
    .filter(([, occurrences]) => occurrences >= minOccurrences)
    .map(([keyword, occurrences]) => ({
      keyword,
      occurrences,
      correlatedFailures: keywordCorrelatedFailures.get(keyword) ?? 0,
    }))
    .sort((a, b) => b.correlatedFailures - a.correlatedFailures || b.occurrences - a.occurrences);

  const loadedButViolated: LoadedButViolatedFinding[] = [...loadedCorrelatedFailures.entries()]
    .filter(([, correlatedFailures]) => correlatedFailures > 0)
    .map(([module, correlatedFailures]) => ({
      module,
      occurrences: loadedOccurrences.get(module) ?? 0,
      correlatedFailures,
    }))
    .sort((a, b) => b.correlatedFailures - a.correlatedFailures);

  return {
    resolutionEvents: resolutionEvents.length,
    commandEvents: commandEvents.length,
    minOccurrences,
    windowMinutes,
    insufficientData: resolutionEvents.length < minOccurrences,
    deadModules,
    nearMissKeywords,
    loadedButViolated,
    sourceFile: sourceFile.replace(/\\/g, '/'),
  };
}

function printReport(report: SuggestReport): void {
  console.log('');
  console.log('  charter adf suggest — report-only diagnostics (no patch ops)');
  console.log('');
  console.log(`  Resolution events: ${report.resolutionEvents}, command events: ${report.commandEvents}`);
  console.log(`  Thresholds: min-occurrences=${report.minOccurrences}, window-minutes=${report.windowMinutes}`);
  if (report.insufficientData) {
    console.log('  [!] Insufficient data — keep using the CLI/MCP server, then re-run.');
  }
  console.log('');

  console.log('  Dead modules (0 matches across enough candidate resolutions):');
  if (report.deadModules.length === 0) {
    console.log('    (none)');
  } else {
    for (const f of report.deadModules) {
      console.log(`    [!] ${f.module} — 0 matches / ${f.occurrences} candidate resolutions`);
    }
  }
  console.log('');

  console.log('  Recurring unmatched keywords (no trigger, anywhere, matches this keyword):');
  if (report.nearMissKeywords.length === 0) {
    console.log('    (none)');
  } else {
    for (const f of report.nearMissKeywords) {
      const corr = f.correlatedFailures > 0 ? `, ${f.correlatedFailures} correlated with a downstream failure` : '';
      console.log(`    [?] "${f.keyword}" — seen ${f.occurrences}x${corr}`);
    }
    console.log('    Note: reports the keyword only — does not guess which module should adopt it as a trigger.');
  }
  console.log('');

  console.log('  Loaded-but-violated (module resolved, yet a downstream failure still occurred):');
  if (report.loadedButViolated.length === 0) {
    console.log('    (none)');
  } else {
    for (const f of report.loadedButViolated) {
      console.log(`    [!] ${f.module} — resolved ${f.occurrences}x, ${f.correlatedFailures} correlated with a downstream failure`);
    }
    console.log('    Note: routing worked; rule content may be weak. Needs human/strong-model rewrite, not a trigger change.');
  }
  console.log('');
  console.log(`  Source: ${report.sourceFile}`);
  console.log('');
}

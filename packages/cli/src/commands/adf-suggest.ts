/**
 * charter adf suggest
 *
 * Diagnostics over .charter/telemetry/events.ndjson: which ADF modules
 * never fire, which task keywords never match a trigger anywhere, and
 * which modules load yet still get violated.
 *
 * `loadedButViolated` now has two tiers of evidence:
 *  - Exact: `charter adf evidence` records an `adf.constraint` event for
 *    every failing METRICS ceiling, tagged with the specific module it
 *    belongs to (see `validateConstraints`'s `module` param). Joining
 *    resolution events against these by module + session/time gives a
 *    real failure attribution, not a guess.
 *  - Correlated (fallback): for constraint checks that don't emit
 *    module-tagged evidence (commit-trailer validation, blessed-stack
 *    drift scans — neither of which is module-shaped), or for telemetry
 *    predating this event, we fall back to "some downstream command in
 *    this session/window failed" — a much weaker signal, kept only so the
 *    detector still says something in the absence of exact evidence.
 *
 * `--emit-ops` adds one narrower, self-contained mechanism on top: a
 * co-occurrence heuristic. If an unmatched keyword frequently appears
 * alongside keywords that already trigger some module M (in the same
 * task), M is a *candidate* to adopt that keyword as a new trigger. This
 * is weaker evidence than a failure correlation — it's "these words tend
 * to show up together," not "this caused a violation" — so it only ever
 * proposes a REPLACE_BULLET op for --emit-ops to write out; nothing is
 * ever applied automatically. Ambiguous candidates (tied top module) are
 * reported but never turned into an op.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAdf, parseManifest, formatTriggerEntry } from '@stackbilt/adf';
import type { PatchOperation } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import type { AdfConstraintEvent, AdfResolutionEvent, CliTelemetryEvent } from '../telemetry';

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
  /** Downstream command in the session/window failed — no confirmed link to this module's own constraints. */
  correlatedFailures: number;
  /** This module's own METRICS ceiling was confirmed to fail (adf.constraint events), joined by session/window. */
  exactFailures: number;
}

/**
 * A candidate trigger-keyword-to-module pairing based purely on
 * co-occurrence: `keyword` never matches any trigger itself, but shows up
 * in the same task alongside a keyword that already triggers `module`.
 * Heuristic, not failure-backed — see file header. `ambiguous` is true
 * when another module tied for the top co-occurrence count, in which case
 * no op is ever generated for this candidate.
 */
export interface CoOccurrenceCandidate {
  keyword: string;
  module: string;
  coOccurrences: number;
  keywordOccurrences: number;
  ambiguous: boolean;
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
  coOccurrenceCandidates: CoOccurrenceCandidate[];
  sourceFile: string;
}

export interface EmitOpsResult {
  ops: PatchOperation[];
  diffLines: string[];
  skipped: Array<{ keyword: string; module: string; reason: string }>;
}

export function adfSuggestCommand(options: CLIOptions, args: string[]): number {
  const minOccurrences = parsePositiveInt(getFlag(args, '--min-occurrences')) ?? DEFAULT_MIN_OCCURRENCES;
  const windowMinutes = parsePositiveInt(getFlag(args, '--window-minutes')) ?? DEFAULT_WINDOW_MINUTES;
  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const emitOpsFile = getFlag(args, '--emit-ops');

  const telemetryFile = path.join(options.configPath, 'telemetry', 'events.ndjson');
  const { resolutionEvents, commandEvents, constraintEvents } = readEvents(telemetryFile);
  const report = buildSuggestReport(resolutionEvents, commandEvents, minOccurrences, windowMinutes, telemetryFile, constraintEvents);
  const emitResult = buildEmitOps(report.coOccurrenceCandidates, aiDir);

  if (emitOpsFile) {
    fs.writeFileSync(emitOpsFile, `${JSON.stringify(emitResult.ops, null, 2)}\n`);
  }

  if (options.format === 'json') {
    console.log(JSON.stringify({
      ...report,
      opsFile: emitOpsFile ?? null,
      opsEmitted: emitOpsFile ? emitResult.ops.length : 0,
      skippedCandidates: emitResult.skipped,
    }, null, 2));
  } else {
    printReport(report);
    printEmitOpsSection(emitResult, emitOpsFile);
  }

  return EXIT_CODE.SUCCESS;
}

/**
 * Turn non-ambiguous co-occurrence candidates into REPLACE_BULLET ops
 * against manifest.adf's ON_DEMAND section. Always computed (so the diff
 * preview shows even without --emit-ops); writing the ops file is gated
 * on the caller passing --emit-ops.
 */
function buildEmitOps(candidates: CoOccurrenceCandidate[], aiDir: string): EmitOpsResult {
  const ops: PatchOperation[] = [];
  const diffLines: string[] = [];
  const skipped: Array<{ keyword: string; module: string; reason: string }> = [];

  if (candidates.length === 0) {
    return { ops, diffLines, skipped };
  }

  const manifestPath = path.join(aiDir, 'manifest.adf');
  let manifestContent: string;
  try {
    manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  } catch {
    for (const c of candidates) {
      skipped.push({ keyword: c.keyword, module: c.module, reason: `manifest.adf not found at ${manifestPath}` });
    }
    return { ops, diffLines, skipped };
  }

  const doc = parseAdf(manifestContent);
  const manifest = parseManifest(doc);
  const onDemandSection = doc.sections.find((s) => s.key === 'ON_DEMAND');
  const rawItems = onDemandSection && onDemandSection.content.type === 'list' ? onDemandSection.content.items : [];

  // Group by target module first: two candidates proposing the same module
  // (e.g. "gizmo" and "component" both -> frontend.adf) must become ONE
  // REPLACE_BULLET op with both keywords appended, not two ops at the same
  // index — applying them in sequence would make the second silently
  // clobber the first (adf patch applies against the evolving document).
  const byModule = new Map<string, CoOccurrenceCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.ambiguous) {
      skipped.push({ keyword: candidate.keyword, module: candidate.module, reason: 'ambiguous: tied with another module for top co-occurrence count' });
      continue;
    }
    const group = byModule.get(candidate.module) ?? [];
    group.push(candidate);
    byModule.set(candidate.module, group);
  }

  for (const [modulePath, groupCandidates] of byModule) {
    const modIndex = manifest.onDemand.findIndex((m) => m.path === modulePath);
    if (modIndex === -1 || modIndex >= rawItems.length) {
      for (const c of groupCandidates) {
        skipped.push({ keyword: c.keyword, module: c.module, reason: 'module not found in manifest ON_DEMAND section' });
      }
      continue;
    }

    const mod = manifest.onDemand[modIndex];
    const existingLower = new Set(mod.triggers.map((t) => t.toLowerCase()));
    const newKeywords: string[] = [];
    for (const c of groupCandidates) {
      if (existingLower.has(c.keyword)) {
        skipped.push({ keyword: c.keyword, module: c.module, reason: 'already a trigger for this module' });
        continue;
      }
      newKeywords.push(c.keyword);
    }
    if (newKeywords.length === 0) continue;

    const before = rawItems[modIndex];
    const after = formatTriggerEntry({ ...mod, triggers: [...mod.triggers, ...newKeywords] });

    ops.push({ op: 'REPLACE_BULLET', section: 'ON_DEMAND', index: modIndex, value: after });
    for (const c of groupCandidates) {
      if (!newKeywords.includes(c.keyword)) continue;
      diffLines.push(`    [+] ${modulePath}: add trigger "${c.keyword}" (co-occurs ${c.coOccurrences}x with an existing trigger)`);
    }
    diffLines.push(`        before: ${before}`);
    diffLines.push(`        after:  ${after}`);
  }

  return { ops, diffLines, skipped };
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function readEvents(telemetryFile: string): {
  resolutionEvents: AdfResolutionEvent[];
  commandEvents: CliTelemetryEvent[];
  constraintEvents: AdfConstraintEvent[];
} {
  const resolutionEvents: AdfResolutionEvent[] = [];
  const commandEvents: CliTelemetryEvent[] = [];
  const constraintEvents: AdfConstraintEvent[] = [];

  let raw: string;
  try {
    raw = fs.readFileSync(telemetryFile, 'utf-8');
  } catch {
    return { resolutionEvents, commandEvents, constraintEvents };
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

    const record = parsed as { eventType?: string; timestamp?: unknown; commandPath?: unknown; exitCode?: unknown; module?: unknown; status?: unknown };
    if (typeof record.timestamp !== 'string') continue;

    if (record.eventType === 'adf.resolution') {
      resolutionEvents.push(parsed as AdfResolutionEvent);
    } else if (record.eventType === 'adf.constraint') {
      if (typeof record.module !== 'string' || typeof record.status !== 'string') continue;
      constraintEvents.push(parsed as AdfConstraintEvent);
    } else if (record.eventType === 'command' || record.eventType === undefined) {
      // Events written before eventType existed have no discriminator;
      // treat those as command events for backward compatibility. Require
      // the fields a real command event always has, matching the
      // validation in telemetry.ts's own readEvents, so a malformed or
      // truncated line isn't silently counted as a valid command outcome.
      if (typeof record.commandPath !== 'string' || typeof record.exitCode !== 'number') continue;
      commandEvents.push(parsed as CliTelemetryEvent);
    }
  }

  return { resolutionEvents, commandEvents, constraintEvents };
}

interface Joinable {
  sessionId?: string | null;
  timestamp: string;
}

/**
 * Whether two events fall within the join window of each other: same
 * sessionId (high confidence) if both are stamped, else a forward-only
 * time-window fallback (heuristic).
 */
function isJoined(a: Joinable, b: Joinable, windowMinutes: number): boolean {
  if (a.sessionId && b.sessionId) {
    return a.sessionId === b.sessionId;
  }

  const aTime = Date.parse(a.timestamp);
  const bTime = Date.parse(b.timestamp);
  if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return false;

  const deltaMs = bTime - aTime;
  return deltaMs >= 0 && deltaMs <= windowMinutes * 60_000;
}

function hasCorrelatedFailure(
  resolution: AdfResolutionEvent,
  failedCommandEvents: CliTelemetryEvent[],
  windowMinutes: number,
): boolean {
  return failedCommandEvents.some((c) => isJoined(resolution, c, windowMinutes));
}

export function buildSuggestReport(
  resolutionEvents: AdfResolutionEvent[],
  commandEvents: CliTelemetryEvent[],
  minOccurrences: number,
  windowMinutes: number,
  sourceFile: string,
  constraintEvents: AdfConstraintEvent[] = [],
): SuggestReport {
  const moduleOccurrences = new Map<string, number>();
  const moduleMatched = new Map<string, number>();
  const globallyMatchedKeywords = new Set<string>();
  const loadedOccurrences = new Map<string, number>();
  const loadedCorrelatedFailures = new Map<string, number>();
  const loadedExactFailures = new Map<string, number>();
  const keywordOccurrences = new Map<string, number>();
  const keywordCorrelatedFailures = new Map<string, number>();
  // keyword -> module -> co-occurrence count (module genuinely ON_DEMAND-triggered
  // in the same event, not just default-loaded).
  const keywordModuleCoOccurrence = new Map<string, Map<string, number>>();

  // Only failed commands can ever satisfy hasCorrelatedFailure/isJoined, so
  // scanning just this (typically much smaller) subset per resolution event
  // avoids an O(resolutions x commands) scan over the full command history.
  const failedCommandEvents = commandEvents.filter((c) => c.success === false);

  // Fail-status constraint events, grouped by the module they were checked
  // against — the exact-attribution counterpart to failedCommandEvents.
  const failedConstraintEventsByModule = new Map<string, AdfConstraintEvent[]>();
  for (const ev of constraintEvents) {
    if (ev.status !== 'fail') continue;
    const list = failedConstraintEventsByModule.get(ev.module) ?? [];
    list.push(ev);
    failedConstraintEventsByModule.set(ev.module, list);
  }

  for (const res of resolutionEvents) {
    // triggerMatches has one entry per (module, trigger) pair, so a module
    // declared with multiple triggers must be deduped per event here —
    // otherwise it would count as multiple "candidate resolutions" from a
    // single real invocation, reaching --min-occurrences too early relative
    // to modules with fewer declared triggers.
    const modulesSeenThisEvent = new Set<string>();
    const modulesMatchedThisEvent = new Set<string>();
    for (const tm of res.triggerMatches) {
      modulesSeenThisEvent.add(tm.module);
      if (tm.matched) modulesMatchedThisEvent.add(tm.module);
      for (const kw of tm.matchedKeywords) {
        globallyMatchedKeywords.add(kw);
      }
    }
    for (const mod of modulesSeenThisEvent) {
      moduleOccurrences.set(mod, (moduleOccurrences.get(mod) ?? 0) + 1);
    }
    for (const mod of modulesMatchedThisEvent) {
      moduleMatched.set(mod, (moduleMatched.get(mod) ?? 0) + 1);
    }
    for (const mod of res.resolvedModules) {
      loadedOccurrences.set(mod, (loadedOccurrences.get(mod) ?? 0) + 1);
    }
  }

  // Second pass: needs globallyMatchedKeywords fully populated first.
  for (const res of resolutionEvents) {
    const failed = hasCorrelatedFailure(res, failedCommandEvents, windowMinutes);

    // Modules genuinely triggered on-demand in this event (excludes
    // default-load modules, which "resolve" regardless of keywords and so
    // can't be evidence of a keyword/module co-occurrence).
    const triggeredModulesThisEvent = new Set(
      res.triggerMatches.filter((tm) => tm.matched && tm.loadReason === 'trigger').map((tm) => tm.module),
    );

    // A single task can repeat a word (or an upstream producer can hand back
    // a non-deduplicated keyword array) — dedupe per event so one invocation
    // with a repeated word can't alone cross --min-occurrences.
    const seenKeywordsThisEvent = new Set<string>();
    const unmatchedKeywordsThisEvent: string[] = [];
    for (const rawKw of res.keywords) {
      // matchedKeywords (buildTriggerReport) are always lowercased; normalize
      // here too so "Audit" and "audit" aren't treated as different keywords
      // and a capitalized keyword that DID match isn't falsely reported as a miss.
      const kw = rawKw.toLowerCase();
      if (seenKeywordsThisEvent.has(kw)) continue;
      seenKeywordsThisEvent.add(kw);
      if (globallyMatchedKeywords.has(kw) || STOPWORDS.has(kw)) continue;
      keywordOccurrences.set(kw, (keywordOccurrences.get(kw) ?? 0) + 1);
      unmatchedKeywordsThisEvent.push(kw);
      if (failed) {
        keywordCorrelatedFailures.set(kw, (keywordCorrelatedFailures.get(kw) ?? 0) + 1);
      }
    }

    if (triggeredModulesThisEvent.size > 0) {
      for (const kw of unmatchedKeywordsThisEvent) {
        let moduleCounts = keywordModuleCoOccurrence.get(kw);
        if (!moduleCounts) {
          moduleCounts = new Map<string, number>();
          keywordModuleCoOccurrence.set(kw, moduleCounts);
        }
        for (const mod of triggeredModulesThisEvent) {
          moduleCounts.set(mod, (moduleCounts.get(mod) ?? 0) + 1);
        }
      }
    }

    if (failed) {
      for (const mod of res.resolvedModules) {
        loadedCorrelatedFailures.set(mod, (loadedCorrelatedFailures.get(mod) ?? 0) + 1);
      }
    }

    for (const mod of new Set(res.resolvedModules)) {
      const failedEvents = failedConstraintEventsByModule.get(mod);
      if (failedEvents && failedEvents.some((ev) => isJoined(res, ev, windowMinutes))) {
        loadedExactFailures.set(mod, (loadedExactFailures.get(mod) ?? 0) + 1);
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

  const violatedModules = new Set([...loadedCorrelatedFailures.keys(), ...loadedExactFailures.keys()]);
  const loadedButViolated: LoadedButViolatedFinding[] = [...violatedModules]
    .map((module) => ({
      module,
      occurrences: loadedOccurrences.get(module) ?? 0,
      correlatedFailures: loadedCorrelatedFailures.get(module) ?? 0,
      exactFailures: loadedExactFailures.get(module) ?? 0,
    }))
    .sort((a, b) => b.exactFailures - a.exactFailures || b.correlatedFailures - a.correlatedFailures);

  const nearMissKeywordSet = new Set(nearMissKeywords.map((f) => f.keyword));
  const coOccurrenceCandidates: CoOccurrenceCandidate[] = [];
  for (const [keyword, moduleCounts] of keywordModuleCoOccurrence) {
    if (!nearMissKeywordSet.has(keyword)) continue; // below minOccurrences overall
    let topModules: string[] = [];
    let topCount = 0;
    for (const [module, count] of moduleCounts) {
      if (count > topCount) {
        topCount = count;
        topModules = [module];
      } else if (count === topCount) {
        topModules.push(module);
      }
    }
    if (topCount < minOccurrences) continue;
    for (const module of topModules) {
      coOccurrenceCandidates.push({
        keyword,
        module,
        coOccurrences: topCount,
        keywordOccurrences: keywordOccurrences.get(keyword) ?? 0,
        ambiguous: topModules.length > 1,
      });
    }
  }
  coOccurrenceCandidates.sort((a, b) => b.coOccurrences - a.coOccurrences);

  return {
    resolutionEvents: resolutionEvents.length,
    commandEvents: commandEvents.length,
    minOccurrences,
    windowMinutes,
    insufficientData: resolutionEvents.length < minOccurrences,
    deadModules,
    nearMissKeywords,
    loadedButViolated,
    coOccurrenceCandidates,
    sourceFile: sourceFile.replace(/\\/g, '/'),
  };
}

function printReport(report: SuggestReport): void {
  console.log('');
  console.log('  charter adf suggest — diagnostics over ADF module resolution telemetry');
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
    console.log('    Note: failure correlation alone never attributes a keyword to a module — see co-occurrence candidates below for the (weaker) heuristic that does.');
  }
  console.log('');

  console.log('  Loaded-but-violated (module resolved, yet a downstream failure still occurred):');
  if (report.loadedButViolated.length === 0) {
    console.log('    (none)');
  } else {
    for (const f of report.loadedButViolated) {
      const parts: string[] = [];
      if (f.exactFailures > 0) parts.push(`${f.exactFailures} confirmed constraint failure${f.exactFailures === 1 ? '' : 's'}`);
      if (f.correlatedFailures > 0) parts.push(`${f.correlatedFailures} correlated with a downstream failure`);
      console.log(`    [!] ${f.module} — resolved ${f.occurrences}x, ${parts.join(', ')}`);
    }
    console.log('    Note: routing worked; rule content may be weak. Needs human/strong-model rewrite, not a trigger change.');
  }
  console.log('');

  console.log('  Co-occurrence trigger candidates (heuristic — not failure-backed, review before applying):');
  if (report.coOccurrenceCandidates.length === 0) {
    console.log('    (none)');
  } else {
    for (const c of report.coOccurrenceCandidates) {
      const status = c.ambiguous ? ' [ambiguous — tied with another module, no op generated]' : '';
      console.log(`    [?] "${c.keyword}" -> ${c.module} — co-occurs ${c.coOccurrences}/${c.keywordOccurrences}x${status}`);
    }
    console.log('    Run with --emit-ops <file> to write non-ambiguous candidates as REPLACE_BULLET ops for `charter adf patch --ops-file`.');
  }
  console.log('');
  console.log(`  Source: ${report.sourceFile}`);
  console.log('');
}

function printEmitOpsSection(emitResult: EmitOpsResult, emitOpsFile: string | undefined): void {
  if (emitResult.diffLines.length > 0) {
    console.log('  Proposed ops (preview):');
    for (const line of emitResult.diffLines) {
      console.log(line);
    }
    console.log('');
  }
  if (emitResult.skipped.length > 0) {
    console.log('  Skipped candidates:');
    for (const s of emitResult.skipped) {
      console.log(`    [-] "${s.keyword}" -> ${s.module}: ${s.reason}`);
    }
    console.log('');
  }
  if (emitOpsFile) {
    console.log(`  [ok] Wrote ${emitResult.ops.length} op(s) to ${emitOpsFile}`);
    console.log(`       Review, then apply with: charter adf patch .ai/manifest.adf --ops-file ${emitOpsFile}`);
    console.log('');
  }
}

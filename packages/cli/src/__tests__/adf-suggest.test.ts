import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { adfSuggestCommand, buildSuggestReport } from '../commands/adf-suggest';
import type { AdfResolutionEvent, CliTelemetryEvent } from '../telemetry';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-adf-suggest-test-'));
  tempDirs.push(dir);
  return dir;
}

function resolutionEvent(overrides: Partial<AdfResolutionEvent> = {}): AdfResolutionEvent {
  return {
    version: 1,
    eventType: 'adf.resolution',
    timestamp: new Date().toISOString(),
    sessionId: null,
    resolutionId: 'r-1',
    source: 'bundle',
    keywords: [],
    candidateModules: [],
    resolvedModules: [],
    triggerMatches: [],
    ...overrides,
  };
}

function commandEvent(overrides: Partial<CliTelemetryEvent> = {}): CliTelemetryEvent {
  return {
    version: 1,
    eventType: 'command',
    timestamp: new Date().toISOString(),
    commandPath: 'validate',
    flags: [],
    format: 'json',
    ciMode: true,
    durationMs: 10,
    exitCode: 0,
    success: true,
    ...overrides,
  };
}

describe('buildSuggestReport', () => {
  it('flags a dead module once it appears enough times with zero matches', () => {
    const events = Array.from({ length: 3 }, () =>
      resolutionEvent({
        triggerMatches: [{ module: 'classifier.adf', trigger: 'classify', matched: false, matchedKeywords: [], loadReason: 'trigger' }],
      }),
    );
    const report = buildSuggestReport(events, [], 3, 60, 'events.ndjson');
    expect(report.deadModules).toEqual([{ module: 'classifier.adf', occurrences: 3 }]);
  });

  it('does not flag a module below the occurrence threshold', () => {
    const events = [
      resolutionEvent({
        triggerMatches: [{ module: 'classifier.adf', trigger: 'classify', matched: false, matchedKeywords: [], loadReason: 'trigger' }],
      }),
    ];
    const report = buildSuggestReport(events, [], 3, 60, 'events.ndjson');
    expect(report.deadModules).toHaveLength(0);
  });

  it('does not flag a module that matched at least once', () => {
    const events = Array.from({ length: 4 }, (_, i) =>
      resolutionEvent({
        triggerMatches: [
          { module: 'governance.adf', trigger: 'audit', matched: i === 0, matchedKeywords: i === 0 ? ['audit'] : [], loadReason: 'trigger' },
        ],
      }),
    );
    const report = buildSuggestReport(events, [], 3, 60, 'events.ndjson');
    expect(report.deadModules).toHaveLength(0);
  });

  it('reports a recurring keyword that never matches any trigger', () => {
    const events = Array.from({ length: 3 }, () =>
      resolutionEvent({
        keywords: ['widget'],
        triggerMatches: [{ module: 'frontend.adf', trigger: 'react', matched: false, matchedKeywords: [], loadReason: 'trigger' }],
      }),
    );
    const report = buildSuggestReport(events, [], 3, 60, 'events.ndjson');
    expect(report.nearMissKeywords).toEqual([{ keyword: 'widget', occurrences: 3, correlatedFailures: 0 }]);
  });

  it('filters generic stopwords out of the near-miss keyword report', () => {
    const events = Array.from({ length: 4 }, () =>
      resolutionEvent({ keywords: ['the', 'widget'], triggerMatches: [] }),
    );
    const report = buildSuggestReport(events, [], 3, 60, 'events.ndjson');
    expect(report.nearMissKeywords.map((f) => f.keyword)).toEqual(['widget']);
  });

  it('excludes a keyword that matched a trigger at least once, even if unmatched elsewhere', () => {
    const events = [
      resolutionEvent({ keywords: ['audit'], triggerMatches: [{ module: 'governance.adf', trigger: 'audit', matched: true, matchedKeywords: ['audit'], loadReason: 'trigger' }] }),
      resolutionEvent({ keywords: ['audit'], triggerMatches: [] }),
      resolutionEvent({ keywords: ['audit'], triggerMatches: [] }),
    ];
    const report = buildSuggestReport(events, [], 3, 60, 'events.ndjson');
    expect(report.nearMissKeywords.find((f) => f.keyword === 'audit')).toBeUndefined();
  });

  it('joins a resolution to a same-session failing command and counts it as a correlated failure', () => {
    const now = new Date();
    const res = resolutionEvent({
      keywords: ['widget'],
      sessionId: 'sess-1',
      timestamp: now.toISOString(),
      triggerMatches: [{ module: 'frontend.adf', trigger: 'react', matched: false, matchedKeywords: [], loadReason: 'trigger' }],
    });
    const events = [res, res, res];
    const cmds = [commandEvent({ sessionId: 'sess-1', success: false, exitCode: 1, timestamp: new Date(now.getTime() + 1000).toISOString() })];
    const report = buildSuggestReport(events, cmds, 3, 60, 'events.ndjson');
    expect(report.nearMissKeywords).toEqual([{ keyword: 'widget', occurrences: 3, correlatedFailures: 3 }]);
  });

  it('joins by time window when no sessionId is present on either side', () => {
    const now = new Date();
    const res = resolutionEvent({
      keywords: ['widget'],
      timestamp: now.toISOString(),
      triggerMatches: [{ module: 'frontend.adf', trigger: 'react', matched: false, matchedKeywords: [], loadReason: 'trigger' }],
    });
    const events = [res, res, res];
    const cmds = [commandEvent({ success: false, exitCode: 1, timestamp: new Date(now.getTime() + 5 * 60_000).toISOString() })];
    const report = buildSuggestReport(events, cmds, 3, 60, 'events.ndjson');
    expect(report.nearMissKeywords[0].correlatedFailures).toBe(3);
  });

  it('does not join when both sides have sessionIds but they differ, even within the time window', () => {
    const now = new Date();
    const res = resolutionEvent({
      keywords: ['widget'],
      sessionId: 'sess-A',
      timestamp: now.toISOString(),
      triggerMatches: [{ module: 'frontend.adf', trigger: 'react', matched: false, matchedKeywords: [], loadReason: 'trigger' }],
    });
    const events = [res, res, res];
    const cmds = [commandEvent({ sessionId: 'sess-B', success: false, exitCode: 1, timestamp: new Date(now.getTime() + 1000).toISOString() })];
    const report = buildSuggestReport(events, cmds, 3, 60, 'events.ndjson');
    expect(report.nearMissKeywords[0].correlatedFailures).toBe(0);
  });

  it('falls through to the time window when only one side has a sessionId', () => {
    const now = new Date();
    const res = resolutionEvent({
      keywords: ['widget'],
      sessionId: null,
      timestamp: now.toISOString(),
      triggerMatches: [{ module: 'frontend.adf', trigger: 'react', matched: false, matchedKeywords: [], loadReason: 'trigger' }],
    });
    const events = [res, res, res];
    const cmds = [commandEvent({ sessionId: 'sess-only-here', success: false, exitCode: 1, timestamp: new Date(now.getTime() + 1000).toISOString() })];
    const report = buildSuggestReport(events, cmds, 3, 60, 'events.ndjson');
    expect(report.nearMissKeywords[0].correlatedFailures).toBe(3);
  });

  it('respects a widened --window-minutes for the time-window fallback', () => {
    const now = new Date();
    const res = resolutionEvent({
      keywords: ['widget'],
      timestamp: now.toISOString(),
      triggerMatches: [{ module: 'frontend.adf', trigger: 'react', matched: false, matchedKeywords: [], loadReason: 'trigger' }],
    });
    const events = [res, res, res];
    const cmds = [commandEvent({ success: false, exitCode: 1, timestamp: new Date(now.getTime() + 120 * 60_000).toISOString() })];
    const reportNarrow = buildSuggestReport(events, cmds, 3, 60, 'events.ndjson');
    expect(reportNarrow.nearMissKeywords[0].correlatedFailures).toBe(0);
    const reportWide = buildSuggestReport(events, cmds, 3, 180, 'events.ndjson');
    expect(reportWide.nearMissKeywords[0].correlatedFailures).toBe(3);
  });

  it('normalizes keyword case so a capitalized keyword matches its lowercase trigger match', () => {
    const events = [
      resolutionEvent({ keywords: ['Audit'], triggerMatches: [{ module: 'governance.adf', trigger: 'audit', matched: true, matchedKeywords: ['audit'], loadReason: 'trigger' }] }),
      resolutionEvent({ keywords: ['Audit'], triggerMatches: [] }),
      resolutionEvent({ keywords: ['audit'], triggerMatches: [] }),
    ];
    const report = buildSuggestReport(events, [], 3, 60, 'events.ndjson');
    expect(report.nearMissKeywords.find((f) => f.keyword === 'audit' || f.keyword === 'Audit')).toBeUndefined();
  });

  it('does not join a command event that falls outside the time window', () => {
    const now = new Date();
    const res = resolutionEvent({
      keywords: ['widget'],
      timestamp: now.toISOString(),
      triggerMatches: [{ module: 'frontend.adf', trigger: 'react', matched: false, matchedKeywords: [], loadReason: 'trigger' }],
    });
    const events = [res, res, res];
    const cmds = [commandEvent({ success: false, exitCode: 1, timestamp: new Date(now.getTime() + 120 * 60_000).toISOString() })];
    const report = buildSuggestReport(events, cmds, 3, 60, 'events.ndjson');
    expect(report.nearMissKeywords[0].correlatedFailures).toBe(0);
  });

  it('does not join a command event that precedes the resolution event', () => {
    const now = new Date();
    const res = resolutionEvent({
      keywords: ['widget'],
      timestamp: now.toISOString(),
      triggerMatches: [{ module: 'frontend.adf', trigger: 'react', matched: false, matchedKeywords: [], loadReason: 'trigger' }],
    });
    const events = [res, res, res];
    const cmds = [commandEvent({ success: false, exitCode: 1, timestamp: new Date(now.getTime() - 1000).toISOString() })];
    const report = buildSuggestReport(events, cmds, 3, 60, 'events.ndjson');
    expect(report.nearMissKeywords[0].correlatedFailures).toBe(0);
  });

  it('reports loaded-but-violated for a module that resolved yet a downstream command failed', () => {
    const now = new Date();
    const res = resolutionEvent({
      sessionId: 'sess-2',
      timestamp: now.toISOString(),
      resolvedModules: ['governance.adf'],
      triggerMatches: [],
    });
    const cmds = [commandEvent({ sessionId: 'sess-2', success: false, exitCode: 1, timestamp: new Date(now.getTime() + 1000).toISOString() })];
    const report = buildSuggestReport([res], cmds, 1, 60, 'events.ndjson');
    expect(report.loadedButViolated).toEqual([{ module: 'governance.adf', occurrences: 1, correlatedFailures: 1 }]);
  });

  it('does not report loaded-but-violated when nothing downstream failed', () => {
    const res = resolutionEvent({ resolvedModules: ['governance.adf'], triggerMatches: [] });
    const cmds = [commandEvent({ success: true, exitCode: 0 })];
    const report = buildSuggestReport([res], cmds, 1, 60, 'events.ndjson');
    expect(report.loadedButViolated).toHaveLength(0);
  });

  it('flags insufficientData when resolution events are below the threshold', () => {
    const report = buildSuggestReport([], [], 3, 60, 'events.ndjson');
    expect(report.insufficientData).toBe(true);
    expect(report.deadModules).toHaveLength(0);
    expect(report.nearMissKeywords).toHaveLength(0);
    expect(report.loadedButViolated).toHaveLength(0);
    expect(report.coOccurrenceCandidates).toHaveLength(0);
  });

  it('proposes a co-occurrence candidate when an unmatched keyword recurs alongside a genuinely triggered module', () => {
    const events = Array.from({ length: 3 }, () =>
      resolutionEvent({
        keywords: ['widget'],
        triggerMatches: [
          { module: 'frontend.adf', trigger: 'react', matched: true, matchedKeywords: ['react'], loadReason: 'trigger' },
        ],
      }),
    );
    const report = buildSuggestReport(events, [], 3, 60, 'events.ndjson');
    expect(report.coOccurrenceCandidates).toEqual([
      { keyword: 'widget', module: 'frontend.adf', coOccurrences: 3, keywordOccurrences: 3, ambiguous: false },
    ]);
  });

  it('does not propose a co-occurrence candidate for a module that only default-loaded (not genuinely triggered)', () => {
    const events = Array.from({ length: 3 }, () =>
      resolutionEvent({
        keywords: ['widget'],
        resolvedModules: ['core.adf'],
        triggerMatches: [
          { module: 'core.adf', trigger: 'n/a', matched: true, matchedKeywords: [], loadReason: 'default' },
        ],
      }),
    );
    const report = buildSuggestReport(events, [], 3, 60, 'events.ndjson');
    expect(report.coOccurrenceCandidates).toHaveLength(0);
  });

  it('marks a co-occurrence candidate ambiguous when two modules tie for the top count', () => {
    const events = Array.from({ length: 3 }, () =>
      resolutionEvent({
        keywords: ['widget'],
        triggerMatches: [
          { module: 'frontend.adf', trigger: 'react', matched: true, matchedKeywords: ['react'], loadReason: 'trigger' },
          { module: 'backend.adf', trigger: 'api', matched: true, matchedKeywords: ['api'], loadReason: 'trigger' },
        ],
      }),
    );
    const report = buildSuggestReport(events, [], 3, 60, 'events.ndjson');
    expect(report.coOccurrenceCandidates).toHaveLength(2);
    expect(report.coOccurrenceCandidates.every((c) => c.ambiguous)).toBe(true);
  });

  it('does not propose a co-occurrence candidate below the occurrence threshold', () => {
    const events = [
      resolutionEvent({
        keywords: ['widget'],
        triggerMatches: [
          { module: 'frontend.adf', trigger: 'react', matched: true, matchedKeywords: ['react'], loadReason: 'trigger' },
        ],
      }),
    ];
    const report = buildSuggestReport(events, [], 3, 60, 'events.ndjson');
    expect(report.coOccurrenceCandidates).toHaveLength(0);
  });
});

describe('adfSuggestCommand', () => {
  const baseOptions: CLIOptions = {
    configPath: '.charter',
    format: 'json',
    ciMode: false,
    yes: false,
  };

  it('reports insufficientData for a missing telemetry file without crashing', () => {
    const tmp = tmpDir();
    process.chdir(tmp);

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    const exitCode = adfSuggestCommand(baseOptions, []);
    expect(exitCode).toBe(0);
    const report = JSON.parse(logs[0]) as { insufficientData: boolean; resolutionEvents: number };
    expect(report.insufficientData).toBe(true);
    expect(report.resolutionEvents).toBe(0);
  });

  it('reads real events.ndjson and applies --min-occurrences override', () => {
    const tmp = tmpDir();
    process.chdir(tmp);
    const telemetryDir = path.join(tmp, '.charter', 'telemetry');
    fs.mkdirSync(telemetryDir, { recursive: true });

    const res = resolutionEvent({
      triggerMatches: [{ module: 'analysis.adf', trigger: 'blast', matched: false, matchedKeywords: [], loadReason: 'trigger' }],
    });
    fs.writeFileSync(path.join(telemetryDir, 'events.ndjson'), [res, res].map((e) => JSON.stringify(e)).join('\n') + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    const exitCode = adfSuggestCommand(baseOptions, ['--min-occurrences', '2']);
    expect(exitCode).toBe(0);
    const report = JSON.parse(logs[0]) as { deadModules: Array<{ module: string }> };
    expect(report.deadModules).toEqual([{ module: 'analysis.adf', occurrences: 2 }]);
  });

  it('applies --window-minutes to widen the CLI-level join fallback', () => {
    const tmp = tmpDir();
    process.chdir(tmp);
    const telemetryDir = path.join(tmp, '.charter', 'telemetry');
    fs.mkdirSync(telemetryDir, { recursive: true });

    const now = new Date();
    const res = resolutionEvent({
      keywords: ['widget'],
      timestamp: now.toISOString(),
      triggerMatches: [{ module: 'frontend.adf', trigger: 'react', matched: false, matchedKeywords: [], loadReason: 'trigger' }],
    });
    const cmd = commandEvent({ success: false, exitCode: 1, timestamp: new Date(now.getTime() + 120 * 60_000).toISOString() });
    const lines = [res, res, res, cmd].map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(telemetryDir, 'events.ndjson'), lines);

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    const exitCode = adfSuggestCommand(baseOptions, ['--window-minutes', '180']);
    expect(exitCode).toBe(0);
    const report = JSON.parse(logs[0]) as { nearMissKeywords: Array<{ keyword: string; correlatedFailures: number }> };
    expect(report.nearMissKeywords.find((f) => f.keyword === 'widget')?.correlatedFailures).toBe(3);
  });

  it('treats legacy events without an eventType discriminator as command events', () => {
    const tmp = tmpDir();
    process.chdir(tmp);
    const telemetryDir = path.join(tmp, '.charter', 'telemetry');
    fs.mkdirSync(telemetryDir, { recursive: true });

    // Pre-eventType telemetry event, exactly as recordTelemetryEvent wrote
    // it before this feature existed — no eventType field at all.
    const legacyEvent = {
      version: 1,
      timestamp: new Date().toISOString(),
      commandPath: 'validate',
      flags: [],
      format: 'json',
      ciMode: true,
      durationMs: 50,
      exitCode: 1,
      success: false,
    };
    fs.writeFileSync(path.join(telemetryDir, 'events.ndjson'), `${JSON.stringify(legacyEvent)}\n`);

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    const exitCode = adfSuggestCommand(baseOptions, []);
    expect(exitCode).toBe(0);
    const report = JSON.parse(logs[0]) as { resolutionEvents: number; commandEvents: number };
    expect(report.commandEvents).toBe(1);
    expect(report.resolutionEvents).toBe(0);
  });

  it('ignores malformed lines in events.ndjson instead of crashing', () => {
    const tmp = tmpDir();
    process.chdir(tmp);
    const telemetryDir = path.join(tmp, '.charter', 'telemetry');
    fs.mkdirSync(telemetryDir, { recursive: true });
    fs.writeFileSync(path.join(telemetryDir, 'events.ndjson'), 'not json\n{"incomplete":\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    const exitCode = adfSuggestCommand(baseOptions, []);
    expect(exitCode).toBe(0);
    const report = JSON.parse(logs[0]) as { resolutionEvents: number; commandEvents: number };
    expect(report.resolutionEvents).toBe(0);
    expect(report.commandEvents).toBe(0);
  });

  it('prints a human-readable report in text format', () => {
    const tmp = tmpDir();
    process.chdir(tmp);

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    const exitCode = adfSuggestCommand({ ...baseOptions, format: 'text' }, []);
    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toContain('charter adf suggest');
    expect(logs.join('\n')).toContain('Dead modules');
  });

  const MANIFEST_ADF = `ADF: 0.1

📦 DEFAULT_LOAD:
  - core.adf

📂 ON_DEMAND:
  - frontend.adf (Triggers on: React, CSS, UI)
  - backend.adf (Triggers on: API, Node, DB) [budget: 800]
`;

  function writeTelemetry(tmp: string, events: unknown[]): void {
    const telemetryDir = path.join(tmp, '.charter', 'telemetry');
    fs.mkdirSync(telemetryDir, { recursive: true });
    fs.writeFileSync(path.join(telemetryDir, 'events.ndjson'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  it('--emit-ops writes a REPLACE_BULLET op for a non-ambiguous co-occurrence candidate', () => {
    const tmp = tmpDir();
    process.chdir(tmp);
    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), MANIFEST_ADF);

    const res = resolutionEvent({
      keywords: ['widget'],
      triggerMatches: [
        { module: 'frontend.adf', trigger: 'react', matched: true, matchedKeywords: ['react'], loadReason: 'trigger' },
      ],
    });
    writeTelemetry(tmp, [res, res, res]);

    const opsFile = path.join(tmp, 'ops.json');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = adfSuggestCommand(baseOptions, ['--emit-ops', opsFile]);
    expect(exitCode).toBe(0);

    const ops = JSON.parse(fs.readFileSync(opsFile, 'utf-8')) as Array<{ op: string; section: string; index: number; value: string }>;
    expect(ops).toEqual([
      { op: 'REPLACE_BULLET', section: 'ON_DEMAND', index: 0, value: 'frontend.adf (Triggers on: React, CSS, UI, widget)' },
    ]);
  });

  it('merges two different keywords proposed for the same module into a single op, not two ops at the same index', () => {
    const tmp = tmpDir();
    process.chdir(tmp);
    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), MANIFEST_ADF);

    // "gizmo" and "widget" both recur alongside frontend.adf's "react" trigger —
    // applying two separate REPLACE_BULLET ops at the same index in sequence
    // would make the second clobber the first (this regressed once already).
    const res = resolutionEvent({
      keywords: ['gizmo', 'widget'],
      triggerMatches: [
        { module: 'frontend.adf', trigger: 'react', matched: true, matchedKeywords: ['react'], loadReason: 'trigger' },
      ],
    });
    writeTelemetry(tmp, [res, res, res]);

    const opsFile = path.join(tmp, 'ops.json');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = adfSuggestCommand(baseOptions, ['--emit-ops', opsFile]);
    expect(exitCode).toBe(0);

    const ops = JSON.parse(fs.readFileSync(opsFile, 'utf-8')) as Array<{ op: string; section: string; index: number; value: string }>;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ op: 'REPLACE_BULLET', section: 'ON_DEMAND', index: 0, value: 'frontend.adf (Triggers on: React, CSS, UI, gizmo, widget)' });
  });

  it('preserves an existing [budget: n] suffix when emitting an op for that module', () => {
    const tmp = tmpDir();
    process.chdir(tmp);
    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), MANIFEST_ADF);

    const res = resolutionEvent({
      keywords: ['widget'],
      triggerMatches: [
        { module: 'backend.adf', trigger: 'api', matched: true, matchedKeywords: ['api'], loadReason: 'trigger' },
      ],
    });
    writeTelemetry(tmp, [res, res, res]);

    const opsFile = path.join(tmp, 'ops.json');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    adfSuggestCommand(baseOptions, ['--emit-ops', opsFile]);

    const ops = JSON.parse(fs.readFileSync(opsFile, 'utf-8')) as Array<{ value: string }>;
    expect(ops[0].value).toBe('backend.adf (Triggers on: API, Node, DB, widget) [budget: 800]');
  });

  it('writes an empty ops array and reports the skip reason for an ambiguous candidate', () => {
    const tmp = tmpDir();
    process.chdir(tmp);
    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), MANIFEST_ADF);

    const res = resolutionEvent({
      keywords: ['widget'],
      triggerMatches: [
        { module: 'frontend.adf', trigger: 'react', matched: true, matchedKeywords: ['react'], loadReason: 'trigger' },
        { module: 'backend.adf', trigger: 'api', matched: true, matchedKeywords: ['api'], loadReason: 'trigger' },
      ],
    });
    writeTelemetry(tmp, [res, res, res]);

    const opsFile = path.join(tmp, 'ops.json');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    const exitCode = adfSuggestCommand(baseOptions, ['--emit-ops', opsFile]);
    expect(exitCode).toBe(0);

    const ops = JSON.parse(fs.readFileSync(opsFile, 'utf-8')) as unknown[];
    expect(ops).toEqual([]);

    const report = JSON.parse(logs[0]) as { skippedCandidates: Array<{ reason: string }> };
    expect(report.skippedCandidates.length).toBe(2);
    expect(report.skippedCandidates.every((s) => s.reason.includes('ambiguous'))).toBe(true);
  });

  it('does not write an ops file when --emit-ops is not passed, only shows the preview', () => {
    const tmp = tmpDir();
    process.chdir(tmp);
    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), MANIFEST_ADF);

    const res = resolutionEvent({
      keywords: ['widget'],
      triggerMatches: [
        { module: 'frontend.adf', trigger: 'react', matched: true, matchedKeywords: ['react'], loadReason: 'trigger' },
      ],
    });
    writeTelemetry(tmp, [res, res, res]);

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    const exitCode = adfSuggestCommand({ ...baseOptions, format: 'text' }, []);
    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toContain('co-occurs');
    expect(fs.existsSync(path.join(tmp, 'ops.json'))).toBe(false);
  });

  it('respects a custom --ai-dir when locating manifest.adf for --emit-ops', () => {
    const tmp = tmpDir();
    process.chdir(tmp);
    fs.mkdirSync(path.join(tmp, 'custom-ai'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'custom-ai', 'manifest.adf'), MANIFEST_ADF);

    const res = resolutionEvent({
      keywords: ['widget'],
      triggerMatches: [
        { module: 'frontend.adf', trigger: 'react', matched: true, matchedKeywords: ['react'], loadReason: 'trigger' },
      ],
    });
    writeTelemetry(tmp, [res, res, res]);

    const opsFile = path.join(tmp, 'ops.json');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    adfSuggestCommand(baseOptions, ['--ai-dir', 'custom-ai', '--emit-ops', opsFile]);

    const ops = JSON.parse(fs.readFileSync(opsFile, 'utf-8')) as unknown[];
    expect(ops).toHaveLength(1);
  });
});

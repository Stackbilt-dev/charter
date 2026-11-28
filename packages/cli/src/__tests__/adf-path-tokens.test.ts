import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filePathToTokens } from '../commands/adf-path-tokens';
import { adfContextCommand } from '../commands/adf-context';
import type { CLIOptions } from '../index';

// Mirrors this repo's .ai/manifest.adf ON_DEMAND section (#442 routing table).
const CHARTER_MANIFEST = `ADF: 0.1

📦 DEFAULT_LOAD:
  - core.adf
  - state.adf

📂 ON_DEMAND:
  - adf-dev.adf (Triggers on: ADF, parser, formatter, patcher, bundler, metric, weight)
  - governance.adf (Triggers on: validate, drift, audit, trailer, risk, governance)
  - classifier.adf (Triggers on: classifier, routing, auto-route, adf add, classify, rule placement)
  - analysis.adf (Triggers on: blast, surface, dependency graph, blast radius, route extraction, schema extraction)
`;

// Guard fixture: a repo whose triggers are exactly the generic path words.
const GENERIC_TRIGGER_MANIFEST = `ADF: 0.1

📦 DEFAULT_LOAD:
  - core.adf

📂 ON_DEMAND:
  - layout.adf (Triggers on: packages, src, lib, dist, index, main, build)
  - testing.adf (Triggers on: tests, spec, fixtures, mock)
  - formats.adf (Triggers on: ts, js, json, md, yaml)
`;

let tmpDir: string;
let logs: string[];

function runContext(manifest: string, files: string): { keywords: string[]; resolvedModules: string[]; triggerMatches: Array<{ module: string; trigger: string; matched: boolean; matchedKeywords: string[] }> } {
  const aiDir = path.join(tmpDir, '.ai');
  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'manifest.adf'), manifest);
  const options: CLIOptions = { configPath: path.join(tmpDir, '.charter'), format: 'json', ciMode: false, yes: true };
  logs = [];
  const exit = adfContextCommand(options, ['--files', files, '--ai-dir', aiDir]);
  expect(exit).toBe(0);
  return JSON.parse(logs.join('\n'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-path-tokens-'));
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('filePathToTokens', () => {
  it('splits a path into its own tokens and drops generic segments', () => {
    expect(filePathToTokens(['packages/adf/src/manifest.ts'])).toEqual(['adf', 'manifest']);
  });

  it('splits kebab, snake, dot and camelCase names', () => {
    expect(filePathToTokens(['packages/cli/src/commands/adf-migrate.ts'])).toEqual(['cli', 'commands', 'adf', 'migrate']);
    expect(filePathToTokens(['src/route_extraction/DatePicker.test.tsx'])).toEqual(['route', 'extraction', 'date', 'picker']);
  });

  it('handles Windows separators', () => {
    expect(filePathToTokens(['packages\\blast\\src\\index.ts'])).toEqual(['blast']);
  });

  it('drops generic segments, extensions, test dirs, node_modules and numbers', () => {
    expect(filePathToTokens([
      'packages/lib/src/index.ts',
      'dist/main.js',
      'src/__tests__/fixtures/mock.spec.ts',
      'node_modules/types/index.d.ts',
      'build/v2/out.json',
    ])).toEqual(['types', 'v2']);
  });
});

describe('adf context --files path-token routing (#442)', () => {
  const table: Array<[string, string | null]> = [
    ['packages/adf/src/manifest.ts', 'adf-dev.adf'],
    ['packages/cli/src/commands/adf-migrate.ts', 'adf-dev.adf'],
    ['packages/cli/src/commands/validate.ts', 'governance.adf'],
    ['packages/blast/src/index.ts', 'analysis.adf'],
    ['packages/cli/src/commands/serve.ts', null],
    ['packages/cli/src/commands/context-refresh.ts', null],
    ['.github/workflows/ci.yml', null],
  ];

  for (const [file, expected] of table) {
    it(`${file} -> ${expected ?? 'defaults only'}`, () => {
      const out = runContext(CHARTER_MANIFEST, file);
      const onDemand = out.resolvedModules.filter(m => m !== 'core.adf' && m !== 'state.adf');
      expect(out.resolvedModules).toEqual(expect.arrayContaining(['core.adf', 'state.adf']));
      expect(onDemand).toEqual(expected ? [expected] : []);
    });
  }

  it('reports which path token matched which trigger in JSON', () => {
    const out = runContext(CHARTER_MANIFEST, 'packages/adf/src/manifest.ts');
    expect(out.keywords).toEqual(expect.arrayContaining(['adf', 'manifest']));
    const matched = out.triggerMatches.filter(tm => tm.matched);
    expect(matched).toEqual([
      expect.objectContaining({ module: 'adf-dev.adf', trigger: 'ADF', matchedKeywords: ['adf'] }),
    ]);
  });

  it('keeps existing JSON keys', () => {
    const out = runContext(CHARTER_MANIFEST, 'packages/adf/src/manifest.ts');
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['keywords', 'resolvedModules']));
  });

  it('guard: generic path segments never trigger modules', () => {
    const out = runContext(
      GENERIC_TRIGGER_MANIFEST,
      'packages/lib/src/index.ts,dist/main.js,build/index.json,docs/readme.md,config/app.yaml',
    );
    expect(out.resolvedModules).toEqual(['core.adf']);
    expect(out.triggerMatches.filter(tm => tm.matched)).toEqual([]);
  });
});

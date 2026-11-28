/**
 * Regression tests for #438 and #439.
 *
 * #438: MCP getProjectContext must tokenize a task exactly like the CLI, so a
 *       trailing period ("ADF.") does not drop an on-demand module.
 * #439: `charter adf context --bundle` must not join aiDir onto a path the
 *       bundler already resolved ("Module not found: core.adf").
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { adfBundle } from '../commands/adf-bundle';
import { adfContextCommand } from '../commands/adf-context';
import { resolveProjectContext } from '../commands/project-context';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

const jsonOptions: CLIOptions = {
  configPath: '.charter',
  format: 'json',
  ciMode: false,
  yes: false,
};

function makeFixture(aiDirName = '.ai'): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-context-parity-'));
  tempDirs.push(tmp);
  const aiDir = path.join(tmp, aiDirName);
  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'manifest.adf'), `ADF: 0.1

📦 DEFAULT_LOAD:
  - core.adf

📂 ON_DEMAND:
  - adf-dev.adf (Triggers on: ADF, parser)
  - frontend.adf (Triggers on: react, frontend)
`);
  fs.writeFileSync(path.join(aiDir, 'core.adf'), 'ADF: 0.1\n\n📐 RULES:\n  - All changes require tests\n');
  fs.writeFileSync(path.join(aiDir, 'adf-dev.adf'), 'ADF: 0.1\n\n📐 RULES:\n  - ADF package has zero runtime dependencies\n');
  fs.writeFileSync(path.join(aiDir, 'frontend.adf'), 'ADF: 0.1\n\n📐 RULES:\n  - Components use design tokens\n');
  process.chdir(tmp);
  return tmp;
}

function runJson(fn: () => number): { exitCode: number; json: Record<string, unknown> } {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  try {
    const exitCode = fn();
    return { exitCode, json: JSON.parse(logs.join('\n')) as Record<string, unknown> };
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('task tokenization parity: CLI adf bundle vs MCP getProjectContext (#438)', () => {
  const tasks = ['Change module selection for ADF.', 'Change module selection for ADF'];

  it('resolves identical modules with and without a trailing period on both paths', () => {
    makeFixture();
    const resolved = tasks.map(task => {
      const cli = runJson(() => adfBundle(jsonOptions, ['--task', task, '--ai-dir', '.ai']));
      expect(cli.exitCode).toBe(EXIT_CODE.SUCCESS);
      const mcp = resolveProjectContext('.ai', task);
      return { cli: cli.json.resolvedModules, mcp: mcp.bundle.resolvedModules };
    });

    const expected = ['core.adf', 'adf-dev.adf'];
    for (const r of resolved) {
      expect(r.cli).toEqual(expected);
      expect(r.mcp).toEqual(expected);
    }
  });

  it('MCP bundle includes the on-demand rule when the task ends with punctuation', () => {
    makeFixture();
    const { bundle } = resolveProjectContext('.ai', 'Change module selection for ADF.');
    const text = JSON.stringify(bundle.mergedDocument);
    expect(text).toContain('ADF package has zero runtime dependencies');
  });

  it('MCP with no task loads only default modules', () => {
    makeFixture();
    const { keywords, bundle } = resolveProjectContext('.ai');
    expect(keywords).toEqual([]);
    expect(bundle.resolvedModules).toEqual(['core.adf']);
  });
});

describe('adf context --bundle (#439)', () => {
  it('bundles with --files and the default ai dir', () => {
    makeFixture();
    const { exitCode, json } = runJson(() => adfContextCommand(jsonOptions, [
      '--files', 'src/components/Button.tsx', '--bundle',
    ]));
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
    expect(json.resolvedModules).toEqual(['core.adf', 'frontend.adf']);
    expect(json.content).toContain('Components use design tokens');
  });

  it('bundles with --keywords and the default ai dir', () => {
    makeFixture();
    const { exitCode, json } = runJson(() => adfContextCommand(jsonOptions, [
      '--keywords', 'ADF', '--bundle',
    ]));
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
    expect(json.resolvedModules).toEqual(['core.adf', 'adf-dev.adf']);
    expect(json.content).toContain('ADF package has zero runtime dependencies');
  });

  it('bundles with --files and --keywords together (issue repro shape)', () => {
    makeFixture();
    const { exitCode, json } = runJson(() => adfContextCommand(jsonOptions, [
      '--files', 'packages/adf/src/manifest.ts', '--keywords', 'ADF', '--bundle',
    ]));
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
    expect(json.resolvedModules).toEqual(['core.adf', 'adf-dev.adf']);
    expect(typeof json.content).toBe('string');
  });

  it('bundles with --files and a custom --ai-dir', () => {
    makeFixture('governance-ai');
    const { exitCode, json } = runJson(() => adfContextCommand(jsonOptions, [
      '--files', 'src/components/Button.tsx', '--ai-dir', 'governance-ai', '--bundle',
    ]));
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
    expect(json.resolvedModules).toEqual(['core.adf', 'frontend.adf']);
  });

  it('bundles with --keywords and a custom absolute --ai-dir', () => {
    const tmp = makeFixture('custom-ai');
    const { exitCode, json } = runJson(() => adfContextCommand(jsonOptions, [
      '--keywords', 'ADF', '--ai-dir', path.join(tmp, 'custom-ai'), '--bundle',
    ]));
    expect(exitCode).toBe(EXIT_CODE.SUCCESS);
    expect(json.resolvedModules).toEqual(['core.adf', 'adf-dev.adf']);
    expect(json.content).toContain('ADF package has zero runtime dependencies');
  });
});

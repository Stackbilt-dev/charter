import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adfMigrateCommand, discoverAgentConfigFiles } from '../commands/adf-migrate';
import { bootstrapCommand } from '../commands/bootstrap';
import type { CLIOptions } from '../index';

// #343: migrate's default discovery list spelled agents.md in lowercase, so on a
// case-sensitive filesystem a bare `charter adf migrate` never found the AGENTS.md
// bootstrap writes. On a case-insensitive filesystem it was found, but reported
// under the wrong name. Asserting the exact reported name fails either way.

const baseOptions: CLIOptions = {
  configPath: '.charter',
  format: 'text',
  ciMode: false,
  yes: false,
};

const customAgents = '# Agents\n\n## Rules\n\n- Always run the linter before committing.\n';

describe('adf migrate discovery — AGENTS.md casing (#343)', () => {
  let originalCwd: string;
  let tempDir: string;
  let logs: string[];

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-migrate-discovery-'));
    process.chdir(tempDir);
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('discovers AGENTS.md under its canonical name, exactly once', () => {
    fs.writeFileSync('AGENTS.md', customAgents);
    expect(discoverAgentConfigFiles()).toEqual(['AGENTS.md']);
  });

  it('still discovers a legacy lowercase agents.md, exactly once', () => {
    fs.writeFileSync('agents.md', customAgents);
    const found = discoverAgentConfigFiles();
    expect(found).toHaveLength(1);
    expect(found[0].toLowerCase()).toBe('agents.md');
  });

  it('a bare `adf migrate` picks up AGENTS.md without --source', async () => {
    fs.writeFileSync('AGENTS.md', customAgents);

    const exitCode = await adfMigrateCommand({ ...baseOptions, format: 'json' }, ['--dry-run']);
    expect(exitCode).toBe(0);

    const output = JSON.parse(logs.join('\n')) as { sources?: Array<{ source: string }> };
    expect(output.sources?.map(s => s.source)).toEqual(['AGENTS.md']);
  });

  it("bootstrap's migrate phase finds a custom AGENTS.md", async () => {
    fs.writeFileSync('AGENTS.md', customAgents);

    const exitCode = await bootstrapCommand(
      baseOptions,
      ['--preset', 'worker', '--skip-install', '--skip-doctor'],
    );
    expect(exitCode).toBe(0);

    const found = logs.find(l => l.includes('agent config file(s) with migratable content'));
    expect(found).toBeDefined();
    expect(found).toMatch(/migratable content: AGENTS\.md$/);
  });
});

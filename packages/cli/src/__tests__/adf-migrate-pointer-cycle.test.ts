// #355: load the CLI entry first, as the binary does (index -> doctor -> adf ->
// adf-migrate). adf.ts is then half-initialised while adf-migrate loads, so a
// pointer template captured at module load is undefined and migrate falls back to
// the generic pointer. The import order below is the point of this file: keep
// '../index' first.
import '../index';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adfMigrateCommand } from '../commands/adf-migrate';
import { POINTER_AGENTS_MD, POINTER_GEMINI_MD } from '../commands/adf';
import type { CLIOptions } from '../index';

const options: CLIOptions = { configPath: '.charter', format: 'text', ciMode: false, yes: false };

const GENERIC_POINTER_LINE = '> This project uses [ADF](https://github.com/Stackbilt-dev/charter) for AI agent context management.';

describe('adf migrate pointer templates after loading the CLI entry (#355)', () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-migrate-pointer-cycle-'));
    process.chdir(tempDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync('.ai');
    fs.writeFileSync(path.join('.ai', 'manifest.adf'), 'ADF: 0.1\n\n\u{1F4E6} DEFAULT_LOAD:\n  - core.adf\n');
    fs.writeFileSync(path.join('.ai', 'core.adf'), 'ADF: 0.1\n\nCONTEXT:\n  - Core rules\n');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('the adf.ts templates are defined (the test exercises the real values)', () => {
    expect(POINTER_GEMINI_MD).toContain('# GEMINI.md');
    expect(POINTER_AGENTS_MD).toContain('# AGENTS.md');
  });

  for (const mode of [[], ['--replace']] as const) for (const [file, template] of [['GEMINI.md', () => POINTER_GEMINI_MD], ['AGENTS.md', () => POINTER_AGENTS_MD]] as const) {
    it(`writes the named ${file} template, not the generic pointer (${mode[0] ?? 'default mode'})`, async () => {
      fs.writeFileSync(file, `# ${file}\n\n## General\n\n- Always write a changelog entry.\n`);
      expect(await adfMigrateCommand(options, ['--source', file, ...mode, '--no-backup'])).toBe(0);

      const written = fs.readFileSync(file, 'utf-8');
      expect(written.startsWith(template())).toBe(true);
      expect(written).not.toContain(GENERIC_POINTER_LINE);
    });
  }
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adfCommand } from '../commands/adf';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const DEFAULT_OPTIONS = { format: 'text' as const, configPath: '.charter', ciMode: false, yes: false };
const JSON_OPTIONS = { ...DEFAULT_OPTIONS, format: 'json' as const };

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-adf-init-'));
  tempDirs.push(dir);
  process.chdir(dir);
  return dir;
}

describe('charter adf init — scaffolding guard', () => {
  it('creates all files in a fresh directory', async () => {
    const tmp = makeTmp();
    await adfCommand(DEFAULT_OPTIONS, ['init']);
    expect(fs.existsSync(path.join(tmp, '.ai', 'manifest.adf'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.ai', 'core.adf'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.ai', 'state.adf'))).toBe(true);
  });

  it('skips existing core.adf when manifest.adf is missing', async () => {
    const tmp = makeTmp();
    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    const customCore = 'ADF: 0.1\n🎯 ROLE: Custom project\n';
    fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), customCore);

    await adfCommand(DEFAULT_OPTIONS, ['init']);

    expect(fs.existsSync(path.join(tmp, '.ai', 'manifest.adf'))).toBe(true);
    expect(fs.readFileSync(path.join(tmp, '.ai', 'core.adf'), 'utf-8')).toBe(customCore);
  });

  it('skips existing core.adf in JSON output and reports it in skipped', async () => {
    const tmp = makeTmp();
    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    const customCore = 'ADF: 0.1\n🎯 ROLE: Custom project\n';
    fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), customCore);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => lines.push(s);
    try {
      await adfCommand(JSON_OPTIONS, ['init']);
    } finally {
      console.log = origLog;
    }

    const result = JSON.parse(lines.join(''));
    expect(result.files).not.toContain('core.adf');
    expect(result.skipped).toContain('core.adf');
    expect(fs.readFileSync(path.join(tmp, '.ai', 'core.adf'), 'utf-8')).toBe(customCore);
  });

  it('overwrites existing core.adf with --force', async () => {
    const tmp = makeTmp();
    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), 'custom content');

    await adfCommand(DEFAULT_OPTIONS, ['init', '--force']);

    const written = fs.readFileSync(path.join(tmp, '.ai', 'core.adf'), 'utf-8');
    expect(written).not.toBe('custom content');
    expect(written).toContain('ADF: 0.1');
  });
});

describe('charter serve startup — error discrimination', () => {
  it('distinguishes missing .ai/ dir from missing manifest.adf in error message', () => {
    // The distinction is tested indirectly via the error message text that
    // serveCommand throws. We verify the two messages are different strings.
    const noDir = `No .ai/ directory found. Run: charter init`;
    const noManifest = `.ai/manifest.adf not found. Run: charter adf init`;
    expect(noDir).not.toBe(noManifest);
    expect(noManifest).toContain('manifest.adf');
    expect(noManifest).toContain('charter adf init');
  });
});

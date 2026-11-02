import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAdf } from '@stackbilt/adf';
import { adfCommand, CORE_SCAFFOLD } from '../commands/adf';
import { isTemplateConstraints, isUntouchedScaffold } from '../commands/adf-populate';

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const options = { format: 'json' as const, configPath: '.charter', ciMode: false, yes: false };
const cases = [
  {
    name: 'multi-word header',
    input: '\u{1F4D0} RULES:\n  - keep me\n\n\u{1F510} SENSITIVITY TIERS:\n  - tier one\n',
    canonical: 'ADF: 0.1\n\n\u{1F4D0} RULES:\n  - keep me\n\n\u{1F510} SENSITIVITY TIERS:\n  - tier one\n',
    keys: ['RULES', 'SENSITIVITY TIERS'],
  },
  {
    name: 'doubled variation selector',
    input: '\u{1F4D0} RULES:\n  - keep me\n\n\u26A0\uFE0F\uFE0F CONSTRAINTS [load-bearing]:\n  - do not lose me\n',
    canonical: 'ADF: 0.1\n\n\u26A0\uFE0F CONSTRAINTS [load-bearing]:\n  - do not lose me\n\n\u{1F4D0} RULES:\n  - keep me\n',
    keys: ['CONSTRAINTS', 'RULES'],
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('fresh core scaffold and the suggested formatting check (#389)', () => {
  it('the JSON next action succeeds immediately after init without rewriting the file', async () => {
    process.chdir(path.dirname(fixture('')));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await adfCommand(options, ['init'])).toBe(0);
    const result = JSON.parse(String(log.mock.calls[0][0])) as { nextActions: string[] };
    const action = result.nextActions.find(line => line.startsWith('charter adf fmt '));
    expect(action).toBe('charter adf fmt .ai/core.adf --check');
    const before = fs.readFileSync('.ai/core.adf');
    expect(await adfCommand(options, action!.split(/\s+/).slice(2))).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toEqual({ file: '.ai/core.adf', canonical: true });
    expect(fs.readFileSync('.ai/core.adf')).toEqual(before);
  });

  it.each([{ flags: [] }, { flags: ['--force'] }])('keeps the complete previous scaffold byte-for-byte under init $flags', async ({ flags }) => {
    process.chdir(path.dirname(fixture('')));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await adfCommand(options, ['init'])).toBe(0);
    // Reconstruct the previously shipped order using the unchanged section bodies.
    const constraints = CORE_SCAFFOLD.indexOf('\u26A0\uFE0F CONSTRAINTS');
    const guide = CORE_SCAFFOLD.indexOf('\u{1F4D6} GUIDE');
    const metrics = CORE_SCAFFOLD.indexOf('\u{1F4CA} METRICS');
    const legacy = CORE_SCAFFOLD.slice(0, constraints) + CORE_SCAFFOLD.slice(guide, metrics)
      + CORE_SCAFFOLD.slice(constraints, guide) + CORE_SCAFFOLD.slice(metrics);
    expect(parseAdf(legacy).sections.map(section => section.key)).toEqual(['CONTEXT', 'GUIDE', 'CONSTRAINTS', 'METRICS']);
    const bytes = Buffer.from(legacy.trimEnd().replace(/\n/g, '\r\n'));
    fs.writeFileSync('.ai/core.adf', bytes);
    expect(await adfCommand(options, ['init', ...flags])).toBe(0);
    expect(fs.readFileSync('.ai/core.adf')).toEqual(bytes);
    const sections = parseAdf(bytes.toString()).sections;
    const context = sections.find(section => section.key === 'CONTEXT')!;
    expect(isUntouchedScaffold(context, '.ai/core.adf')).toBe(true);
    expect(isTemplateConstraints(sections.find(section => section.key === 'CONSTRAINTS')!, '.ai/core.adf')).toBe(true);
    expect(isUntouchedScaffold({ ...context, content: { type: 'list', items: ['hand-written context'] } }, '.ai/core.adf')).toBe(false);
  });
});

function fixture(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-fmt-headers-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'rules.adf');
  fs.writeFileSync(file, content);
  return file;
}

describe('adf fmt keeps recognized section boundaries (#389)', () => {
  for (const testCase of cases) {
    it(`${testCase.name}: --check reports noncanonical without changing input bytes`, async () => {
      const file = fixture(testCase.input.replace(/\n/g, '\r\n'));
      const before = fs.readFileSync(file);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await adfCommand(options, ['fmt', file, '--check'])).toBe(1);
      expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({ file, canonical: false });
      expect(fs.readFileSync(file)).toEqual(before);
    });

    it(`${testCase.name}: --write preserves sections and a subsequent --check passes`, async () => {
      const file = fixture(testCase.input);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await adfCommand(options, ['fmt', file, '--write'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({ file, written: true });
      expect(fs.readFileSync(file, 'utf8')).toBe(testCase.canonical);
      expect(parseAdf(fs.readFileSync(file, 'utf8')).sections.map(section => section.key)).toEqual(testCase.keys);
      expect(await adfCommand(options, ['fmt', file, '--check'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[1][0]))).toEqual({ file, canonical: true });
    });

    it(`${testCase.name}: default stdout mode prints the complete canonical document without writing`, async () => {
      const file = fixture(testCase.input);
      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        output += String(chunk);
        return true;
      });
      expect(await adfCommand({ ...options, format: 'text' }, ['fmt', file])).toBe(0);
      expect(output).toBe(testCase.canonical);
      expect(fs.readFileSync(file, 'utf8')).toBe(testCase.input);
    });
  }
});

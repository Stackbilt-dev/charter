import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAdf } from '@stackbilt/adf';
import { adfCommand } from '../commands/adf';

const tempDirs: string[] = [];
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
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
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

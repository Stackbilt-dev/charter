/**
 * `charter init --guided` and non-interactive stdin (#375).
 *
 * Guided mode refuses up front, before printing a question or writing a file,
 * when stdin is not a TTY or the output format is not text. A stdin that hits
 * EOF (Ctrl-D) mid-questionnaire aborts with a non-zero exit instead of
 * leaving the CLI to exit 0 with nothing written.
 *
 * The real node:readline runs here, over a PassThrough standing in for
 * process.stdin, so the EOF test exercises readline's own 'close' behaviour.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';

let input = new PassThrough();
let output = new PassThrough();
vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:readline')>();
  return {
    ...actual,
    createInterface: (opts: { input: unknown; output: unknown }) =>
      actual.createInterface({ ...opts, input, output, terminal: false }),
  };
});

import { initCommand } from '../commands/init';

const TEXT: CLIOptions = { configPath: '.charter', format: 'text', ciMode: false, yes: false };
const JSON_OPTS: CLIOptions = { ...TEXT, format: 'json' };

let out: string[] = [];
let errOut: string[] = [];
let tempDir = '';
const originalCwd = process.cwd();

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

/** Answer each question as readline prints it; end stdin once `answers` runs out. */
function answerWith(answers: string[]): void {
  const queue = [...answers];
  // readline writes each prompt to `output` as one chunk; nothing else goes there.
  output.on('data', () => {
    const next = queue.shift();
    if (next === undefined) input.end();
    else input.write(`${next}\n`);
  });
}

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'charter-375-')));
  process.chdir(tempDir);
  input = new PassThrough();
  output = new PassThrough();
  out = [];
  errOut = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errOut.push(a.map(String).join(' ')); });
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  setTTY(undefined);
});

describe('init --guided with a non-interactive stdin (#375)', () => {
  for (const isTTY of [undefined, false]) {
    it(`refuses up front when stdin.isTTY is ${String(isTTY)}: exit 1, nothing written, names the alternative`, async () => {
      setTTY(isTTY);
      const asked: string[] = [];
      output.on('data', (c: Buffer) => asked.push(c.toString()));
      expect(await initCommand(TEXT, ['--guided'])).toBe(1);
      expect(fs.readdirSync('.')).toEqual([]);
      expect(out).toEqual([]);
      expect(asked).toEqual([]);
      const msg = errOut.join('\n');
      expect(msg).toContain('needs an interactive terminal');
      expect(msg).toContain('Nothing was written');
      expect(msg).toContain('charter init --preset');
    });
  }

  it('refuses even with answers waiting on the pipe (they are never read)', async () => {
    setTTY(undefined);
    input.write('typescript\ny\ny\n');
    expect(await initCommand(TEXT, ['--guided', '--force'])).toBe(1);
    expect(fs.existsSync('.charter')).toBe(false);
  });

  it('refuses --format json with one JSON error document, on a TTY or not', async () => {
    for (const isTTY of [true, undefined]) {
      setTTY(isTTY);
      out = [];
      expect(await initCommand(JSON_OPTS, ['--guided'])).toBe(1);
      const r = JSON.parse(out.join('\n'));
      expect(r).toMatchObject({ guided: true, writesPerformed: 0, errorCode: 'GUIDED_REQUIRES_TEXT' });
      expect(r.error).toContain('--format json');
      expect(r.error).toContain('charter init --preset');
      expect(fs.readdirSync('.')).toEqual([]);
    }
  });
});

describe('init --guided on a TTY', () => {
  it('EOF before the first answer: exit 1, "Aborted; nothing was written.", nothing written', async () => {
    setTTY(true);
    answerWith([]);
    expect(await initCommand(TEXT, ['--guided'])).toBe(1);
    expect(errOut).toContain('Aborted; nothing was written.');
    expect(fs.readdirSync('.')).toEqual([]);
  });

  it('EOF mid-questionnaire (Ctrl-D after one answer): exit 1, nothing written', async () => {
    setTTY(true);
    answerWith(['typescript']);
    expect(await initCommand(TEXT, ['--guided'])).toBe(1);
    expect(errOut).toContain('Aborted; nothing was written.');
    expect(fs.readdirSync('.')).toEqual([]);
  });

  it('EOF before the last answer: exit 1, nothing written', async () => {
    setTTY(true);
    answerWith(['typescript', 'y']);
    expect(await initCommand(TEXT, ['--guided'])).toBe(1);
    expect(fs.readdirSync('.')).toEqual([]);
  });

  it('happy path is unchanged: three answers scaffold .charter/ and exit 0', async () => {
    setTTY(true);
    answerWith(['typescript', 'y', 'y']);
    expect(await initCommand(TEXT, ['--guided'])).toBe(0);
    expect(errOut).toEqual([]);
    expect(out).toContain('  ✓ Created .charter/ directory');
    expect(out).toContain('    Preset: worker (with Cloudflare Workers)');
    expect(out).toContain('    Auth governance: enabled');
    expect(JSON.parse(fs.readFileSync('.charter/patterns/blessed-stack.json', 'utf-8')).preset).toBe('worker');
    expect(fs.readFileSync('.charter/policies/governance.md', 'utf-8')).toContain('## Auth Governance');
  });

  it('happy path with defaults: an unknown language and blank answers pick fullstack', async () => {
    setTTY(true);
    answerWith(['cobol', '', '']);
    expect(await initCommand(TEXT, ['--guided'])).toBe(0);
    expect(out).toContain('    Preset: fullstack');
    expect(fs.readFileSync('.charter/policies/governance.md', 'utf-8')).not.toContain('## Auth Governance');
  });
});

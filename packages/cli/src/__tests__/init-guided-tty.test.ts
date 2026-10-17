/**
 * `charter init --guided` and stdin that is piped, closed or interrupted (#375).
 *
 * Guided mode reads its answers as a queue of lines, so piped answers work
 * like typed ones. If stdin closes before every answer has arrived, it prints
 * `Aborted; nothing was written.` and exits 1 (130 for Ctrl-C) with nothing
 * written. `--format json` is refused up front. `promptYesNo` treats a close
 * before the answer as N.
 *
 * The real node:readline runs here, over a PassThrough standing in for
 * process.stdin, so EOF goes through readline's own 'line' / 'close' events.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type * as readlineTypes from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';

let input = new PassThrough();
let output = new PassThrough();
let lastRl: readlineTypes.Interface | null = null;
/** true: run readline in terminal mode over a fake TTY, so raw keystrokes (\x03, \x04) go through its key handling. */
let terminalMode = false;
vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:readline')>();
  return {
    ...actual,
    createInterface: (opts: { input: unknown; output: unknown }) => {
      if (terminalMode) {
        Object.assign(input, { isTTY: true, setRawMode: () => input, isRaw: false });
        Object.assign(output, { isTTY: true, columns: 120, rows: 40 });
      }
      lastRl = actual.createInterface({ ...opts, input, output, terminal: terminalMode });
      return lastRl;
    },
  };
});

import { run } from '../index';
import { initCommand } from '../commands/init';
import { promptYesNo } from '../commands/adf-scaffold-write';

const TEXT: CLIOptions = { configPath: '.charter', format: 'text', ciMode: false, yes: false };
const JSON_OPTS: CLIOptions = { ...TEXT, format: 'json' };

let out: string[] = [];
let errOut: string[] = [];
let tempDir = '';
const originalCwd = process.cwd();

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

/** Type each answer when its prompt appears, as a person would; end stdin once `answers` runs out. */
function typeAnswers(answers: string[]): void {
  const queue = [...answers];
  // readline writes each prompt to `output` as one chunk; nothing else goes there.
  output.on('data', () => {
    const next = queue.shift();
    if (next === undefined) input.end();
    else input.write(`${next}\n`);
  });
}

/** Everything a pipe would deliver, written before the command starts, then EOF. */
function pipeAnswers(text: string): void {
  output.resume();
  input.end(text);
}

/** Every file under the cwd except the CLI usage log, relative path -> bytes (blessed-stack's generatedAt blanked). */
function tree(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files[p.split(path.sep).join('/')] = fs.readFileSync(p, 'utf-8').replace(/"generatedAt": "[^"]*"/, '"generatedAt": ""');
    }
  };
  walk('.');
  return files;
}

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'charter-375-')));
  process.chdir(tempDir);
  input = new PassThrough();
  output = new PassThrough();
  lastRl = null;
  terminalMode = false;
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

describe('init --guided answers', () => {
  it('typed on a TTY: three answers scaffold .charter/ and exit 0 (unchanged)', async () => {
    setTTY(true);
    typeAnswers(['typescript', 'y', 'y']);
    expect(await initCommand(TEXT, ['--guided'])).toBe(0);
    expect(errOut).toEqual([]);
    expect(out).toContain('  ✓ Created .charter/ directory');
    expect(out).toContain('    Preset: worker (with Cloudflare Workers)');
    expect(out).toContain('    Auth governance: enabled');
    expect(JSON.parse(fs.readFileSync('.charter/patterns/blessed-stack.json', 'utf-8')).preset).toBe('worker');
    expect(fs.readFileSync('.charter/policies/governance.md', 'utf-8')).toContain('## Auth Governance');
  });

  it('fully piped answers write the same files as a typed TTY run', async () => {
    setTTY(true);
    typeAnswers(['typescript', 'y', 'y']);
    expect(await initCommand(TEXT, ['--guided'])).toBe(0);
    const typed = tree();
    fs.rmSync('.charter', { recursive: true });

    setTTY(undefined);
    input = new PassThrough();
    output = new PassThrough();
    out = [];
    pipeAnswers('typescript\ny\ny\n');
    expect(await initCommand(TEXT, ['--guided'])).toBe(0);
    expect(errOut).toEqual([]);
    expect(tree()).toEqual(typed);
    expect(out).toContain('    Preset: worker (with Cloudflare Workers)');
  });

  it('piped answers with CRLF line endings and no final newline work', async () => {
    pipeAnswers('python\r\nn\r\nn');
    expect(await initCommand(TEXT, ['--guided'])).toBe(0);
    expect(out).toContain('    Preset: backend');
    expect(fs.readFileSync('.charter/policies/governance.md', 'utf-8')).not.toContain('## Auth Governance');
  });

  it('defaults: an unknown language and blank answers pick fullstack', async () => {
    pipeAnswers('cobol\n\n\n');
    expect(await initCommand(TEXT, ['--guided'])).toBe(0);
    expect(out).toContain('    Preset: fullstack');
  });

  it('--preset seeds the default used when the language names no known stack', async () => {
    const asked: string[] = [];
    output.on('data', (c: Buffer) => asked.push(c.toString()));
    input.end('\nn\nn\n');
    expect(await initCommand(TEXT, ['--guided', '--preset', 'docs'])).toBe(0);
    expect(asked[0]).toContain('blank keeps --preset docs');
    expect(out).toContain('    Preset: docs');
    expect(JSON.parse(fs.readFileSync('.charter/patterns/blessed-stack.json', 'utf-8')).preset).toBe('docs');
  });

  it('a recognized language or a Cloudflare yes still decides over --preset', async () => {
    pipeAnswers('react\nn\nn\n');
    expect(await initCommand(TEXT, ['--guided', '--preset', 'docs'])).toBe(0);
    expect(out).toContain('    Preset: frontend');
  });
});

describe('init --guided when stdin closes before every answer (#375)', () => {
  const expectAborted = (): void => {
    expect(errOut).toContain('Aborted; nothing was written.');
    expect(fs.readdirSync('.')).toEqual([]);
  };

  it('</dev/null (EOF before any answer): exit 1, nothing written', async () => {
    pipeAnswers('');
    expect(await initCommand(TEXT, ['--guided'])).toBe(1);
    expectAborted();
  });

  it('`echo y |` (one answer, then EOF): exit 1, nothing written', async () => {
    pipeAnswers('y\n');
    expect(await initCommand(TEXT, ['--guided', '--force'])).toBe(1);
    expectAborted();
  });

  it('two piped answers, then EOF: exit 1, nothing written', async () => {
    pipeAnswers('typescript\ny\n');
    expect(await initCommand(TEXT, ['--guided'])).toBe(1);
    expectAborted();
  });

  it('a short pipe leaves an existing .charter/ untouched', async () => {
    fs.mkdirSync('.charter');
    fs.writeFileSync('.charter/config.json', '{"hand":"edited"}\n');
    pipeAnswers('typescript\n');
    expect(await initCommand(TEXT, ['--guided', '--force'])).toBe(1);
    expect(fs.readdirSync('.charter')).toEqual(['config.json']);
    expect(fs.readFileSync('.charter/config.json', 'utf-8')).toBe('{"hand":"edited"}\n');
  });

  for (const typed of [[], ['typescript'], ['typescript', 'y']]) {
    it(`TTY: Ctrl-D after ${typed.length} answer(s): exit 1, nothing written`, async () => {
      setTTY(true);
      typeAnswers(typed);
      expect(await initCommand(TEXT, ['--guided'])).toBe(1);
      expectAborted();
    });
  }

  it('readline SIGINT event mid-questionnaire: exit 130, nothing written', async () => {
    setTTY(true);
    output.on('data', () => { lastRl?.emit('SIGINT'); });
    expect(await initCommand(TEXT, ['--guided'])).toBe(130);
    expectAborted();
  });
});

describe('init --guided with readline in terminal mode (raw keystrokes over a fake TTY)', () => {
  let screen = '';
  beforeEach(() => {
    terminalMode = true;
    setTTY(true);
    screen = '';
    output.on('data', (c: Buffer) => { screen += c.toString(); });
  });

  /** Wait until the screen shows `text` (readline repaints asynchronously), then send `keys`. */
  async function when(text: string, keys: string): Promise<void> {
    for (let i = 0; i < 500 && !screen.includes(text); i++) await new Promise(r => setImmediate(r));
    expect(screen).toContain(text);
    input.write(keys);
  }

  it('typed answers with Enter (\\r) scaffold .charter/ and exit 0', async () => {
    const run = initCommand(TEXT, ['--guided']);
    await when('framework?', 'go\r');
    expect(lastRl?.terminal).toBe(true);
    await when('Cloudflare Workers?', 'n\r');
    await when('auth governance', 'y\r');
    expect(await run).toBe(0);
    expect(out).toContain('    Preset: backend');
    expect(fs.readFileSync('.charter/policies/governance.md', 'utf-8')).toContain('## Auth Governance');
  });

  it('Ctrl-C (\\x03) at the second question: exit 130, "Aborted; nothing was written.", nothing written', async () => {
    const run = initCommand(TEXT, ['--guided']);
    await when('framework?', 'typescript\r');
    await when('Cloudflare Workers?', '\x03');
    expect(await run).toBe(130);
    expect(errOut).toContain('Aborted; nothing was written.');
    expect(fs.readdirSync('.')).toEqual([]);
  });

  it('Ctrl-D (\\x04) on an empty line: exit 1, nothing written', async () => {
    const run = initCommand(TEXT, ['--guided']);
    await when('framework?', 'typescript\r');
    await when('Cloudflare Workers?', '\x04');
    expect(await run).toBe(1);
    expect(errOut).toContain('Aborted; nothing was written.');
    expect(fs.readdirSync('.')).toEqual([]);
  });

  it('Ctrl-D after typed text deletes a character instead of aborting', async () => {
    const run = initCommand(TEXT, ['--guided']);
    // "gox", cursor left, Ctrl-D deletes the "x" under the cursor: the answer is "go".
    await when('framework?', 'gox\x1b[D\x04\r');
    await when('Cloudflare Workers?', 'n\r');
    await when('auth governance', 'n\r');
    expect(await run).toBe(0);
    expect(out).toContain('    Preset: backend');
  });
});

describe('init --guided --format json', () => {
  it('is refused up front with one JSON error document, on a TTY or not', async () => {
    for (const isTTY of [true, undefined]) {
      setTTY(isTTY);
      out = [];
      const asked: string[] = [];
      output.on('data', (c: Buffer) => asked.push(c.toString()));
      expect(await initCommand(JSON_OPTS, ['--guided'])).toBe(1);
      const r = JSON.parse(out.join('\n'));
      expect(r).toMatchObject({ guided: true, writesPerformed: 0, errorCode: 'GUIDED_REQUIRES_TEXT' });
      expect(r.error).toContain('--format json');
      expect(r.error).toContain('charter init --preset');
      expect(asked).toEqual([]);
      expect(fs.readdirSync('.')).toEqual([]);
    }
  });
});

describe('init --guided --ci', () => {
  it('is refused up front: exit 1, nothing asked or written, message names the alternative', async () => {
    setTTY(true);
    const asked: string[] = [];
    output.on('data', (c: Buffer) => asked.push(c.toString()));
    expect(await initCommand({ ...TEXT, ciMode: true }, ['--guided'])).toBe(1);
    expect(asked).toEqual([]);
    expect(out).toEqual([]);
    expect(errOut.join('\n')).toContain('cannot run with --ci');
    expect(errOut.join('\n')).toContain('charter init --preset');
    expect(fs.readdirSync('.')).toEqual([]);
  });

  it('under --format json --ci the JSON refusal wins', async () => {
    expect(await initCommand({ ...JSON_OPTS, ciMode: true }, ['--guided'])).toBe(1);
    expect(JSON.parse(out.join('\n')).errorCode).toBe('GUIDED_REQUIRES_TEXT');
  });
});

describe('promptYesNo', () => {
  it('Ctrl-C in terminal mode prints "Aborted." and exits the process with 130', async () => {
    terminalMode = true;
    setTTY(true);
    // The mocked exit returns, so the prompt's promise is left unsettled, as the real process would be gone.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let settled = false;
    void promptYesNo('Register these modules now? (y/N) ').then(() => { settled = true; });
    output.once('data', () => input.write('\x03'));
    for (let i = 0; i < 500 && exit.mock.calls.length === 0; i++) await new Promise(r => setImmediate(r));
    expect(exit).toHaveBeenCalledWith(130);
    expect(errOut).toContain('Aborted.');
    expect(errOut).not.toContain('  No answer (input closed); treating it as N.');
    expect(settled).toBe(false);
  });

  it('Ctrl-D (\\x04) on an empty line in terminal mode is N with the note, not an exit', async () => {
    terminalMode = true;
    setTTY(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const answer = promptYesNo('Replace them? (y/N) ');
    output.once('data', () => input.write('\x04'));
    expect(await answer).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    expect(errOut).toContain('  No answer (input closed); treating it as N.');
  });

  it('stdin closing before an answer is N, with a note on stderr', async () => {
    setTTY(true);
    output.on('data', () => input.end());
    expect(await promptYesNo('Register these modules now? (y/N) ')).toBe(false);
    expect(errOut).toContain('  No answer (input closed); treating it as N.');
  });

  it('y is still yes, with no note', async () => {
    setTTY(true);
    output.on('data', () => input.write('y\n'));
    expect(await promptYesNo('Replace them? (y/N) ')).toBe(true);
    expect(errOut).toEqual([]);
  });

  it('a non-TTY stdin is still N without asking', async () => {
    setTTY(undefined);
    expect(await promptYesNo('Replace them? (y/N) ')).toBe(false);
    expect(lastRl).toBeNull();
  });
});

describe('help text', () => {
  it('lists all six presets for init and setup', async () => {
    expect(await run(['--help'])).toBe(0);
    const help = out.join('\n');
    const presets = '<worker|frontend|backend|fullstack|docs|rust-wasm>';
    expect(help).toContain(`charter init [--preset ${presets}]`);
    expect(help).toContain(`charter setup [--ci github] [--preset ${presets}]`);
    expect(help).toContain('Stack preset: worker, frontend, backend, fullstack, docs, rust-wasm');
  });
});

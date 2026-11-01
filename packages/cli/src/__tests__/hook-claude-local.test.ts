import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hookCommand, printClaudeHookConfig } from '../commands/hook';
import type { CLIOptions } from '../index';

const options: CLIOptions = { configPath: '.charter', format: 'json', ciMode: false, yes: false };
const originalCwd = process.cwd();
let tempDir: string;
let output: string[];

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function readCommand(): string {
  const config = JSON.parse(output.at(-1)!);
  expect(Object.keys(config.hooks)).toEqual(['UserPromptSubmit']);
  expect(config.hooks.UserPromptSubmit).toHaveLength(1);
  expect(config.hooks.UserPromptSubmit[0].matcher).toBe('.*');
  expect(config.hooks.UserPromptSubmit[0].hooks[0].type).toBe('command');
  return config.hooks.UserPromptSubmit[0].hooks[0].command;
}

function runPrintedNpmCommand() {
  printClaudeHookConfig();
  const [manager, ...args] = readCommand().split(' ');
  expect(manager).toBe('npm');
  const nodeDir = path.dirname(fs.realpathSync(process.execPath));
  const npmCli = [path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js'),
    path.join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')].find(file => fs.existsSync(file));
  expect(npmCli, 'Node installation must include npm for this integration check').toBeDefined();
  write('.test-npmrc', '');
  // Invoke real npm with exactly the printed arguments, with no global Node bin
  // directory on PATH. The local executable fixture uses an absolute Node path.
  const env = { ...process.env, npm_config_offline: 'true', npm_config_cache: path.join(tempDir, 'empty-cache'),
    npm_config_userconfig: path.join(tempDir, '.test-npmrc') };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key as keyof typeof env];
  Object.assign(env, { PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot!, 'System32') : '/usr/bin:/bin' });
  return spawnSync(process.execPath, [npmCli!, ...args], { encoding: 'utf8', timeout: 15000, env });
}

describe('#400 printed Claude hooks use the installed project CLI', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter claude local-'));
    process.chdir(tempDir);
    output = [];
    vi.spyOn(console, 'log').mockImplementation(value => { output.push(String(value)); });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each([
    ['npm@11.6.2', undefined, 'npm exec --no --package=@stackbilt/cli -- charter'],
    ['pnpm@10.34.6+sha512.example', undefined, 'pnpm exec charter'],
    ['yarn@4.9.1', undefined, 'yarn run charter'],
    [undefined, 'pnpm-lock.yaml', 'pnpm exec charter'],
    [undefined, 'yarn.lock', 'yarn run charter'],
    [undefined, '.pnp.cjs', 'yarn run charter'],
    [undefined, undefined, 'npm exec --no --package=@stackbilt/cli -- charter'],
    ['npm@11.6.2', 'pnpm-lock.yaml', 'npm exec --no --package=@stackbilt/cli -- charter'],
    ['pnpm@invalid', 'yarn.lock', 'yarn run charter'],
    [42, undefined, 'npm exec --no --package=@stackbilt/cli -- charter'],
    ['bun@1.2.3', 'pnpm-lock.yaml', 'pnpm exec charter'],
  ])('uses %s / %s without changing the hook event', async (packageManager, marker, expected) => {
    write('package.json', JSON.stringify({ packageManager }));
    if (marker) write(marker, '');
    const before = fs.readdirSync('.');
    expect(await hookCommand(options, ['print', '--claude'])).toBe(0);
    expect(readCommand()).toBe(`${expected} context-refresh --once`);
    expect(fs.readdirSync('.')).toEqual(before);
    expect(fs.existsSync('.claude')).toBe(false);
  });

  it('uses Yarn PnP config before a stale pnpm lock when no manager is declared', () => {
    write('.yarnrc.yml', 'nodeLinker: "pnp" # workspace\n');
    write('pnpm-lock.yaml', '');
    printClaudeHookConfig();
    expect(readCommand()).toBe('yarn run charter context-refresh --once');
  });

  it('uses lockfile fallback when package.json is malformed without writing it', () => {
    write('package.json', '{ invalid\r\n');
    write('pnpm-lock.yaml', '');
    printClaudeHookConfig();
    expect(readCommand()).toBe('pnpm exec charter context-refresh --once');
    expect(fs.readFileSync('package.json', 'utf8')).toBe('{ invalid\r\n');
  });

  it('runs the local installed CLI through real npm with no global Node bin on PATH', () => {
    write('package.json', JSON.stringify({ name: 'consumer', devDependencies: { '@stackbilt/cli': '2.1.0' } }));
    write('node_modules/@stackbilt/cli/package.json', JSON.stringify({ name: '@stackbilt/cli', version: '2.1.0', bin: { charter: 'bin.cjs' } }));
    const fixture = path.join(tempDir, 'node_modules/@stackbilt/cli/bin.cjs');
    write(fixture, 'console.log(JSON.stringify({local: true, args: process.argv.slice(2)}));\n');
    write('node_modules/.bin/charter.cmd', `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
    write('node_modules/.bin/charter', `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    fs.chmodSync('node_modules/.bin/charter', 0o755);
    const result = runPrintedNpmCommand();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ local: true, args: ['context-refresh', '--once'] });
  });

  it('refuses a missing local CLI in an empty offline cache without installing anything', () => {
    write('package.json', JSON.stringify({ name: 'consumer' }));
    const result = runPrintedNpmCommand();
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ENOTCACHED|cancel(?:ed|led)|offline/i);
    expect(fs.existsSync('node_modules/@stackbilt/cli')).toBe(false);
    expect(fs.existsSync('package-lock.json')).toBe(false);
  });
});

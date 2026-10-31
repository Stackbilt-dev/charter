import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapCommand } from '../commands/bootstrap';
import type { CLIOptions } from '../index';

const options: CLIOptions = { configPath: '.charter', format: 'json', ciMode: false, yes: true };
const args = ['--yes', '--preset', 'worker', '--skip-install', '--skip-doctor'];
const read = () => JSON.parse(fs.readFileSync('.mcp.json', 'utf8'));
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

describe('#399 bootstrap MCP uses the installed project CLI', () => {
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-mcp-local-'));
    process.chdir(tempDir);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each([
    ['npm@11.6.2', undefined, 'npm', ['exec', '--no', '--package=@stackbilt/cli', '--', 'charter']],
    ['pnpm@10.34.6+sha512.example', undefined, 'pnpm', ['exec', 'charter']],
    ['yarn@4.9.1', undefined, 'yarn', ['run', 'charter']],
    [undefined, 'pnpm-lock.yaml', 'pnpm', ['exec', 'charter']],
    [undefined, 'yarn.lock', 'yarn', ['run', 'charter']],
    [undefined, undefined, 'npm', ['exec', '--no', '--package=@stackbilt/cli', '--', 'charter']],
  ])('resolves %s / %s without an npx fetch', async (packageManager, lock, command, prefix) => {
    write('package.json', JSON.stringify({ name: 'consumer', ...(packageManager ? { packageManager } : {}) }));
    if (lock) write(lock, '');
    expect(await bootstrapCommand(options, args)).toBe(0);
    expect(read().mcpServers.charter).toEqual({ command, args: [...prefix, 'serve', '--ai-dir', '.ai'] });
    expect(read().mcpServers.charter.command).not.toBe('npx');
  });

  it('keeps an existing legacy entry, custom AI directory and other servers without force', async () => {
    const existing = '{ "mcpServers": { "charter": { "command": "npx", "args": ["@stackbilt/cli", "serve", "--ai-dir", "custom-ai"], "env": { "KEEP": "yes" } }, "other": { "command": "custom-server" } } }\r\n';
    write('.mcp.json', existing);
    write('package.json', JSON.stringify({ packageManager: 'pnpm@10.34.6' }));
    expect(await bootstrapCommand(options, args)).toBe(0);
    expect(fs.readFileSync('.mcp.json', 'utf8')).toBe(existing);
    expect(fs.existsSync('.charter/.backup')).toBe(false);
  });

  it.each([42, { name: 'pnpm' }])('ignores a non-string packageManager declaration (%j)', async packageManager => {
    write('package.json', JSON.stringify({ packageManager }));
    expect(await bootstrapCommand(options, args)).toBe(0);
    expect(read().mcpServers.charter.command).toBe('npm');
  });

  it('backs up a legacy entry before a forced upgrade using the custom config directory', async () => {
    const existing = JSON.stringify({ rootSetting: true, mcpServers: {
      charter: { command: 'npx', args: ['@stackbilt/cli', 'serve', '--ai-dir', '.ai'] },
      other: { command: 'custom-server' },
    } });
    write('.mcp.json', existing);
    write('package.json', JSON.stringify({ packageManager: 'pnpm@10.34.6' }));
    expect(await bootstrapCommand({ ...options, configPath: '.governance' }, [...args, '--force'])).toBe(0);
    expect(read().mcpServers.charter).toEqual({ command: 'pnpm', args: ['exec', 'charter', 'serve', '--ai-dir', '.ai'] });
    expect(read().mcpServers.other).toEqual({ command: 'custom-server' });
    expect(read().rootSetting).toBe(true);
    const backups = fs.readdirSync('.governance/.backup').filter(f => f.startsWith('mcp.json.'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join('.governance/.backup', backups[0]), 'utf8')).toBe(existing);
  });

  it('leaves its new generated entry byte-for-byte unchanged on a second run', async () => {
    expect(await bootstrapCommand(options, args)).toBe(0);
    const existing = fs.readFileSync('.mcp.json', 'utf8');
    expect(await bootstrapCommand(options, args)).toBe(0);
    expect(fs.readFileSync('.mcp.json', 'utf8')).toBe(existing);
    expect(fs.existsSync('.charter/.backup')).toBe(false);
  });

  it('fails with no local CLI in an empty offline npm cache instead of installing one', async () => {
    expect(await bootstrapCommand(options, args)).toBe(0);
    const server = read().mcpServers.charter;
    write('.test-npmrc', '');
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', server.args, {
      encoding: 'utf8', shell: process.platform === 'win32', timeout: 15000,
      env: { ...process.env, npm_config_offline: 'true', npm_config_cache: path.join(tempDir, 'empty-cache'),
        npm_config_userconfig: path.join(tempDir, '.test-npmrc') },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ENOTCACHED|cancel(?:ed|led)|offline/i);
    expect(fs.existsSync('node_modules/@stackbilt/cli')).toBe(false);
    expect(fs.existsSync('package-lock.json')).toBe(false);
  });
});

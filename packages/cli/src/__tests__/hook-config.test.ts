import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hookCommand } from '../commands/hook';
import type { CLIOptions } from '../index';

const options: CLIOptions = { configPath: '.charter', format: 'json', ciMode: false, yes: false };
const strict = { git: { requireTrailers: true }, validation: { citationStrictness: 'FAIL' } };
const off = { git: { requireTrailers: false } };
const cli = path.resolve(__dirname, '../../dist/bin.js');

describe('installed commit-msg hook config selection (#341)', () => {
  let previousCwd: string;
  let repo: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-hook-config-'));
    process.chdir(repo);
    execFileSync('git', ['init'], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Hook Test']);
    execFileSync('git', ['config', 'user.email', 'hook@test.invalid']);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(previousCwd);
    expect(path.resolve(repo).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)).toBe(true);
    fs.rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function config(dir: string, value: unknown): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(value));
  }

  async function install(dir: string, force = false): Promise<void> {
    expect(await hookCommand({ ...options, configPath: dir }, ['install', '--commit-msg', ...(force ? ['--force'] : [])])).toBe(0);
  }

  function commit(message = 'chore: test policy') {
    return spawnSync('git', ['commit', '--allow-empty', '-q', '-m', message], { encoding: 'utf8' });
  }

  function content(): string {
    return fs.readFileSync(path.join(repo, '.git/hooks/commit-msg'), 'utf8');
  }

  it('enforces the selected strict policy instead of a permissive default', { timeout: 30000 }, async () => {
    config('.charter', off);
    config('governance', strict);
    await install('governance');

    expect(commit().status).toBe(1);
    expect(commit('chore: linked\n\nGoverned-By: ADR-341').status).toBe(0);
    expect(execFileSync('git', ['log', '-1', '--format=%B'], { encoding: 'utf8' })).toContain('Governed-By: ADR-341');
  });

  it('honors a selected disabled policy instead of the strict default', { timeout: 30000 }, async () => {
    config('.charter', strict);
    config('governance', off);
    await install('governance');
    expect(commit().status).toBe(0);
  });

  it('does not fall back when the selected config is missing and names it in the existing skip warning', { timeout: 30000 }, async () => {
    config('.charter', strict);
    await install('missing-policy');
    const result = commit();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('no missing-policy/config.json; trailer gate skipped');
  });

  it('applies validate defaults to a malformed selected file and identifies that file', { timeout: 30000 }, async () => {
    config('.charter', off);
    fs.mkdirSync('governance');
    fs.writeFileSync('governance/config.json', '{');
    await install('governance');
    const result = commit();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('governance/config.json is unparseable; applying the defaults');
  });

  it('treats spaces, apostrophes and shell substitutions as literal path characters', { timeout: 30000 }, async () => {
    const dir = "policy's $(touch injected) `touch injected2`";
    config(dir, strict);
    await install(dir);
    expect(commit().status).toBe(1);
    expect(commit('chore: linked\n\nResolves-Request: 341').status).toBe(0);
    expect(fs.existsSync('injected')).toBe(false);
    expect(fs.existsSync('injected2')).toBe(false);
  });

  it('passes a leading-dash directory to node as an argument rather than an option', { timeout: 30000 }, async () => {
    config('--policy', strict);
    await install('--policy');
    expect(commit().status).toBe(1);
    expect(commit('chore: linked\n\nGoverned-By: ADR-341').status).toBe(0);
  });

  it('retains an absolute config selection', { timeout: 30000 }, async () => {
    const absolute = path.join(repo, 'absolute policy');
    config(absolute, strict);
    await install(absolute);
    expect(content()).toContain(absolute.replace(/\\/g, '/'));
    expect(commit().status).toBe(1);
    expect(commit('chore: linked\n\nGoverned-By: ADR-341').status).toBe(0);
  });

  it.skipIf(process.platform === 'win32').each(['relative', 'absolute'] as const)(
    'preserves literal POSIX backslashes in a %s selection and on reinstall',
    { timeout: 30000 },
    async kind => {
      const dir = 'policy\\name';
      config('.charter', off);
      config(dir, strict);
      const selected = kind === 'absolute' ? path.join(repo, dir) : dir;
      await install(selected);
      const installed = content();
      expect(installed).toContain(`config_file='${selected}/config.json'`);
      expect(commit().status).toBe(1);
      expect(commit('chore: linked\n\nGoverned-By: ADR-341').status).toBe(0);
      await install(selected);
      expect(content()).toBe(installed);
      expect(commit().status).toBe(1);
    },
  );

  it('records relative selections from an installation subdirectory for execution at git root', { timeout: 30000 }, async () => {
    fs.mkdirSync('subdir');
    process.chdir(path.join(repo, 'subdir'));
    config('policy', strict);
    await install('policy');
    process.chdir(repo);
    expect(content()).toContain("config_file='subdir/policy/config.json'");
    expect(commit().status).toBe(1);
    expect(commit('chore: linked\n\nGoverned-By: ADR-341').status).toBe(0);
  });

  it('is deterministic on reinstall and can restore the default selection', { timeout: 30000 }, async () => {
    config('.charter', off);
    config('governance', strict);
    await install('governance');
    const first = content();
    await install('governance');
    expect(content()).toBe(first);
    expect(commit().status).toBe(1);
    await install('.charter');
    expect(content()).toContain("config_file='.charter/config.json'");
    expect(commit().status).toBe(0);
  });

  it('upgrades a legacy managed normalizer with the selected policy', { timeout: 30000 }, async () => {
    config('governance', strict);
    await install('.charter');
    fs.writeFileSync(path.join(repo, '.git/hooks/commit-msg'), '#!/bin/sh\n# Managed by Charter: commit-msg trailer normalizer\nexit 0\n');
    await install('governance');
    expect(content()).toContain('Charter commit-msg trailer gate');
    expect(commit().status).toBe(1);
  });

  it('preserves an unmanaged hook unless force is explicit', { timeout: 30000 }, async () => {
    config('governance', strict);
    await install('.charter');
    const custom = '#!/bin/sh\n# User hook\nexit 0\n';
    fs.writeFileSync(path.join(repo, '.git/hooks/commit-msg'), custom);
    await install('governance');
    expect(content()).toBe(custom);
    await install('governance', true);
    expect(content()).toContain("config_file='governance/config.json'");
    expect(commit().status).toBe(1);
  });

  it('wires the global CLI --config argument into the installed hook', { timeout: 30000 }, () => {
    config('.charter', off);
    config('cli-policy', strict);
    const result = spawnSync(process.execPath, [cli, 'hook', 'install', '--commit-msg', '--config', 'cli-policy', '--format', 'json'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('INSTALLED');
    expect(commit().status).toBe(1);
  });
});

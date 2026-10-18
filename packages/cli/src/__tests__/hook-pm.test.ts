/**
 * #366: the generated pre-commit hook runs every Charter call through the repo's
 * package manager. These tests run the real hook text with stub yarn / pnpm /
 * npx / npm executables first on PATH; each stub records its argv to a log and
 * exits 0 (or the code STUB_FAIL_ON names). No network, no real package manager.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOOK_CLI, PRE_COMMIT_HOOK_CONTENT, PRE_COMMIT_PM_CLI_MARKER } from '../commands/hook';

const shAvailable = (() => {
  const probe = spawnSync('sh', ['-c', 'exit 0']);
  return !probe.error && probe.status === 0;
})();

const PMS = ['yarn', 'pnpm', 'npx', 'npm'] as const;
type Pm = typeof PMS[number];

// Each stub logs "<name>" then each argument in brackets, so an empty argument
// stays visible. yarn answers --version with $STUB_YARN_VERSION. A stub exits 1
// when its joined argv contains $STUB_FAIL_ON. `npm run` also logs whether the
// scope token reached it.
function stubScript(name: Pm): string {
  return `#!/bin/sh
{
  printf '%s' '${name}'
  for a in "$@"; do printf ' [%s]' "$a"; done
  if [ "${name}" = "npm" ] || [ "${name}" = "yarn" ] || [ "${name}" = "pnpm" ]; then
    if [ "\${1:-}" = "run" ] && [ -n "\${CHARTER_HOOK_SCOPED_DOCTOR:-}" ]; then printf ' token-set'; fi
  fi
  printf '\\n'
} >> "$STUB_LOG"
if [ "${name}" = "yarn" ] && [ "\${1:-}" = "--version" ]; then
  echo "\${STUB_YARN_VERSION:-4.5.0}"
  exit 0
fi
if [ -n "\${STUB_FAIL_ON:-}" ]; then
  case "$*" in
    *"$STUB_FAIL_ON"*) echo "${name}: stub failure" >&2; exit 1 ;;
  esac
fi
exit 0
`;
}

/** PATH entries that hold none of the package-manager binaries (any Windows extension). */
function pathWithoutPms(): string {
  const exts = ['', '.cmd', '.exe', '.ps1', '.bat'];
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(dir => dir && !PMS.some(pm => exts.some(ext => fs.existsSync(path.join(dir, pm + ext)))))
    .join(path.delimiter);
}

interface Fixture {
  files?: Record<string, string>;
  stubs?: Pm[];
  yarnVersion?: string;
  failOn?: string;
  /** Use a PATH with every real package manager removed, so only the stubs exist. */
  isolatePath?: boolean;
}

interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
}

describe.skipIf(!shAvailable)('pre-commit hook resolves Charter through the package manager (#366)', { timeout: 30_000 }, () => {
  let dir: string;
  let stubDir: string;
  let logFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-hook-pm-'));
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-hook-pm-bin-'));
    logFile = path.join(stubDir, 'calls.log');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
    fs.mkdirSync(path.join(dir, '.ai'));
    fs.writeFileSync(path.join(dir, '.ai', 'manifest.adf'), 'ADF: 0.1\n');
    // A staged, hand-written vendor file, so the tidy block calls the CLI too.
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Project\n\nSome notes.\n');
    execFileSync('git', ['add', 'CLAUDE.md'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'hook.sh'), PRE_COMMIT_HOOK_CONTENT);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  function runHook(fx: Fixture): HookRun {
    for (const [name, content] of Object.entries(fx.files ?? {})) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    for (const pm of fx.stubs ?? PMS) {
      const stub = path.join(stubDir, pm);
      fs.writeFileSync(stub, stubScript(pm));
      fs.chmodSync(stub, 0o755);
    }
    const basePath = fx.isolatePath ? pathWithoutPms() : (process.env.PATH ?? '');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${stubDir}${path.delimiter}${basePath}`,
      STUB_LOG: logFile,
      STUB_YARN_VERSION: fx.yarnVersion ?? '4.5.0',
      STUB_FAIL_ON: fx.failOn ?? '',
    };
    delete env.CHARTER_HOOK_SCOPED_DOCTOR;
    const result = spawnSync('sh', ['hook.sh'], { cwd: dir, env, encoding: 'utf-8' });
    const calls = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean)
      : [];
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  }

  /** The three CLI calls a manifest repo without verify:adf makes, prefixed by the runner. */
  function expectedCalls(runner: string): string[] {
    return [
      `${runner} [adf] [tidy] [--dry-run] [--print-paths] [--source] [CLAUDE.md]`,
      `${runner} [doctor] [--adf-only] [--ci] [--staged] [--tidy-skipped] [] [--format] [text]`,
      `${runner} [adf] [evidence] [--auto-measure] [--ci]`,
    ];
  }

  const withoutVersionProbe = (calls: string[]): string[] => calls.filter(c => c !== 'yarn [--version]');

  it('the generated hook carries the #366 marker and never calls a bare npx charter', () => {
    expect(PRE_COMMIT_HOOK_CONTENT).toContain(PRE_COMMIT_PM_CLI_MARKER);
    expect(PRE_COMMIT_HOOK_CONTENT).not.toMatch(/npx charter/);
    // Outside echo lines, Charter is only ever reached through charter_cli.
    const code = PRE_COMMIT_HOOK_CONTENT.split('\n').filter(l => !/^\s*(#|echo )/.test(l));
    const direct = code.filter(l => /\bcharter (adf|doctor)\b/.test(l) && !l.includes(HOOK_CLI) && !l.includes('GENERATED by charter adf compile'));
    expect(direct).toEqual([]);
  });

  it('Yarn Berry PnP (.pnp.cjs): yarn charter for every call', () => {
    const run = runHook({ files: { 'yarn.lock': '', '.pnp.cjs': '' } });
    expect(run.status).toBe(0);
    expect(run.calls).toContain('yarn [--version]');
    expect(withoutVersionProbe(run.calls)).toEqual(expectedCalls('yarn [charter]'));
    expect(run.stderr).not.toContain('Warning');
  });

  it('Yarn PnP from .yarnrc.yml alone (nodeLinker: pnp, not installed yet): yarn charter', () => {
    const run = runHook({ files: { '.yarnrc.yml': 'nodeLinker: pnp\n' } });
    expect(run.status).toBe(0);
    expect(withoutVersionProbe(run.calls)).toEqual(expectedCalls('yarn [charter]'));
  });

  it('Yarn classic (yarn.lock, yarn 1.x): yarn --silent charter, so no run banner reaches the tidy plan', () => {
    const run = runHook({ files: { 'yarn.lock': '' }, yarnVersion: '1.22.22' });
    expect(run.status).toBe(0);
    expect(withoutVersionProbe(run.calls)).toEqual(expectedCalls('yarn [--silent] [charter]'));
  });

  it('pnpm (pnpm-lock.yaml): pnpm exec charter', () => {
    const run = runHook({ files: { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" } });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(expectedCalls('pnpm [exec] [charter]'));
  });

  it.each([
    ['package-lock.json', { 'package-lock.json': '{}' }],
    ['no lockfile', {}],
  ])('npm (%s): npx --no-install charter, which never downloads a package', (_label, files) => {
    const run = runHook({ files });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(expectedCalls('npx [--no-install] [charter]'));
  });

  it.each([
    ['yarn PnP', { 'yarn.lock': '', '.pnp.cjs': '' }, 'yarn [charter]', 'yarn [run] [verify:adf] token-set'],
    ['pnpm', { 'pnpm-lock.yaml': '' }, 'pnpm [exec] [charter]', 'pnpm [run] [verify:adf] token-set'],
    ['npm', {}, 'npx [--no-install] [charter]', 'npm [run] [verify:adf] token-set'],
  ])('verify:adf repo (%s): scoped doctor through the package manager, then <pm> run verify:adf with the token', (_label, files, runner, verify) => {
    const run = runHook({ files: { ...files, 'package.json': JSON.stringify({ scripts: { 'verify:adf': 'charter doctor --adf-only --ci' } }) } });
    expect(run.status).toBe(0);
    expect(withoutVersionProbe(run.calls)).toEqual([...expectedCalls(runner).slice(0, 2), verify]);
  });

  it('a failing doctor blocks the commit and the hint names the resolved command', () => {
    const run = runHook({ files: { 'pnpm-lock.yaml': '' }, failOn: 'doctor' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('[pre-commit] ADF verification FAILED.');
    expect(run.stdout).toContain('  Run: pnpm exec charter doctor --adf-only --ci --staged --format text');
    expect(run.stdout).toContain('add @stackbilt/cli as a devDependency');
  });

  describe('package manager binary missing from PATH', () => {
    // Needs a PATH with git and the POSIX tools but no real package manager.
    const isolatedOk = (() => {
      if (!shAvailable) return false;
      const probe = spawnSync('sh', ['-c', 'command -v git && command -v sed && command -v grep && command -v date && ! command -v yarn && ! command -v pnpm'], {
        env: { ...process.env, PATH: pathWithoutPms() },
      });
      return !probe.error && probe.status === 0;
    })();

    it.skipIf(!isolatedOk)('Yarn PnP without yarn: warns (with the corepack fix) and falls back to npx --no-install', () => {
      const run = runHook({ files: { 'yarn.lock': '', '.pnp.cjs': '' }, stubs: ['npx', 'npm'], isolatePath: true });
      expect(run.status).toBe(0);
      expect(run.stderr).toContain('[pre-commit] Warning: this repo uses yarn, but yarn is not on PATH; running Charter with npx --no-install (and verify:adf with npm) instead.');
      expect(run.stderr).toContain('corepack enable');
      expect(run.calls).toEqual(expectedCalls('npx [--no-install] [charter]'));
    });

    it.skipIf(!isolatedOk)('pnpm repo without pnpm: warns and falls back to npx --no-install / npm run', () => {
      const run = runHook({
        files: { 'pnpm-lock.yaml': '', 'package.json': JSON.stringify({ scripts: { 'verify:adf': 'x' } }) },
        stubs: ['npx', 'npm'],
        isolatePath: true,
      });
      expect(run.status).toBe(0);
      expect(run.stderr).toContain('this repo uses pnpm, but pnpm is not on PATH');
      expect(run.stderr).not.toContain('corepack enable');
      expect(run.calls).toEqual([...expectedCalls('npx [--no-install] [charter]').slice(0, 2), 'npm [run] [verify:adf] token-set']);
    });
  });

  it('prints no package-manager warning and makes no call without .ai/manifest.adf', () => {
    fs.rmSync(path.join(dir, '.ai'), { recursive: true });
    const run = runHook({ files: { 'yarn.lock': '' }, stubs: ['npx', 'npm'], isolatePath: true });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.calls).toEqual([]);
  });
});

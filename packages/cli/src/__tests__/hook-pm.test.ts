/**
 * #366: the generated pre-commit hook runs every Charter call through the repo's
 * package manager. These tests run the real hook text with stub yarn / pnpm /
 * npx / npm / charter executables first on PATH; each stub records its argv to a
 * log and exits 0 (or fails as the fixture asks). No network, no real package manager.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HOOK_CLI,
  HOOK_CLI_COMMANDS,
  HOOK_CLI_RESOLVE_BLOCK,
  PNP_MARKER_FILES,
  PRE_COMMIT_HOOK_CONTENT,
  PRE_COMMIT_PM_CLI_MARKER,
  YARNRC_PNP_LINKER_ERE,
  yarnrcPnpLinkerRegExp,
} from '../commands/hook';

const shAvailable = (() => {
  const probe = spawnSync('sh', ['-c', 'exit 0']);
  return !probe.error && probe.status === 0;
})();

const STUBS = ['yarn', 'pnpm', 'npx', 'npm', 'charter'] as const;
type Stub = typeof STUBS[number];

/** A HOOK_CLI_COMMANDS entry the way the stub log shows it: "<bin> [arg] [arg]...". */
const logged = (command: string): string => {
  const [bin, ...args] = command.split(' ');
  return [bin, ...args.map(a => `[${a}]`)].join(' ');
};
const NPM = logged(HOOK_CLI_COMMANDS.npm);
const PNPM = logged(HOOK_CLI_COMMANDS.pnpm);
const YARN = logged(HOOK_CLI_COMMANDS.yarn);
const YARN1 = logged(HOOK_CLI_COMMANDS.yarn1);
const GLOBAL = logged(HOOK_CLI_COMMANDS.global);

// Each stub logs "<name>" then each argument in brackets, so an empty argument
// stays visible. yarn answers a leading --version with $STUB_YARN_VERSION.
// A Charter invocation (the charter stub itself, or argv naming charter or
// @stackbilt/cli) exits 127 when $STUB_UNRESOLVED is 1, as if the CLI were not
// installed, and answers --version with $STUB_CHARTER_VERSION. Any other call
// exits 1 when its joined argv contains $STUB_FAIL_ON.
// `<pm> run` also logs whether the scope token reached it.
function stubScript(name: Stub): string {
  return `#!/bin/sh
{
  printf '%s' '${name}'
  for a in "$@"; do printf ' [%s]' "$a"; done
  if [ "\${1:-}" = "run" ] && [ -n "\${CHARTER_HOOK_SCOPED_DOCTOR:-}" ]; then printf ' token-set'; fi
  printf '\\n'
} >> "$STUB_LOG"
if [ "${name}" = "yarn" ] && [ "\${1:-}" = "--version" ]; then
  echo "\${STUB_YARN_VERSION:-4.5.0}"
  exit 0
fi
is_charter=0
[ "${name}" = "charter" ] && is_charter=1
case " $* " in
  *" charter "*|*" @stackbilt/cli "*) is_charter=1 ;;
esac
if [ "$is_charter" = "1" ]; then
  if [ "\${STUB_UNRESOLVED:-0}" = "1" ]; then echo "${name}: charter: command not found" >&2; exit 127; fi
  case " $* " in
    *" --version "*)
      if [ "\${STUB_VERSION_FAIL:-0}" = "1" ]; then echo "Error: Cannot find module 'commander'" >&2; exit 1; fi
      echo "\${STUB_CHARTER_VERSION:-charter v2.1.0}"; exit 0 ;;
    *" --dry-run "*)
      if [ -n "\${STUB_TIDY_NOTE:-}" ]; then echo "\${STUB_TIDY_NOTE}" >&2; fi ;;
  esac
fi
if [ -n "\${STUB_FAIL_ON:-}" ]; then
  case "$*" in
    *"$STUB_FAIL_ON"*) echo "${name}: stub failure" >&2; exit 1 ;;
  esac
fi
exit 0
`;
}

/** PATH entries that hold none of the stubbed binaries (any Windows extension). */
function pathWithoutPms(): string {
  const exts = ['', '.cmd', '.exe', '.ps1', '.bat'];
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(dir => dir && !STUBS.some(pm => exts.some(ext => fs.existsSync(path.join(dir, pm + ext)))))
    .join(path.delimiter);
}

// Needs a PATH with git and the POSIX tools but no real package manager or charter.
const isolatedOk = (() => {
  if (!shAvailable) return false;
  const probe = spawnSync('sh', ['-c', 'command -v git && command -v sed && command -v grep && command -v date && ! command -v yarn && ! command -v pnpm && ! command -v npm && ! command -v charter'], {
    env: { ...process.env, PATH: pathWithoutPms() },
  });
  return !probe.error && probe.status === 0;
})();

/** A local npm install, as the hook detects it. */
const LOCAL_BIN = { 'node_modules/.bin/charter': '#!/bin/sh\n' };

interface Fixture {
  files?: Record<string, string>;
  stubs?: Stub[];
  yarnVersion?: string;
  charterVersion?: string;
  failOn?: string;
  unresolved?: boolean;
  /** --version exits 1 with an error on stderr (an installed but broken CLI). */
  versionFails?: boolean;
  /** A line the tidy dry run writes to stderr. */
  tidyNote?: string;
  /** Write node_modules/.bin/charter (a local install). Default true. */
  localBin?: boolean;
  /** Use a PATH with every real package manager and charter removed, so only the stubs exist. */
  isolatePath?: boolean;
  /** Hook text to run instead of PRE_COMMIT_HOOK_CONTENT (mutation checks). */
  hook?: string;
}

interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
}

/** The four lines of the PM cascade that pick yarn for PnP and pnpm for pnpm-lock.yaml. */
const PNP_THEN_PNPM = `if [ "$CHARTER_PNP" = "1" ] && command -v yarn >/dev/null 2>&1; then
  PM=yarn
elif [ -f "pnpm-lock.yaml" ] && command -v pnpm >/dev/null 2>&1; then
  PM=pnpm
`;
const PNPM_THEN_YARN_LOCK = `elif [ -f "pnpm-lock.yaml" ] && command -v pnpm >/dev/null 2>&1; then
  PM=pnpm
elif [ -f "yarn.lock" ] && command -v yarn >/dev/null 2>&1; then
  PM=yarn
`;

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
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  function runHook(fx: Fixture): HookRun {
    fs.writeFileSync(path.join(dir, 'hook.sh'), fx.hook ?? PRE_COMMIT_HOOK_CONTENT);
    const files = { ...(fx.localBin === false ? {} : LOCAL_BIN), ...(fx.files ?? {}) };
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    for (const pm of fx.stubs ?? STUBS.filter(s => s !== 'charter')) {
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
      STUB_CHARTER_VERSION: fx.charterVersion ?? 'charter v2.1.0',
      STUB_FAIL_ON: fx.failOn ?? '',
      STUB_VERSION_FAIL: fx.versionFails ? '1' : '0',
      STUB_TIDY_NOTE: fx.tidyNote ?? '',
      STUB_UNRESOLVED: fx.unresolved ? '1' : '0',
    };
    delete env.CHARTER_HOOK_SCOPED_DOCTOR;
    delete env.CHARTER_SKIP_TIDY;
    const result = spawnSync('sh', ['hook.sh'], { cwd: dir, env, encoding: 'utf-8' });
    const calls = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean)
      : [];
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  }

  /** The probe and the three CLI calls a manifest repo without verify:adf makes, prefixed by the runner. */
  function expectedCalls(runner: string): string[] {
    return [
      `${runner} [--version]`,
      `${runner} [adf] [tidy] [--dry-run] [--print-paths] [--source] [CLAUDE.md]`,
      `${runner} [doctor] [--adf-only] [--ci] [--staged] [--tidy-skipped] [] [--format] [text]`,
      `${runner} [adf] [evidence] [--auto-measure] [--ci]`,
    ];
  }

  const withoutYarnVersion = (calls: string[]): string[] => calls.filter(c => c !== 'yarn [--version]');

  it('the generated hook carries the #366 marker and never resolves the bare name charter through npx/npm', () => {
    expect(PRE_COMMIT_HOOK_CONTENT).toContain(PRE_COMMIT_PM_CLI_MARKER);
    expect(PRE_COMMIT_HOOK_CONTENT).not.toMatch(/npx/);
    expect(PRE_COMMIT_HOOK_CONTENT).not.toMatch(/\bnpm exec[^\n]*\bcharter\b/);
    // Outside echo lines, Charter is only ever reached through charter_cli.
    const code = PRE_COMMIT_HOOK_CONTENT.split('\n').filter(l => !/^\s*(#|echo )/.test(l));
    const direct = code.filter(l => /\bcharter (adf|doctor)\b/.test(l) && !l.includes(HOOK_CLI) && !l.includes('GENERATED by charter adf compile'));
    expect(direct).toEqual([]);
    // charter_cli runs $CHARTER_RUN, the same string the "Run:" hints print.
    expect(HOOK_CLI_RESOLVE_BLOCK).toContain('  $CHARTER_RUN "$@"\n');
    for (const command of Object.values(HOOK_CLI_COMMANDS)) expect(HOOK_CLI_RESOLVE_BLOCK).toContain(`CHARTER_RUN="${command}"`);
  });

  describe('cascade: first candidate whose marker exists and whose binary is on PATH', () => {
    it.each(PNP_MARKER_FILES.map(f => [f]))('Yarn PnP from %s alone (no yarn.lock): yarn charter', (marker) => {
      const run = runHook({ files: { [marker]: '' } });
      expect(run.status).toBe(0);
      expect(run.calls).toContain('yarn [--version]');
      expect(withoutYarnVersion(run.calls)).toEqual(expectedCalls(YARN));
      expect(run.stderr).toBe('');
    });

    it('Yarn PnP from .yarnrc.yml alone (nodeLinker: pnp, not installed yet): yarn charter', () => {
      const run = runHook({ files: { '.yarnrc.yml': 'nodeLinker: pnp\n' } });
      expect(run.status).toBe(0);
      expect(withoutYarnVersion(run.calls)).toEqual(expectedCalls(YARN));
    });

    it('PnP plus pnpm-lock.yaml, both binaries on PATH: yarn wins', () => {
      const run = runHook({ files: { '.pnp.cjs': '', 'pnpm-lock.yaml': '' } });
      expect(run.status).toBe(0);
      expect(withoutYarnVersion(run.calls)).toEqual(expectedCalls(YARN));
    });

    it('pnpm-lock.yaml plus yarn.lock, both binaries on PATH: pnpm wins', () => {
      const run = runHook({ files: { 'pnpm-lock.yaml': '', 'yarn.lock': '' } });
      expect(run.status).toBe(0);
      expect(run.calls).toEqual(expectedCalls(PNPM));
    });

    it('Yarn classic (yarn.lock, yarn 1.x): yarn --silent charter, so no run banner reaches the tidy plan', () => {
      const run = runHook({ files: { 'yarn.lock': '' }, yarnVersion: '1.22.22' });
      expect(run.status).toBe(0);
      expect(withoutYarnVersion(run.calls)).toEqual(expectedCalls(YARN1));
    });

    it('pnpm (pnpm-lock.yaml): pnpm exec charter', () => {
      const run = runHook({ files: { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" } });
      expect(run.status).toBe(0);
      expect(run.calls).toEqual(expectedCalls(PNPM));
    });

    it.each([
      ['package-lock.json', { ...LOCAL_BIN, 'package-lock.json': '{}' }],
      ['no lockfile', LOCAL_BIN],
      ['charter.cmd only (Windows install)', { 'node_modules/.bin/charter.cmd': '@echo off\r\n' }],
    ])('npm with a local install (%s): npm exec @stackbilt/cli, never the bare name charter', (_label, files) => {
      const run = runHook({ files, localBin: 'node_modules/.bin/charter' in files });
      expect(run.status).toBe(0);
      expect(run.calls).toEqual(expectedCalls(NPM));
    });

    it('mutation: swapping the PnP and pnpm-lock.yaml branches changes the PnP-plus-pnpm result', () => {
      expect(PRE_COMMIT_HOOK_CONTENT).toContain(PNP_THEN_PNPM);
      const swapped = PRE_COMMIT_HOOK_CONTENT.replace(PNP_THEN_PNPM, `if [ -f "pnpm-lock.yaml" ] && command -v pnpm >/dev/null 2>&1; then
  PM=pnpm
elif [ "$CHARTER_PNP" = "1" ] && command -v yarn >/dev/null 2>&1; then
  PM=yarn
`);
      const run = runHook({ files: { '.pnp.cjs': '', 'pnpm-lock.yaml': '' }, hook: swapped });
      expect(run.calls).toEqual(expectedCalls(PNPM));
    });

    it('mutation: swapping the pnpm-lock.yaml and yarn.lock branches changes the two-lockfile result', () => {
      expect(PRE_COMMIT_HOOK_CONTENT).toContain(PNPM_THEN_YARN_LOCK);
      const swapped = PRE_COMMIT_HOOK_CONTENT.replace(PNPM_THEN_YARN_LOCK, `elif [ -f "yarn.lock" ] && command -v yarn >/dev/null 2>&1; then
  PM=yarn
elif [ -f "pnpm-lock.yaml" ] && command -v pnpm >/dev/null 2>&1; then
  PM=pnpm
`);
      const run = runHook({ files: { 'pnpm-lock.yaml': '', 'yarn.lock': '' }, hook: swapped });
      expect(withoutYarnVersion(run.calls)).toEqual(expectedCalls(YARN));
    });
  });

  it.each([
    ['yarn PnP', { 'yarn.lock': '', '.pnp.cjs': '' }, YARN, 'yarn [run] [verify:adf] token-set'],
    ['pnpm', { 'pnpm-lock.yaml': '' }, PNPM, 'pnpm [run] [verify:adf] token-set'],
    ['npm', LOCAL_BIN, NPM, 'npm [run] [verify:adf] token-set'],
  ])('verify:adf repo (%s): scoped doctor through the package manager, then <pm> run verify:adf with the token', (_label, files, runner, verify) => {
    const run = runHook({ files: { ...files, 'package.json': JSON.stringify({ scripts: { 'verify:adf': 'charter doctor --adf-only --ci' } }) } });
    expect(run.status).toBe(0);
    expect(withoutYarnVersion(run.calls)).toEqual([...expectedCalls(runner).slice(0, 3), verify]);
  });

  describe('failure hints', () => {
    it.each([
      ['pnpm', { 'pnpm-lock.yaml': '' }, HOOK_CLI_COMMANDS.pnpm],
      ['npm', LOCAL_BIN, HOOK_CLI_COMMANDS.npm],
      ['yarn', { '.pnp.cjs': '' }, HOOK_CLI_COMMANDS.yarn],
    ])('%s: doctor ran and reported problems: blocks; the Run: line is exactly what ran; no devDependency hint', (_label, files, command) => {
      const run = runHook({ files, failOn: 'doctor' });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('[pre-commit] ADF verification FAILED.');
      const runLine = run.stdout.split('\n').find(l => l.startsWith('  Run: '));
      expect(runLine).toBe(`  Run: ${command} doctor --adf-only --ci --staged --format text`);
      expect(run.calls).toContain(`${logged(command)} [doctor] [--adf-only] [--ci] [--staged] [--tidy-skipped] [] [--format] [text]`);
      expect(run.stdout + run.stderr).not.toContain('devDependency');
      expect(run.calls.filter(c => c.endsWith('[--version]') && c !== 'yarn [--version]')).toHaveLength(1);
    });

    it('evidence ran and failed: the exact command, no devDependency hint', () => {
      const run = runHook({ files: LOCAL_BIN, failOn: 'evidence' });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain(`  Run: ${HOOK_CLI_COMMANDS.npm} adf evidence --auto-measure --ci`);
      expect(run.stdout + run.stderr).not.toContain('devDependency');
    });

    it.each([
      ['pnpm', { 'pnpm-lock.yaml': '' }, HOOK_CLI_COMMANDS.pnpm],
      ['npm (local bin present)', LOCAL_BIN, HOOK_CLI_COMMANDS.npm],
      ['yarn', { '.pnp.cjs': '' }, HOOK_CLI_COMMANDS.yarn],
    ])('%s: the CLI cannot be resolved (exit 127): one probe, the hint once, tidy skipped, the gate fails', (_label, files, command) => {
      const run = runHook({ files, unresolved: true });
      expect(run.status).toBe(1);
      expect(withoutYarnVersion(run.calls)).toEqual([`${logged(command)} [--version]`]);
      expect(run.stderr).toContain(`[pre-commit] Charter could not be found (tried: ${command}).`);
      expect(run.stderr.split('Add @stackbilt/cli as a devDependency').length - 1).toBe(1);
      expect(run.stdout).not.toContain('Checking staged vendor files');
      expect(run.stdout).toContain('[pre-commit] ADF verification FAILED.');
      expect(run.stdout).toContain('  Charter was not run (see the note above).');
      expect(run.stdout).not.toContain('Run:');
    });

    it('a 1.x CLI: one upgrade warning naming 2.x; the hook still runs it', () => {
      const run = runHook({ files: { 'pnpm-lock.yaml': '' }, charterVersion: 'charter v1.9.3' });
      expect(run.status).toBe(0);
      expect(run.stderr).toContain(`[pre-commit] Warning: ${HOOK_CLI_COMMANDS.pnpm} --version reports charter v1.9.3; this hook needs 2.x`);
      expect(run.stderr).toContain('Upgrade @stackbilt/cli to 2.x (as a devDependency, or your global install).');
      expect(run.stderr.split('Warning:').length - 1).toBe(1);
      expect(run.calls).toEqual(expectedCalls(PNPM));
    });

    it('an installed CLI whose --version fails: "installed but failed to run" with its error, no devDependency hint', () => {
      const run = runHook({ files: { 'pnpm-lock.yaml': '' }, versionFails: true });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("[pre-commit] Charter is installed but failed to run: Error: Cannot find module 'commander'");
      expect(run.stdout + run.stderr).not.toContain('devDependency');
      expect(run.calls).toEqual([`${PNPM} [--version]`]);
      expect(run.stdout).toContain(`  Run: ${HOOK_CLI_COMMANDS.pnpm} doctor --adf-only --ci --staged --format text`);
      expect(run.stdout).toContain('  Charter was not run: it failed to start (see the note above).');
    });

    it('a charter whose --version is not charter v<digit>: warns it is not @stackbilt/cli and runs nothing else', () => {
      const run = runHook({ files: LOCAL_BIN, charterVersion: 'Usage: charter <contract>' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`[pre-commit] Warning: the charter this hook found (${HOOK_CLI_COMMANDS.npm}) is not @stackbilt/cli: its --version printed: Usage: charter <contract>`);
      expect(run.calls).toEqual([`${NPM} [--version]`]);
      expect(run.stdout).not.toContain('Run:');
    });

    it.each([['charter v10.0.0'], ['charter v2.1.0'], ['charter v3.0.0-beta.1']])('%s is not flagged as 1.x or foreign', (version) => {
      const run = runHook({ files: LOCAL_BIN, charterVersion: version });
      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.calls).toEqual(expectedCalls(NPM));
    });

    it.each([['charter v0.9.0'], ['charter v1.0.0']])('%s is flagged as 1.x', (version) => {
      const run = runHook({ files: LOCAL_BIN, charterVersion: version });
      expect(run.stderr).toContain(`--version reports ${version}; this hook needs 2.x`);
    });

    it('tidy that leaves a staged file alone (say, unmanaged) shows its note and does not claim the files are clean', () => {
      const note = '  ⚠ CLAUDE.md is not managed by Charter; tidy leaves it as is.';
      const run = runHook({ files: LOCAL_BIN, tidyNote: note });
      expect(run.stdout).toContain(`[pre-commit] adf tidy notes:\n${note}`);
      expect(run.stdout).not.toContain('Vendor config files are clean');
    });

    it('a failed tidy dry run does not claim the vendor files are clean', () => {
      const run = runHook({ files: LOCAL_BIN, failOn: 'dry-run' });
      expect(run.stdout).toContain('[pre-commit] adf tidy --dry-run failed; skipping auto-tidy.');
      expect(run.stdout).not.toContain('Vendor config files are clean');
    });

    it('a dry run that plans nothing still says the vendor files are clean', () => {
      const run = runHook({ files: LOCAL_BIN });
      expect(run.stdout).toContain('[pre-commit] Vendor config files are clean.');
    });
  });

  describe('npm without a local install, and missing binaries', () => {
    it.skipIf(!isolatedOk)('no local install, no global charter: no Charter call at all, the hint once, the gate fails', () => {
      const run = runHook({ stubs: ['npm', 'npx'], isolatePath: true, localBin: false });
      expect(run.status).toBe(1);
      expect(run.calls).toEqual([]);
      expect(run.stderr).toContain(`[pre-commit] Charter could not be found (tried: ${HOOK_CLI_COMMANDS.npm}).`);
      expect(run.stdout).not.toContain('Run:');
      expect(run.stderr.split('Add @stackbilt/cli as a devDependency').length - 1).toBe(1);
    });

    it.skipIf(!isolatedOk)('no local install, a global charter on PATH: runs it directly, never npm exec', () => {
      const run = runHook({ stubs: ['npm', 'charter'], isolatePath: true, localBin: false });
      expect(run.status).toBe(0);
      expect(run.calls).toEqual(expectedCalls(GLOBAL));
    });

    it.skipIf(!isolatedOk)('Yarn (not PnP) without a local install: a global charter on PATH, run directly', () => {
      const run = runHook({ files: { 'yarn.lock': '' }, stubs: ['yarn', 'npm', 'charter'], isolatePath: true, localBin: false });
      expect(run.status).toBe(0);
      expect(run.calls).toEqual(expectedCalls(GLOBAL));
    });

    it.skipIf(!isolatedOk)('Yarn (not PnP) with neither a local nor a global install: no Charter call, the hint once', () => {
      const run = runHook({ files: { 'yarn.lock': '' }, stubs: ['yarn', 'npm'], isolatePath: true, localBin: false });
      expect(run.status).toBe(1);
      expect(run.calls).toEqual([]);
      expect(run.stderr).toContain(`[pre-commit] Charter could not be found (tried: ${HOOK_CLI_COMMANDS.yarn}).`);
      expect(run.stderr.split('Add @stackbilt/cli as a devDependency').length - 1).toBe(1);
    });

    it.skipIf(!isolatedOk)('Yarn PnP: always yarn charter, even with a global charter and no node_modules', () => {
      const run = runHook({ files: { '.pnp.cjs': '' }, stubs: ['yarn', 'npm', 'charter'], isolatePath: true, localBin: false });
      expect(run.status).toBe(0);
      expect(withoutYarnVersion(run.calls)).toEqual(expectedCalls(YARN));
    });

    it.skipIf(!isolatedOk)('pnpm with only a global charter: pnpm exec charter (it searches PATH too)', () => {
      const run = runHook({ files: { 'pnpm-lock.yaml': '' }, stubs: ['pnpm', 'npm', 'charter'], isolatePath: true, localBin: false });
      expect(run.status).toBe(0);
      expect(run.calls).toEqual(expectedCalls(PNPM));
    });

    it.skipIf(!isolatedOk)('pnpm with neither a local nor a global install: no Charter call, the hint once', () => {
      const run = runHook({ files: { 'pnpm-lock.yaml': '' }, stubs: ['pnpm', 'npm'], isolatePath: true, localBin: false });
      expect(run.status).toBe(1);
      expect(run.calls).toEqual([]);
      expect(run.stderr).toContain(`[pre-commit] Charter could not be found (tried: ${HOOK_CLI_COMMANDS.pnpm}).`);
    });

    it.skipIf(!isolatedOk)('Yarn PnP without yarn: warns (with the corepack fix) and falls back to npm', () => {
      const run = runHook({ files: { 'yarn.lock': '', '.pnp.cjs': '', ...LOCAL_BIN }, stubs: ['npm'], isolatePath: true });
      expect(run.status).toBe(0);
      expect(run.stderr).toContain(`[pre-commit] Warning: this repo uses yarn, but yarn is not on PATH; running Charter with ${HOOK_CLI_COMMANDS.npm} (and verify:adf with npm run) instead.`);
      expect(run.stderr).toContain('corepack enable');
      expect(run.calls).toEqual(expectedCalls(NPM));
    });

    it.skipIf(!isolatedOk)('PnP plus pnpm-lock.yaml without yarn: the cascade moves on to pnpm, with a warning', () => {
      const run = runHook({ files: { '.pnp.cjs': '', 'pnpm-lock.yaml': '' }, stubs: ['pnpm', 'npm'], isolatePath: true });
      expect(run.status).toBe(0);
      expect(run.stderr).toContain(`this repo uses yarn, but yarn is not on PATH; running Charter with ${HOOK_CLI_COMMANDS.pnpm} (and verify:adf with pnpm run) instead.`);
      expect(run.calls).toEqual(expectedCalls(PNPM));
    });

    it.skipIf(!isolatedOk)('both lockfiles with only yarn installed: yarn (the #365 cascade), not npm', () => {
      const run = runHook({
        files: { 'pnpm-lock.yaml': '', 'yarn.lock': '', 'package.json': JSON.stringify({ scripts: { 'verify:adf': 'x' } }) },
        stubs: ['yarn', 'npm'],
        isolatePath: true,
      });
      expect(run.status).toBe(0);
      expect(run.stderr).toContain(`this repo uses pnpm, but pnpm is not on PATH; running Charter with ${HOOK_CLI_COMMANDS.yarn} (and verify:adf with yarn run) instead.`);
      expect(withoutYarnVersion(run.calls)).toEqual([...expectedCalls(YARN).slice(0, 3), 'yarn [run] [verify:adf] token-set']);
    });

    it.skipIf(!isolatedOk)('pnpm repo without pnpm: warns and falls back to npm exec / npm run', () => {
      const run = runHook({
        files: { 'pnpm-lock.yaml': '', ...LOCAL_BIN, 'package.json': JSON.stringify({ scripts: { 'verify:adf': 'x' } }) },
        stubs: ['npm'],
        isolatePath: true,
      });
      expect(run.status).toBe(0);
      expect(run.stderr).toContain('this repo uses pnpm, but pnpm is not on PATH');
      expect(run.stderr).not.toContain('corepack enable');
      expect(run.calls).toEqual([...expectedCalls(NPM).slice(0, 3), 'npm [run] [verify:adf] token-set']);
    });

    it.skipIf(!isolatedOk)('prints nothing and makes no call without .ai/manifest.adf', () => {
      fs.rmSync(path.join(dir, '.ai'), { recursive: true });
      const run = runHook({ files: { 'yarn.lock': '' }, stubs: ['npm'], isolatePath: true });
      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.calls).toEqual([]);
    });
  });

  describe('one PnP source for the hook and doctor', () => {
    it('the hook text is built from PNP_MARKER_FILES and YARNRC_PNP_LINKER_ERE', () => {
      for (const f of PNP_MARKER_FILES) expect(HOOK_CLI_RESOLVE_BLOCK).toContain(`[ -f "${f}" ]`);
      const escaped = YARNRC_PNP_LINKER_ERE.replace(/[\\"$`]/g, ch => `\\${ch}`);
      expect(HOOK_CLI_RESOLVE_BLOCK).toContain(`grep -E "${escaped}" .yarnrc.yml`);
    });

    // The hook's own grep line, run by sh, against doctor's RegExp on the same file.
    const grepLine = (HOOK_CLI_RESOLVE_BLOCK.match(/grep -E "(?:[^"\\]|\\.)*" \.yarnrc\.yml/) ?? [''])[0];
    it.each([
      ['nodeLinker: pnp\n', true],
      ['nodeLinker: "pnp"\n', true],
      ["nodeLinker: 'pnp' # comment\n", true],
      ['nodeLinker: pnp\r\n', true],
      ['  nodeLinker:pnp\n', true],
      ['nodeLinker:\tpnp\t\n', true],
      ['yarnPath: .yarn/releases/yarn-4.5.0.cjs\nnodeLinker: pnp', true],
      ['nodeLinker:\n  pnp\n', false],
      ['nodeLinker: pnp\nx', true],
      ['nodeLinker: pnpm\n', false],
      ['nodeLinker: node-modules\n', false],
      ['nodeLinker: pnp-loose\n', false],
      ['# nodeLinker: pnp\n', false],
      ['"nodeLinker": pnp\n', false],
      ['', false],
    ])('agree on %j (PnP: %s)', (content, expected) => {
      expect(grepLine).not.toBe('');
      fs.writeFileSync(path.join(dir, '.yarnrc.yml'), content);
      const sh = spawnSync('sh', ['-c', `${grepLine} >/dev/null`], { cwd: dir });
      expect(sh.status === 0).toBe(expected);
      expect(yarnrcPnpLinkerRegExp().test(content)).toBe(expected);
    });
  });
});

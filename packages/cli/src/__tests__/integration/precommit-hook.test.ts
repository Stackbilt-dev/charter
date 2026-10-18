/**
 * Integration tests: the real pre-commit hook in real git repos (#320).
 *
 * Each repo installs the hook `charter hook install --pre-commit` generates
 * (PRE_COMMIT_HOOK_CONTENT), with its charter_cli function (#366) redefined to run the built CLI behind
 * a logging shim, so these tests exercise the shipped text and can prove which
 * CLI calls the hook made. Paths are passed to the shell double-quoted with
 * forward slashes: Node accepts C:/... on Windows and Git's sh leaves them alone.
 * Every repo and the shim live under a directory whose name contains a space.
 *
 * The ADF evidence gate that follows the tidy block runs doctor --adf-only --ci
 * --staged --tidy-skipped (#357): vendor bloat blocks only in staged files the
 * tidy block did not skip. Tests of the tidy block alone install it without the
 * gate (`tidyOnly`); the "full generated hook" group pins the gate's behaviour.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_CLI, HOOK_CLI_RESOLVE_BLOCK, HOOK_SCOPED_DOCTOR_FILE, PRE_COMMIT_HOOK_CONTENT } from '../../commands/hook';
import { BLOAT_SCOPE_MSG } from '../../commands/doctor';

// ============================================================================
// Fixture Helpers
// ============================================================================

const tempDirs: string[] = [];
const CLI_BIN = path.resolve(__dirname, '../../../dist/bin.js');
const posix = (p: string): string => p.split(path.sep).join('/');

const GIT_ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' };

interface Repo {
  dir: string;
  /** One line per CLI call the hook made: its arguments, space-joined. */
  calls(): string[];
  /** `git commit` with the repo's PATH (a failing pnpm first, when it has verify:adf). */
  commit(message: string, env?: Record<string, string>): { status: number | null; output: string };
  /** Lines the failing pnpm shim logged: one per time the hook ran pnpm. */
  pnpmCalls(): string[];
  /** A directory on the hook's PATH ahead of everything else. */
  binDir: string;
  /** Run the pre-commit hook alone (`git hook run`), asynchronously. */
  runHook(env?: Record<string, string>, direct?: boolean): Promise<{ status: number | null; output: string }>;
}

/** Bootstrapped repos get this verify:adf, the one setup writes, with `charter` pointed at the shim. */
const verifyAdfScript = (cli: string): string =>
  `${cli} doctor --adf-only --ci --format json && ${cli} adf evidence --auto-measure --ci --format json`;

const PATH_KEY = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';

function makeTempDir(label: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `charter integ hook-${label}-`));
  tempDirs.push(tmp);
  return tmp;
}

function git(tmp: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: tmp, encoding: 'utf-8', env: { ...process.env, ...GIT_ENV } }).trim();
}

/** Run `git commit`; the hook's output arrives on stdout or stderr, so both are returned. */
function commit(tmp: string, message: string, env: Record<string, string> = {}): { status: number | null; output: string } {
  const r = spawnSync('git', ['commit', '-m', message], { cwd: tmp, encoding: 'utf-8', env: { ...process.env, ...GIT_ENV, ...env } });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}

function committedFiles(tmp: string): string[] {
  return git(tmp, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
}

function porcelain(tmp: string): string[] {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: tmp, encoding: 'utf-8' })
    .split('\n').filter(Boolean).sort();
}

function show(tmp: string, spec: string): string {
  return execFileSync('git', ['show', spec], { cwd: tmp, encoding: 'utf-8' });
}

const read = (tmp: string, file: string): string => fs.readFileSync(path.join(tmp, file), 'utf-8');

const POINTER = `# CLAUDE.md

> **DO NOT add rules, constraints, or context to this file.**
> This file is auto-managed by Charter. All project rules live in \`.ai/\`.
> New rules should be added to the appropriate \`.ai/*.adf\` module.
> See \`.ai/manifest.adf\` for the module routing manifest.

## Environment
- Node 20
`;

const DB_BLOAT = `
## Database Rules
- All database migrations must be reversible
- Schema changes require migration scripts
`;

/**
 * Scaffold a git repo with ADF, the generated pre-commit hook (via a logging
 * shim around the built CLI) under core.hooksPath, and an initial clean commit.
 */
interface FixtureOpts {
  tidyOnly?: boolean;
  /**
   * Give the repo a package.json with a verify:adf script (setup's, unless a
   * string is passed: then `{CLI}` in it is the shim) and this lockfile. PATH
   * gets a pnpm that logs and fails, so a hook that runs pnpm where it should not fails.
   */
  verifyAdf?: { script?: string; lockfile: 'package-lock.json' | 'pnpm-lock.yaml' };
}

function writeHookFixtureRepo(label: string, opts: FixtureOpts = {}): Repo {
  const tmp = makeTempDir(label);
  const shimDir = makeTempDir(`${label}-shim`);
  const log = path.join(shimDir, 'calls.log');
  const shim = path.join(shimDir, 'charter shim.cjs');
  const pnpmLog = path.join(shimDir, 'pnpm.log');
  const binDir = path.join(shimDir, 'bin');
  fs.writeFileSync(log, '');
  fs.writeFileSync(pnpmLog, '');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'pnpm'), `#!/bin/sh\necho "pnpm $*" >> "${posix(pnpmLog)}"\necho 'fake pnpm: not installed' >&2\nexit 97\n`);
  fs.chmodSync(path.join(binDir, 'pnpm'), 0o755);
  fs.writeFileSync(path.join(binDir, 'pnpm.cmd'), `@echo pnpm %*>> "${pnpmLog}"\r\n@exit /b 97\r\n`);
  fs.writeFileSync(shim, [
    `const args = process.argv.slice(2);`,
    `require('fs').appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');`,
    `if (process.env.HOOK_TEST_FAIL_TIDY === '1' && args[0] === 'adf' && args[1] === 'tidy') process.exit(3);`,
    // Test hooks for paths tidy reports: a ghost path in both runs, or an extra write in the real run only.
    `if (args[0] === 'adf' && args[1] === 'tidy' && args.includes('--print-paths')) process.on('exit', () => {`,
    `  const fs = require('fs');`,
    `  if (process.env.HOOK_TEST_GHOST) fs.writeSync(1, 'module ' + process.env.HOOK_TEST_GHOST + String.fromCharCode(10));`,
    `  const extra = process.env.HOOK_TEST_EXTRA_WRITE;`,
    `  if (extra && !args.includes('--dry-run')) { fs.writeFileSync(extra, 'ADF: 0.1' + String.fromCharCode(10)); fs.writeSync(1, 'module ' + extra + String.fromCharCode(10)); }`,
    `});`,
    `require(${JSON.stringify(CLI_BIN)});`,
    '',
  ].join('\n'));

  git(tmp, 'init');
  git(tmp, 'config', 'user.email', 'test@test.com');
  git(tmp, 'config', 'user.name', 'Test');
  git(tmp, 'config', 'core.autocrlf', 'false');

  fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.charter'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.charter', '.gitignore'), 'telemetry/\n');
  fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), `ADF: 0.1

📦 DEFAULT_LOAD:
  - core.adf
  - state.adf

📂 ON_DEMAND:
  - backend.adf (Triggers on: database, API, migration)

💰 BUDGET:
  MAX_TOKENS: 4000
`);
  fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), 'ADF: 0.1\n\n📐 RULES:\n  - All changes require tests\n');
  fs.writeFileSync(path.join(tmp, '.ai', 'state.adf'), 'ADF: 0.1\n\n📋 STATE:\n  - CURRENT: testing\n');
  fs.writeFileSync(path.join(tmp, '.ai', 'backend.adf'), 'ADF: 0.1\n\n📐 RULES:\n  - Database access through repository pattern\n');
  fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER);
  fs.writeFileSync(path.join(tmp, 'GEMINI.md'), POINTER.replace('# CLAUDE.md', '# GEMINI.md'));
  if (opts.verifyAdf) {
    const cli = `node "${posix(shim)}"`;
    const script = (opts.verifyAdf.script ?? verifyAdfScript('{CLI}')).split('{CLI}').join(cli);
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { 'verify:adf': script } }, null, 2) + '\n');
    fs.writeFileSync(path.join(tmp, opts.verifyAdf.lockfile), opts.verifyAdf.lockfile === 'package-lock.json'
      ? JSON.stringify({ name: 'fixture', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture' } } }, null, 2) + '\n'
      : "lockfileVersion: '9.0'\n");
  }

  // The generated hook, as `charter hook install --pre-commit` writes it.
  const hookDir = path.join(tmp, '.githooks');
  fs.mkdirSync(hookDir, { recursive: true });
  // #366: charter_cli is redefined right after the generated one, so package-manager
  // detection still runs (verify:adf uses it) and every Charter call reaches the shim.
  const full = PRE_COMMIT_HOOK_CONTENT.replace(HOOK_CLI_RESOLVE_BLOCK, `${HOOK_CLI_RESOLVE_BLOCK}${HOOK_CLI}() { node "${posix(shim)}" "$@"; }\n`);
  expect(full).not.toBe(PRE_COMMIT_HOOK_CONTENT);
  const hook = opts.tidyOnly ? full.slice(0, full.indexOf('# ADF evidence gate')) : full;
  expect(hook).toContain('# Charter pre-commit vendor tidy: scoped to staged files');
  fs.writeFileSync(path.join(hookDir, 'pre-commit'), hook);
  fs.chmodSync(path.join(hookDir, 'pre-commit'), 0o755);
  git(tmp, 'config', 'core.hooksPath', '.githooks');

  git(tmp, 'add', '-A');
  if (opts.verifyAdf) git(tmp, 'commit', '--no-verify', '-m', 'initial');
  else git(tmp, 'commit', '-m', 'initial');
  fs.writeFileSync(log, '');

  const pathEnv = { [PATH_KEY]: `${binDir}${path.delimiter}${process.env[PATH_KEY] ?? ''}` };
  return {
    dir: tmp,
    calls: () => fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean),
    commit: (message, env = {}) => commit(tmp, message, { ...pathEnv, ...env }),
    pnpmCalls: () => fs.readFileSync(pnpmLog, 'utf-8').split(/\r?\n/).filter(Boolean),
    binDir,
    runHook: (env = {}, direct = false) => new Promise(resolve => {
      // `git hook run` runs the hook as `git commit` would, without committing, so two can overlap.
      // direct: plain `sh`, so binDir really comes first on PATH (git puts its own dirs ahead of it).
      const [cmd, args] = direct ? ['sh', ['.githooks/pre-commit']] : ['git', ['hook', 'run', 'pre-commit']];
      const child = spawn(cmd, args, { cwd: tmp, env: { ...process.env, ...GIT_ENV, ...pathEnv, ...env } });
      let output = '';
      child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
      child.on('close', status => resolve({ status, output }));
    }),
  };
}

/** The hook's per-run scope token files left in the git dir. */
const scopeFiles = (dir: string): string[] => fs.readdirSync(path.join(dir, '.git')).filter(n => n.startsWith(HOOK_SCOPED_DOCTOR_FILE));

/** Only the tidy calls (the evidence gate after the block calls the CLI too). */
const tidyCalls = (repo: Repo): string[] => repo.calls().filter(c => c.startsWith('adf tidy'));

// ============================================================================
// Lifecycle
// ============================================================================

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// The generated pre-commit hook
// ============================================================================

describe('pre-commit hook auto-tidy (integration)', () => {

  it('auto-tidies bloated CLAUDE.md during git commit', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('tidy');
    const tmp = repo.dir;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + `
## Architecture
- Layered architecture with repository pattern
- All database queries go through the repository layer
- API endpoints validate input before processing
${DB_BLOAT}`);

    git(tmp, 'add', 'CLAUDE.md');
    const result = commit(tmp, 'add bloated content');

    expect(result.status).toBe(0);
    expect(result.output).toContain('[pre-commit] Checking staged vendor files: CLAUDE.md');
    expect(result.output).toContain('re-staged only the planned files tidy wrote');
    // Real tidy ran, scoped to the staged file.
    expect(tidyCalls(repo)).toEqual([
      'adf tidy --dry-run --print-paths --source CLAUDE.md',
      'adf tidy --print-paths --source CLAUDE.md',
    ]);
    const committedClaude = show(tmp, 'HEAD:CLAUDE.md');
    expect(committedClaude).toContain('DO NOT add rules');
    expect(committedClaude).not.toContain('## Architecture');
    expect(committedClaude).not.toContain('## Database Rules');
    expect(committedClaude).toContain('## Environment');
    // Everything tidy wrote was committed; nothing is left behind.
    expect(porcelain(tmp)).toEqual([]);
  });

  it('passes through cleanly when CLAUDE.md has no bloat', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('clean');
    const tmp = repo.dir;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER.trimEnd() + '\n- pnpm 9\n');

    git(tmp, 'add', 'CLAUDE.md');
    const result = commit(tmp, 'add env item');

    expect(result.status).toBe(0);
    expect(result.output).toContain('[pre-commit] Vendor config files are clean.');
    expect(tidyCalls(repo)).toEqual(['adf tidy --dry-run --print-paths --source CLAUDE.md']);
    expect(read(tmp, 'CLAUDE.md')).toContain('- pnpm 9');
    expect(committedFiles(tmp)).toEqual(['CLAUDE.md']);
  });

  it('re-stages modified .adf modules after tidy, and only those', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('restage');
    const tmp = repo.dir;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + DB_BLOAT + '- API rate limiting applies to all database endpoints\n');

    git(tmp, 'add', 'CLAUDE.md');
    expect(commit(tmp, 'auto-routed content').status).toBe(0);

    const committedClaude = show(tmp, 'HEAD:CLAUDE.md');
    expect(committedClaude).toContain('DO NOT add rules');
    expect(committedClaude).not.toContain('## Database Rules');
    const committed = committedFiles(tmp);
    expect(committed).toContain('CLAUDE.md');
    const modules = committed.filter(f => f.startsWith('.ai/'));
    expect(modules.length).toBeGreaterThan(0);
    const routed = modules.map(m => show(tmp, `HEAD:${m}`)).join('\n');
    expect(routed).toContain('All database migrations must be reversible');
    expect(porcelain(tmp)).toEqual([]);
  });

  it('INV-P4-1: unrelated .ai/ work in progress stays out of the commit', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('wip-unrelated');
    const tmp = repo.dir;
    fs.appendFileSync(path.join(tmp, '.ai', 'state.adf'), '  - NEXT: half-written idea\n');
    fs.writeFileSync(path.join(tmp, '.ai', 'context.adf'), 'ADF: 0.1\n\n📋 STATE:\n  - session output\n');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + DB_BLOAT);

    git(tmp, 'add', 'CLAUDE.md');
    expect(commit(tmp, 'tidy with unrelated wip').status).toBe(0);

    const committed = committedFiles(tmp);
    expect(committed).not.toContain('.ai/state.adf');
    expect(committed).not.toContain('.ai/context.adf');
    expect(porcelain(tmp)).toEqual([' M .ai/state.adf', '?? .ai/context.adf']);
    expect(read(tmp, '.ai/state.adf')).toContain('half-written idea');
  });

  it('INV-P4-2: never tidies a vendor file that is not staged', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('unstaged-vendor', { tidyOnly: true });
    const tmp = repo.dir;
    const geminiBloated = read(tmp, 'GEMINI.md') + DB_BLOAT;
    fs.writeFileSync(path.join(tmp, 'GEMINI.md'), geminiBloated);
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + DB_BLOAT);

    git(tmp, 'add', 'CLAUDE.md');
    expect(commit(tmp, 'only claude staged').status).toBe(0);

    expect(tidyCalls(repo).every(c => !c.includes('GEMINI.md'))).toBe(true);
    expect(read(tmp, 'GEMINI.md')).toBe(geminiBloated);
    expect(committedFiles(tmp)).not.toContain('GEMINI.md');
    expect(porcelain(tmp)).toEqual([' M GEMINI.md']);
  });

  it('INV-P4-1: skips a staged vendor file that also has unstaged changes (CP-3)', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('partial', { tidyOnly: true });
    const tmp = repo.dir;
    const staged = POINTER + DB_BLOAT;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), staged);
    git(tmp, 'add', 'CLAUDE.md');
    const worktree = staged + '- not staged yet\n';
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), worktree);

    const result = commit(tmp, 'partially staged');

    expect(result.status).toBe(0);
    expect(result.output).toContain('[pre-commit] CLAUDE.md has unstaged changes, so auto-tidy is skipped for it in this commit.');
    expect(result.output).toContain("[pre-commit] Its bloat, if any, is left as-is; a plain charter doctor --ci (as CI runs it) still reports it. To tidy it: stage or stash the unstaged changes and commit again; or run: charter adf tidy --source CLAUDE.md, then git add the result.");
    expect(tidyCalls(repo)).toEqual([]);
    expect(show(tmp, 'HEAD:CLAUDE.md')).toBe(staged);
    expect(read(tmp, 'CLAUDE.md')).toBe(worktree);
    expect(committedFiles(tmp)).toEqual(['CLAUDE.md']);
  });

  it.each([
    ['unstaged edits to a planned module', (tmp: string) => fs.appendFileSync(path.join(tmp, '.ai', 'backend.adf'), '  - wip rule\n'), ' M .ai/backend.adf'],
    ['a planned module deleted but not staged', (tmp: string) => fs.rmSync(path.join(tmp, '.ai', 'backend.adf')), ' D .ai/backend.adf'],
  ])('CP-4: %s skips tidy for this commit; the tidy block alone does not fail the commit', { timeout: 60000 }, (_label, makeWip, wipStatus) => {
    const repo = writeHookFixtureRepo('wip-planned', { tidyOnly: true });
    const tmp = repo.dir;
    const bloated = POINTER + DB_BLOAT;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), bloated);
    git(tmp, 'add', 'CLAUDE.md');
    // Learn the plan first, so the WIP lands in a module tidy really targets.
    const plan = execFileSync('node', [CLI_BIN, 'adf', 'tidy', '--dry-run', '--print-paths', '--source', 'CLAUDE.md'], { cwd: tmp, encoding: 'utf-8' });
    expect(plan).toContain('module .ai/backend.adf');
    makeWip(tmp);
    const before = fs.existsSync(path.join(tmp, '.ai', 'backend.adf')) ? read(tmp, '.ai/backend.adf') : null;

    const result = commit(tmp, 'planned module wip');

    expect(result.status).toBe(0);
    expect(result.output).toContain('[pre-commit] Auto-tidy skipped for this commit: tidy would write into files with unstaged or untracked work: .ai/backend.adf');
    expect(result.output).toContain("[pre-commit] Bloat in CLAUDE.md, if any, is left as-is; a plain charter doctor --ci (as CI runs it) still reports it. To tidy: stage or stash that work and commit again; or run: charter adf tidy --source CLAUDE.md, then git add the result.");
    expect(tidyCalls(repo)).toEqual(['adf tidy --dry-run --print-paths --source CLAUDE.md']);
    expect(show(tmp, 'HEAD:CLAUDE.md')).toBe(bloated);
    expect(committedFiles(tmp)).toEqual(['CLAUDE.md']);
    expect(fs.existsSync(path.join(tmp, '.ai', 'backend.adf')) ? read(tmp, '.ai/backend.adf') : null).toBe(before);
    expect(porcelain(tmp)).toEqual([wipStatus]);
  });

  it('CP-4: an untracked file at a planned module path skips tidy; the tidy block alone does not fail the commit', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('wip-untracked', { tidyOnly: true });
    const tmp = repo.dir;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + '\n## Testing\n- Always run the test suite before pushing\n- Never skip flaky tests\n');
    git(tmp, 'add', 'CLAUDE.md');
    const plan = execFileSync('node', [CLI_BIN, 'adf', 'tidy', '--dry-run', '--print-paths', '--source', 'CLAUDE.md'], { cwd: tmp, encoding: 'utf-8' });
    const created = plan.split('\n').filter(l => l.startsWith('module ')).map(l => l.slice('module '.length))
      .find(p => !fs.existsSync(path.join(tmp, p)));
    expect(created).toBeDefined();
    fs.writeFileSync(path.join(tmp, created!), 'ADF: 0.1\n\n📐 RULES:\n  - my own untracked draft\n');

    const result = commit(tmp, 'untracked planned module');

    expect(result.status).toBe(0);
    expect(result.output).toContain(`unstaged or untracked work: ${created}`);
    expect(read(tmp, created!)).toContain('my own untracked draft');
    expect(committedFiles(tmp)).toEqual(['CLAUDE.md']);
  });

  it('INV-P4-3: a commit staging only compiled vendor output makes no tidy call', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('compiled');
    const tmp = repo.dir;
    const compiled = `<!-- GENERATED by charter adf compile — DO NOT EDIT. Source of truth: .ai/ modules. -->
# Compiled agent context

## Constraints

- Keep API contracts stable
`;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), compiled);
    const coreBefore = read(tmp, '.ai/core.adf');

    git(tmp, 'add', 'CLAUDE.md');
    expect(commit(tmp, 'commit compiled vendor output').status).toBe(0);

    expect(tidyCalls(repo)).toEqual([]);
    expect(repo.calls().length).toBeGreaterThan(0); // the shim was wired: the evidence gate called it
    expect(read(tmp, 'CLAUDE.md')).toBe(compiled);
    expect(read(tmp, '.ai/core.adf')).toBe(coreBefore);
  });

  it('INV-P4-3: a commit staging no vendor file makes no tidy call', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('no-vendor');
    const tmp = repo.dir;
    fs.writeFileSync(path.join(tmp, 'notes.md'), 'hello\n');
    git(tmp, 'add', 'notes.md');
    expect(commit(tmp, 'no vendor').status).toBe(0);
    expect(tidyCalls(repo)).toEqual([]);
  });

  it('tidies a staged lowercase agents.md (CP-2, #302)', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('agents-lower');
    const tmp = repo.dir;
    const pointer = execFileSync('node', ['-e', `process.stdout.write(require(${JSON.stringify(path.resolve(__dirname, '../../../dist/commands/adf.js'))}).POINTER_AGENTS_MD)`], { encoding: 'utf-8' });
    fs.writeFileSync(path.join(tmp, 'agents.md'), pointer + DB_BLOAT);

    git(tmp, 'add', 'agents.md');
    expect(commit(tmp, 'lowercase agents').status).toBe(0);

    expect(tidyCalls(repo)).toEqual([
      'adf tidy --dry-run --print-paths --source agents.md',
      'adf tidy --print-paths --source agents.md',
    ]);
    expect(show(tmp, 'HEAD:agents.md')).toBe(pointer);
    expect(porcelain(tmp)).toEqual([]);
  });

  it('stages a restore-only rewrite of a staged vendor file (CP-5)', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('restore-only');
    const tmp = repo.dir;
    // The only bloat is already in core.adf: no module is written, the pointer is.
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + '\n## Rules\n- All changes require tests\n');

    git(tmp, 'add', 'CLAUDE.md');
    expect(commit(tmp, 'restore only').status).toBe(0);

    expect(tidyCalls(repo)).toHaveLength(2);
    expect(show(tmp, 'HEAD:CLAUDE.md')).not.toContain('## Rules');
    expect(committedFiles(tmp)).toEqual(['CLAUDE.md']);
    expect(porcelain(tmp)).toEqual([]);
  });

  it('H6: a tidy failure prints one line and the commit proceeds untouched', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('tidy-fails', { tidyOnly: true });
    const tmp = repo.dir;
    const bloated = POINTER + DB_BLOAT;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), bloated);

    git(tmp, 'add', 'CLAUDE.md');
    const result = commit(tmp, 'tidy fails', { HOOK_TEST_FAIL_TIDY: '1' });

    expect(result.status).toBe(0);
    expect(result.output).toContain('[pre-commit] adf tidy --dry-run failed; skipping auto-tidy.');
    expect(show(tmp, 'HEAD:CLAUDE.md')).toBe(bloated);
    expect(porcelain(tmp)).toEqual([]);
  });

  it('skips tidy when CHARTER_SKIP_TIDY=1 is set', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('skip', { tidyOnly: true });
    const tmp = repo.dir;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + '\n## Architecture\n- Layered architecture pattern\n');

    git(tmp, 'add', 'CLAUDE.md');
    expect(commit(tmp, 'bloat preserved', { CHARTER_SKIP_TIDY: '1' }).status).toBe(0);

    expect(tidyCalls(repo)).toEqual([]);
    expect(read(tmp, 'CLAUDE.md')).toContain('## Architecture');
  });

  describe.each([
    ['no verify:adf script', {}],
    ['a verify:adf script (bootstrapped repo, npm lockfile, failing pnpm on PATH)', { verifyAdf: { lockfile: 'package-lock.json' } }],
  ] as Array<[string, FixtureOpts]>)('full generated hook, %s: the evidence gate is scoped to the commit (#357)', (_flavor, flavor) => {
    const NOT_BLOCKING = '[info] adf vendor bloat (not blocking):';
    const BLOAT_WARN = '[warn] adf vendor bloat:';

    interface DoctorJson { status: string; checks: Array<{ name: string; status: string; details: string }> }

    /** Plain doctor, as CI runs it: no --staged. */
    function plainDoctor(tmp: string): { status: number | null; json: DoctorJson } {
      const r = spawnSync('node', [CLI_BIN, 'doctor', '--adf-only', '--ci', '--format', 'json'], { cwd: tmp, encoding: 'utf-8' });
      return { status: r.status, json: JSON.parse(r.stdout) as DoctorJson };
    }

    /** Plain doctor still fails on every bloated vendor file, and never scopes anything. */
    function expectPlainDoctorEnforcesAll(tmp: string, bloated: string[]): void {
      const { status, json } = plainDoctor(tmp);
      expect(status).toBe(1);
      const bloat = json.checks.find(c => c.name === 'adf vendor bloat');
      expect(bloat?.status).toBe('WARN');
      for (const f of bloated) expect(bloat?.details).toContain(`${f}: `);
      expect(bloat?.details.endsWith('Run: charter adf tidy --dry-run')).toBe(true);
      expect(json.checks.some(c => c.name === 'adf vendor bloat (not blocking)')).toBe(false);
    }

    const head = (tmp: string): string => git(tmp, 'rev-parse', 'HEAD');

    /**
     * The gate went past the scoped doctor. With verify:adf: it ran (via npm,
     * never pnpm), its doctor left bloat to the scoped gate, and the token file
     * is gone. Without: the evidence check ran.
     */
    function expectRestOfGateRan(repo: Repo, output: string): void {
      if (!flavor.verifyAdf) {
        expect(repo.calls()).toContain('adf evidence --auto-measure --ci');
        return;
      }
      expect(repo.calls()).toContain('doctor --adf-only --ci --format json');
      expect(repo.calls()).toContain('adf evidence --auto-measure --ci --format json');
      expect(output).toContain(BLOAT_SCOPE_MSG.hookCheckedStderr);
      expect(output).toContain('"name": "adf vendor bloat (checked by pre-commit hook)"');
      expect(repo.pnpmCalls()).toEqual([]);
      expect(scopeFiles(repo.dir)).toEqual([]);
    }

    /** The scoped doctor blocked, so nothing after it ran. */
    function expectGateStoppedAtScopedDoctor(repo: Repo): void {
      expect(repo.calls().filter(c => c.startsWith('doctor ') && !c.includes('--staged'))).toEqual([]);
      expect(repo.calls().filter(c => c.startsWith('adf evidence'))).toEqual([]);
      expect(repo.pnpmCalls()).toEqual([]);
    }

    it('B: unstaged GEMINI.md bloat does not block a clean staged CLAUDE.md edit, and is shown as INFO', { timeout: 60000 }, () => {
      const repo = writeHookFixtureRepo('gate-b', flavor);
      const tmp = repo.dir;
      const gemini = read(tmp, 'GEMINI.md') + DB_BLOAT;
      fs.writeFileSync(path.join(tmp, 'GEMINI.md'), gemini);
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER.trimEnd() + '\n- pnpm 9\n');
      git(tmp, 'add', 'CLAUDE.md');

      const result = repo.commit('clean claude edit');

      expect(result.status).toBe(0);
      expectRestOfGateRan(repo, result.output);
      expect(result.output).toContain(NOT_BLOCKING);
      expect(result.output).toContain('GEMINI.md (not staged): ');
      expect(result.output).not.toContain(BLOAT_WARN);
      expect(repo.calls()).toContain('doctor --adf-only --ci --staged --tidy-skipped  --format text');
      expect(committedFiles(tmp)).toEqual(['CLAUDE.md']);
      expect(read(tmp, 'GEMINI.md')).toBe(gemini);
      expect(porcelain(tmp)).toEqual([' M GEMINI.md']);
      expectPlainDoctorEnforcesAll(tmp, ['GEMINI.md']);
    });

    it('B2: a staged bloated CLAUDE.md is tidied and committed while unstaged GEMINI.md bloat stays put', { timeout: 60000 }, () => {
      const repo = writeHookFixtureRepo('gate-b2', flavor);
      const tmp = repo.dir;
      const gemini = read(tmp, 'GEMINI.md') + DB_BLOAT;
      fs.writeFileSync(path.join(tmp, 'GEMINI.md'), gemini);
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + DB_BLOAT);
      git(tmp, 'add', 'CLAUDE.md');

      const result = repo.commit('bloated claude, unstaged gemini');

      expect(result.status).toBe(0);
      expectRestOfGateRan(repo, result.output);
      expect(result.output).toContain('GEMINI.md (not staged): ');
      expect(show(tmp, 'HEAD:CLAUDE.md')).not.toContain('## Database Rules');
      expect(committedFiles(tmp)).not.toContain('GEMINI.md');
      expect(read(tmp, 'GEMINI.md')).toBe(gemini);
      expectPlainDoctorEnforcesAll(tmp, ['GEMINI.md']);
    });

    it('N: a commit staging no vendor file is not blocked by vendor bloat elsewhere', { timeout: 60000 }, () => {
      const repo = writeHookFixtureRepo('gate-n', flavor);
      const tmp = repo.dir;
      fs.writeFileSync(path.join(tmp, 'GEMINI.md'), read(tmp, 'GEMINI.md') + DB_BLOAT);
      fs.writeFileSync(path.join(tmp, 'notes.md'), 'hello\n');
      git(tmp, 'add', 'notes.md');

      const result = repo.commit('no vendor staged');

      expect(result.status).toBe(0);
      expectRestOfGateRan(repo, result.output);
      expect(result.output).toContain('GEMINI.md (not staged): ');
      expect(tidyCalls(repo)).toEqual([]);
      expect(committedFiles(tmp)).toEqual(['notes.md']);
      expectPlainDoctorEnforcesAll(tmp, ['GEMINI.md']);
    });

    it('C (CP-3): a partially staged bloated file is skipped by tidy and does not block; the skip is explained', { timeout: 60000 }, () => {
      const repo = writeHookFixtureRepo('gate-partial', flavor);
      const tmp = repo.dir;
      const staged = POINTER + DB_BLOAT;
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), staged);
      git(tmp, 'add', 'CLAUDE.md');
      fs.appendFileSync(path.join(tmp, 'CLAUDE.md'), '- not staged yet\n');

      const result = repo.commit('partial with full hook');

      expect(result.status).toBe(0);
      expectRestOfGateRan(repo, result.output);
      expect(result.output).toContain('[pre-commit] CLAUDE.md has unstaged changes, so auto-tidy is skipped for it in this commit.');
      expect(result.output).toContain('[pre-commit] Its bloat, if any, is left as-is; a plain charter doctor --ci (as CI runs it) still reports it.');
      expect(result.output).toContain('CLAUDE.md (auto-tidy skipped for it in this commit): ');
      expect(result.output).not.toContain(BLOAT_WARN);
      expect(result.output).not.toContain('[pre-commit] Blocked because');
      expect(repo.calls()).toContain('doctor --adf-only --ci --staged --tidy-skipped  CLAUDE.md --format text');
      expect(tidyCalls(repo)).toEqual([]);
      expect(show(tmp, 'HEAD:CLAUDE.md')).toBe(staged);
      expect(porcelain(tmp)).toEqual([' M CLAUDE.md']);
      expectPlainDoctorEnforcesAll(tmp, ['CLAUDE.md']);
    });

    it('D (CP-4): planned-module WIP skips tidy and does not block', { timeout: 60000 }, () => {
      const repo = writeHookFixtureRepo('gate-wip', flavor);
      const tmp = repo.dir;
      const bloated = POINTER + DB_BLOAT;
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), bloated);
      git(tmp, 'add', 'CLAUDE.md');
      fs.appendFileSync(path.join(tmp, '.ai', 'backend.adf'), '  - wip rule\n');

      const result = repo.commit('wip with full hook');

      expect(result.status).toBe(0);
      expectRestOfGateRan(repo, result.output);
      expect(result.output).toContain('[pre-commit] Auto-tidy skipped for this commit: tidy would write into files with unstaged or untracked work: .ai/backend.adf');
      expect(result.output).toContain('CLAUDE.md (auto-tidy skipped for it in this commit): ');
      expect(result.output).not.toContain(BLOAT_WARN);
      expect(show(tmp, 'HEAD:CLAUDE.md')).toBe(bloated);
      expect(porcelain(tmp)).toEqual([' M .ai/backend.adf']);
      expectPlainDoctorEnforcesAll(tmp, ['CLAUDE.md']);
    });

    it('D3 (CP-4): an untracked planned module skips tidy and does not block', { timeout: 60000 }, () => {
      const repo = writeHookFixtureRepo('gate-untracked', flavor);
      const tmp = repo.dir;
      // DB_BLOAT makes the file bloated in doctor's eyes, so the gate would block without --tidy-skipped.
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + '\n## Testing\n- Always run the test suite before pushing\n- Never skip flaky tests\n' + DB_BLOAT);
      git(tmp, 'add', 'CLAUDE.md');
      const plan = execFileSync('node', [CLI_BIN, 'adf', 'tidy', '--dry-run', '--print-paths', '--source', 'CLAUDE.md'], { cwd: tmp, encoding: 'utf-8' });
      const created = plan.split('\n').filter(l => l.startsWith('module ')).map(l => l.slice('module '.length))
        .find(p => !fs.existsSync(path.join(tmp, p)));
      expect(created).toBeDefined();
      fs.writeFileSync(path.join(tmp, created!), 'ADF: 0.1\n\n📐 RULES:\n  - my own untracked draft\n');
      expect(plainDoctor(tmp).status).toBe(1);

      const result = repo.commit('untracked planned module, full hook');

      expect(result.status).toBe(0);
      expectRestOfGateRan(repo, result.output);
      expect(result.output).toContain(`unstaged or untracked work: ${created}`);
      expect(result.output).not.toContain(BLOAT_WARN);
      expect(committedFiles(tmp)).toEqual(['CLAUDE.md']);
      expect(read(tmp, created!)).toContain('my own untracked draft');
    });

    it('still blocks on staged bloat that tidy ran on but could not move (keyword density in a kept section)', { timeout: 60000 }, () => {
      const repo = writeHookFixtureRepo('gate-unfixable', flavor);
      const tmp = repo.dir;
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER.trimEnd() + ', the database is postgres and the database runs locally\n');
      git(tmp, 'add', 'CLAUDE.md');
      const before = head(tmp);

      const result = repo.commit('unfixable bloat');

      expect(result.status).toBe(1);
      expectGateStoppedAtScopedDoctor(repo);
      expect(result.output).toContain('[pre-commit] Vendor config files are clean.');
      expect(result.output).toContain(BLOAT_WARN);
      expect(result.output).toContain('CLAUDE.md: trigger keywords [database (2x)]');
      expect(result.output).toContain('Run: charter adf tidy --dry-run --source CLAUDE.md');
      expect(result.output).toContain('[pre-commit] ADF verification FAILED.');
      expect(result.output).toContain(' doctor --adf-only --ci --staged --format text');
      expect(head(tmp)).toBe(before);
    });

    it('still blocks on a staged bloated file when tidy fails (not a deliberate skip)', { timeout: 60000 }, () => {
      const repo = writeHookFixtureRepo('gate-tidy-fails', flavor);
      const tmp = repo.dir;
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + DB_BLOAT);
      git(tmp, 'add', 'CLAUDE.md');
      const before = head(tmp);

      const result = repo.commit('tidy fails, full hook', { HOOK_TEST_FAIL_TIDY: '1' });

      expect(result.status).toBe(1);
      expectGateStoppedAtScopedDoctor(repo);
      expect(result.output).toContain('[pre-commit] adf tidy --dry-run failed; skipping auto-tidy.');
      expect(result.output).toContain(BLOAT_WARN);
      expect(result.output).not.toContain(NOT_BLOCKING);
      expect(head(tmp)).toBe(before);
    });

    it('still blocks on a staged bloated file under CHARTER_SKIP_TIDY=1', { timeout: 60000 }, () => {
      const repo = writeHookFixtureRepo('gate-skip-env', flavor);
      const tmp = repo.dir;
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + DB_BLOAT);
      fs.writeFileSync(path.join(tmp, 'GEMINI.md'), read(tmp, 'GEMINI.md') + DB_BLOAT);
      git(tmp, 'add', 'CLAUDE.md');
      const before = head(tmp);

      const result = repo.commit('skip tidy, full hook', { CHARTER_SKIP_TIDY: '1' });

      expect(result.status).toBe(1);
      expectGateStoppedAtScopedDoctor(repo);
      expect(result.output).toMatch(/\[warn\] adf vendor bloat: Vendor file bloat detected:\n {4}CLAUDE\.md: /);
      // Only the staged file blocks; the unstaged one is reported apart.
      expect(result.output).toContain('GEMINI.md (not staged): ');
      expect(head(tmp)).toBe(before);
    });

    it('a non-bloat doctor WARN (malformed VENDORS entry) still blocks, even alongside a skipped file', { timeout: 60000 }, () => {
      const repo = writeHookFixtureRepo('gate-vendors', flavor);
      const tmp = repo.dir;
      fs.appendFileSync(path.join(tmp, '.ai', 'manifest.adf'), '\n\u{1F3F7} VENDORS:\n  - CLAUDE.md: bogus\n');
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + DB_BLOAT);
      git(tmp, 'add', 'CLAUDE.md');
      fs.appendFileSync(path.join(tmp, 'CLAUDE.md'), '- not staged yet\n');
      const before = head(tmp);

      const result = repo.commit('malformed vendors');

      expect(result.status).toBe(1);
      expectGateStoppedAtScopedDoctor(repo);
      expect(result.output).toContain('[warn] adf vendor mode:');
      expect(result.output).toContain("VENDORS entry 'CLAUDE.md: bogus'");
      expect(result.output).toContain('CLAUDE.md (auto-tidy skipped for it in this commit): ');
      expect(result.output).toContain('[pre-commit] ADF verification FAILED.');
      expect(result.output).toContain(' doctor --adf-only --ci --staged --tidy-skipped "CLAUDE.md" --format text');
      expect(head(tmp)).toBe(before);
    });
  });

  describe('full generated hook with a verify:adf script', () => {
    const head = (tmp: string): string => git(tmp, 'rev-parse', 'HEAD');
    const withUnstagedGeminiBloat = (tmp: string): void => {
      fs.writeFileSync(path.join(tmp, 'GEMINI.md'), read(tmp, 'GEMINI.md') + DB_BLOAT);
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER.trimEnd() + '\n- pnpm 9\n');
      git(tmp, 'add', 'CLAUDE.md');
    };

    it('a failing custom command in verify:adf still blocks, and the hint names npm', { timeout: 60000 }, () => {
      const repo = writeHookFixtureRepo('verify-custom', {
        verifyAdf: { lockfile: 'package-lock.json', script: `${verifyAdfScript('{CLI}')} && node -e "process.exit(4)"` },
      });
      withUnstagedGeminiBloat(repo.dir);
      const before = head(repo.dir);

      const result = repo.commit('custom check fails');

      expect(result.status).toBe(1);
      expect(repo.calls()).toContain('adf evidence --auto-measure --ci --format json');
      expect(result.output).toContain('[pre-commit] ADF verification FAILED.');
      expect(result.output).toContain('  Run: npm run verify:adf (outside this hook');
      expect(repo.pnpmCalls()).toEqual([]);
      expect(scopeFiles(repo.dir)).toEqual([]);
      expect(head(repo.dir)).toBe(before);
    });

    it('a non-bloat WARN that only the doctor inside verify:adf sees still blocks', { timeout: 60000 }, () => {
      // Without --adf-only, doctor also wants .charter/config.json, which this repo lacks.
      const repo = writeHookFixtureRepo('verify-nonbloat', {
        verifyAdf: { lockfile: 'package-lock.json', script: '{CLI} doctor --ci --format json' },
      });
      withUnstagedGeminiBloat(repo.dir);
      const before = head(repo.dir);

      const result = repo.commit('config missing');

      expect(result.status).toBe(1);
      expect(repo.calls()).toContain('doctor --ci --format json');
      expect(result.output).toContain('"name": "config file"');
      expect(result.output).toContain(BLOAT_SCOPE_MSG.hookCheckedStderr);
      expect(result.output).toContain('[pre-commit] ADF verification FAILED.');
      expect(head(repo.dir)).toBe(before);
    });

    it('a pnpm-lock.yaml with pnpm on PATH runs verify:adf with pnpm', { timeout: 60000 }, () => {
      // The pnpm on PATH is the failing shim, so the commit fails: that proves which runner the hook chose.
      const repo = writeHookFixtureRepo('verify-pnpm', { verifyAdf: { lockfile: 'pnpm-lock.yaml' } });
      withUnstagedGeminiBloat(repo.dir);

      const result = repo.commit('pnpm repo');

      expect(result.status).toBe(1);
      expect(repo.pnpmCalls()).toEqual(['pnpm run verify:adf']);
      expect(result.output).toContain('  Run: pnpm run verify:adf (outside this hook');
      expect(scopeFiles(repo.dir)).toEqual([]);
    });

    it('verify:adf run by hand, outside the hook, still blocks on the unstaged bloat (as CI does)', { timeout: 60000 }, () => {
      const repo = writeHookFixtureRepo('verify-by-hand', { verifyAdf: { lockfile: 'package-lock.json' } });
      withUnstagedGeminiBloat(repo.dir);
      expect(repo.commit('clean claude edit').status).toBe(0);

      const r = spawnSync('npm', ['run', 'verify:adf'], {
        cwd: repo.dir, encoding: 'utf-8', shell: process.platform === 'win32', env: { ...process.env, CHARTER_HOOK_SCOPED_DOCTOR: '1' },
      });
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain('"name": "adf vendor bloat"');
      expect(r.stdout).toContain('"status": "WARN"');
      expect(`${r.stdout}${r.stderr}`).not.toContain(BLOAT_SCOPE_MSG.hookCheckedStderr);
    });

    const SCOPE_NOTICE = '[pre-commit] Could not write the scope token in the git dir, so this time the doctor inside verify:adf checks vendor bloat in every file, as CI does.';

    /** A `git` on the hook's PATH that answers the token's rev-parse its own way and passes everything else through. */
    function shimGitPath(repo: Repo, answer: string): void {
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();
      fs.writeFileSync(path.join(repo.binDir, 'git'), [
        '#!/bin/sh',
        'case "$*" in',
        `  "rev-parse --git-path ${HOOK_SCOPED_DOCTOR_FILE}-"*) ${answer} ;;`,
        'esac',
        `exec "${realGit}" "$@"`,
        '',
      ].join('\n'));
      fs.chmodSync(path.join(repo.binDir, 'git'), 0o755);
    }

    it.each([
      ['the token file cannot be written (its directory does not exist)', 'echo "/nonexistent-charter-dir/sub/token"; exit 0'],
      ['git rev-parse --git-path fails', 'echo "fatal: simulated" >&2; exit 128'],
    ])('when %s: one clear notice, no shell error, the hook carries on and verify:adf runs strict', { timeout: 60000 }, async (_label, answer) => {
      const repo = writeHookFixtureRepo('verify-unwritable', { verifyAdf: { lockfile: 'package-lock.json' } });
      shimGitPath(repo, answer);
      withUnstagedGeminiBloat(repo.dir);
      const before = head(repo.dir);

      // Run directly under sh: git would put its own git ahead of the shim on the hook's PATH.
      const result = await repo.runHook({}, true);

      expect(result.output).toContain(SCOPE_NOTICE);
      expect(result.output).not.toMatch(/cannot create|Directory nonexistent|No such file or directory|fatal: simulated/);
      // The hook did not abort: verify:adf ran, and its doctor was strict, so the unstaged bloat blocks (as CI would).
      expect(repo.calls()).toContain('doctor --adf-only --ci --format json');
      expect(result.output).not.toContain(BLOAT_SCOPE_MSG.hookCheckedStderr);
      expect(result.output).toContain('"name": "adf vendor bloat",');
      expect(result.status).toBe(1);
      expect(result.output).toContain('[pre-commit] ADF verification FAILED.');
      expect(head(repo.dir)).toBe(before);
      expect(scopeFiles(repo.dir)).toEqual([]);
    });

    it('two overlapping hook runs in one worktree each keep their own token file, and both relax', { timeout: 120000 }, async () => {
      // verify:adf first sleeps for HOOK_TEST_DELAY_MS, then lists the scope files it can see.
      const helperDir = makeTempDir('verify-overlap-helper');
      const delay = path.join(helperDir, 'delay.cjs');
      fs.writeFileSync(delay, [
        `const fs = require('fs');`,
        `setTimeout(() => {`,
        `  const names = fs.readdirSync('.git').filter(n => n.startsWith(${JSON.stringify(HOOK_SCOPED_DOCTOR_FILE)}));`,
        `  console.log('SCOPE FILES SEEN: ' + names.length);`,
        `}, Number(process.env.HOOK_TEST_DELAY_MS || 0));`,
        '',
      ].join('\n'));
      const repo = writeHookFixtureRepo('verify-overlap', {
        verifyAdf: { lockfile: 'package-lock.json', script: `node "${posix(delay)}" && ${verifyAdfScript('{CLI}')}` },
      });
      withUnstagedGeminiBloat(repo.dir);

      const slow = repo.runHook({ HOOK_TEST_DELAY_MS: '8000' });
      // Start the second run only once the first has written its token file.
      const deadline = Date.now() + 60000;
      while (scopeFiles(repo.dir).length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      expect(scopeFiles(repo.dir)).toHaveLength(1);
      const fast = await repo.runHook();
      // The fast run finished (its trap ran) while the slow one still sleeps: only the slow run's file remains.
      expect(scopeFiles(repo.dir)).toHaveLength(1);
      const slowResult = await slow;

      expect(fast.output).toContain('SCOPE FILES SEEN: 2');
      for (const r of [fast, slowResult]) {
        expect(r.output).toContain(BLOAT_SCOPE_MSG.hookCheckedStderr);
        expect(r.output).not.toContain(SCOPE_NOTICE);
        expect(r.status).toBe(0);
      }
      expect(slowResult.output).toContain('SCOPE FILES SEEN: 1');
      expect(scopeFiles(repo.dir)).toEqual([]);
    });
  });

  it('a gitignored .ai/ (local-only setup) is not WIP: tidy runs, ignored modules are reported and never staged', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('ignored-ai');
    const tmp = repo.dir;
    git(tmp, 'rm', '-r', '-q', '--cached', '.ai');
    fs.appendFileSync(path.join(tmp, '.gitignore'), '.ai/\n');
    git(tmp, 'add', '.gitignore');
    git(tmp, 'commit', '-q', '--no-verify', '-m', 'local-only .ai');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + DB_BLOAT);
    git(tmp, 'add', 'CLAUDE.md');

    const result = commit(tmp, 'tidy with ignored .ai');

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('Auto-tidy skipped');
    expect(result.output).toContain('[pre-commit] Gitignored, so left as-is and not staged: .ai/backend.adf');
    expect(show(tmp, 'HEAD:CLAUDE.md')).not.toContain('## Database Rules');
    expect(read(tmp, '.ai/backend.adf')).toContain('All database migrations must be reversible');
    expect(committedFiles(tmp)).toEqual(['CLAUDE.md']);
    expect(porcelain(tmp)).toEqual([]);
  });

  it('a single ignored module that tidy creates is reported, not staged, and never aborts the hook', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('ignored-module');
    const tmp = repo.dir;
    git(tmp, 'rm', '-q', '--cached', '.ai/backend.adf');
    fs.rmSync(path.join(tmp, '.ai', 'backend.adf'));
    fs.appendFileSync(path.join(tmp, '.gitignore'), '.ai/backend.adf\n');
    git(tmp, 'add', '.gitignore');
    git(tmp, 'commit', '-q', '--no-verify', '-m', 'ignore backend.adf');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + DB_BLOAT);
    git(tmp, 'add', 'CLAUDE.md');

    const result = commit(tmp, 'tidy creates an ignored module');

    expect(result.status).toBe(0);
    expect(result.output).toContain('[pre-commit] Gitignored, so left as-is and not staged: .ai/backend.adf');
    expect(result.output).not.toContain('paths are ignored');
    expect(fs.existsSync(path.join(tmp, '.ai', 'backend.adf'))).toBe(true);
    expect(committedFiles(tmp)).toEqual(['CLAUDE.md']);
    expect(porcelain(tmp)).toEqual([]);
  });

  it('a git add failure is collected into one line and the tidy block carries on (H6)', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('add-fails', { tidyOnly: true });
    const tmp = repo.dir;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + DB_BLOAT);
    git(tmp, 'add', 'CLAUDE.md');
    // Stand in for any git add failure: the shim adds a planned path that does not
    // exist to both runs, so git add fails on it ("pathspec did not match").
    const result = commit(tmp, 'add fails', { HOOK_TEST_GHOST: '.ai/ghost.adf' });

    expect(result.status).toBe(0);
    expect(result.output).toContain('[pre-commit] Could not stage, left in the working tree; stage them yourself: .ai/ghost.adf');
    expect(result.output).not.toContain('fatal:');
    expect(show(tmp, 'HEAD:CLAUDE.md')).not.toContain('## Database Rules');
    expect(result.output).toContain('[pre-commit] Vendor files tidied; re-staged only the planned files tidy wrote.');
  });

  it('paths the real run wrote beyond the dry-run plan are named and left unstaged', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('diverge', { tidyOnly: true });
    const tmp = repo.dir;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + DB_BLOAT);
    git(tmp, 'add', 'CLAUDE.md');

    const result = commit(tmp, 'diverging run', { HOOK_TEST_EXTRA_WRITE: '.ai/extra.adf' });

    expect(result.status).toBe(0);
    expect(result.output).toContain('[pre-commit] Tidy also wrote files its dry run did not plan; left unstaged, review and stage them yourself: .ai/extra.adf');
    expect(committedFiles(tmp)).not.toContain('.ai/extra.adf');
    expect(porcelain(tmp)).toEqual(['?? .ai/extra.adf']);
  });

  it('handles a staged file whose name contains a space alongside a vendor file', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('space');
    const tmp = repo.dir;
    expect(tmp).toContain(' ');
    fs.writeFileSync(path.join(tmp, 'release notes.md'), '## Notes\n- shipped\n');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + DB_BLOAT);

    git(tmp, 'add', 'CLAUDE.md', 'release notes.md');
    expect(commit(tmp, 'space in name').status).toBe(0);

    expect(committedFiles(tmp)).toContain('release notes.md');
    expect(read(tmp, 'release notes.md')).toBe('## Notes\n- shipped\n');
    expect(show(tmp, 'HEAD:CLAUDE.md')).not.toContain('## Database Rules');
    expect(porcelain(tmp)).toEqual([]);
  });
});

/**
 * Integration tests: the real pre-commit hook in real git repos (#320).
 *
 * Each repo installs the hook `charter hook install --pre-commit` generates
 * (PRE_COMMIT_HOOK_CONTENT), with `npx charter` replaced by the built CLI behind
 * a logging shim, so these tests exercise the shipped text and can prove which
 * CLI calls the hook made. Paths are passed to the shell double-quoted with
 * forward slashes: Node accepts C:/... on Windows and Git's sh leaves them alone.
 * Every repo and the shim live under a directory whose name contains a space.
 *
 * The ADF evidence gate that follows the tidy block (doctor --adf-only --ci)
 * is unchanged by #320 and fails on vendor bloat left in the working tree. Tests
 * that deliberately leave bloat behind (a skipped or failed tidy) therefore
 * install the tidy block alone (`tidyOnly`), and one test pins that interaction.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { PRE_COMMIT_HOOK_CONTENT } from '../../commands/hook';

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
}

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
function writeHookFixtureRepo(label: string, opts: { tidyOnly?: boolean } = {}): Repo {
  const tmp = makeTempDir(label);
  const shimDir = makeTempDir(`${label}-shim`);
  const log = path.join(shimDir, 'calls.log');
  const shim = path.join(shimDir, 'charter shim.cjs');
  fs.writeFileSync(log, '');
  fs.writeFileSync(shim, [
    `const args = process.argv.slice(2);`,
    `require('fs').appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');`,
    `if (process.env.HOOK_TEST_FAIL_TIDY === '1' && args[0] === 'adf' && args[1] === 'tidy') process.exit(3);`,
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

  // The generated hook, as `charter hook install --pre-commit` writes it.
  const hookDir = path.join(tmp, '.githooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const full = PRE_COMMIT_HOOK_CONTENT.split('npx charter').join(`node "${posix(shim)}"`);
  const hook = opts.tidyOnly ? full.slice(0, full.indexOf('# ADF evidence gate')) : full;
  expect(hook).toContain('# Charter pre-commit vendor tidy: scoped to staged files');
  fs.writeFileSync(path.join(hookDir, 'pre-commit'), hook);
  fs.chmodSync(path.join(hookDir, 'pre-commit'), 0o755);
  git(tmp, 'config', 'core.hooksPath', '.githooks');

  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-m', 'initial');
  fs.writeFileSync(log, '');

  return {
    dir: tmp,
    calls: () => fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean),
  };
}

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
    expect(result.output).toContain('re-staged only the files tidy wrote');
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
    expect(result.output).toContain('[pre-commit] CLAUDE.md has unstaged changes; not auto-tidying it.');
    expect(tidyCalls(repo)).toEqual([]);
    expect(show(tmp, 'HEAD:CLAUDE.md')).toBe(staged);
    expect(read(tmp, 'CLAUDE.md')).toBe(worktree);
    expect(committedFiles(tmp)).toEqual(['CLAUDE.md']);
  });

  it.each([
    ['unstaged edits to a planned module', (tmp: string) => fs.appendFileSync(path.join(tmp, '.ai', 'backend.adf'), '  - wip rule\n'), ' M .ai/backend.adf'],
    ['a planned module deleted but not staged', (tmp: string) => fs.rmSync(path.join(tmp, '.ai', 'backend.adf')), ' D .ai/backend.adf'],
  ])('CP-4: %s blocks tidy for this commit, and the commit still succeeds', { timeout: 60000 }, (_label, makeWip, wipStatus) => {
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
    expect(result.output).toContain('[pre-commit] Not auto-tidying: tidy would write into files with unstaged work: .ai/backend.adf');
    expect(tidyCalls(repo)).toEqual(['adf tidy --dry-run --print-paths --source CLAUDE.md']);
    expect(show(tmp, 'HEAD:CLAUDE.md')).toBe(bloated);
    expect(committedFiles(tmp)).toEqual(['CLAUDE.md']);
    expect(fs.existsSync(path.join(tmp, '.ai', 'backend.adf')) ? read(tmp, '.ai/backend.adf') : null).toBe(before);
    expect(porcelain(tmp)).toEqual([wipStatus]);
  });

  it('CP-4: an untracked file at a planned module path blocks tidy', { timeout: 60000 }, () => {
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
    expect(result.output).toContain(`unstaged work: ${created}`);
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

  it('H6 boundary: the unchanged evidence gate still fails on bloat a skipped tidy left behind', { timeout: 60000 }, () => {
    const repo = writeHookFixtureRepo('gate');
    const tmp = repo.dir;
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), POINTER + DB_BLOAT);
    git(tmp, 'add', 'CLAUDE.md');
    fs.appendFileSync(path.join(tmp, 'CLAUDE.md'), '- not staged yet\n');

    const result = commit(tmp, 'partial with full hook');

    // The tidy block skipped the file without failing; the gate after it fails.
    expect(result.output).toContain('[pre-commit] CLAUDE.md has unstaged changes; not auto-tidying it.');
    expect(result.output).toContain('[pre-commit] ADF verification FAILED.');
    expect(result.status).toBe(1);
    expect(tidyCalls(repo)).toEqual([]);
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

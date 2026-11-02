import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HOOK_SCOPED_DOCTOR_ENV,
  HOOK_SCOPED_DOCTOR_FILE,
  HOOK_CLI,
  HOOK_CLI_PROBE_BLOCK,
  HOOK_CLI_RESOLVE_BLOCK,
  HOOK_TIDY_BLOCK_TEMPLATE,
  hookCommand,
  PRE_COMMIT_GATE_SCOPE_MARKER,
  PRE_COMMIT_VERIFY_SCOPE_MARKER,
  PRE_COMMIT_HOOK_CONTENT,
  PRE_COMMIT_HOOK_MARKER,
  PRE_COMMIT_PM_CLI_MARKER,
  PRE_COMMIT_SCOPE_MARKER,
  printClaudeHookConfig,
  renderHookTidyBlock,
} from '../commands/hook';
import { doctorCommand } from '../commands/doctor';
import type { CLIOptions } from '../index';

const baseOptions: CLIOptions = {
  configPath: '.charter',
  format: 'text',
  ciMode: false,
  yes: false,
};

describe('hookCommand', () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-hook-test-'));
    process.chdir(tempDir);
    execFileSync('git', ['init'], { stdio: 'ignore' });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('installs commit-msg hook', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await hookCommand(baseOptions, ['install', '--commit-msg']);
    expect(exitCode).toBe(0);

    const hookPath = path.join(tempDir, '.git', 'hooks', 'commit-msg');
    expect(fs.existsSync(hookPath)).toBe(true);
    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('Managed by Charter: commit-msg trailer normalizer');
    expect(content).toContain('Charter commit-msg trailer gate');
    expect(content).toContain('git interpret-trailers --in-place');
    expect(content).toContain('git.requireTrailers');
  });

  describe('generated commit-msg hook as a trailer gate (#299)', () => {
    // Drives the real hook through `git commit` so git's own sh runs it from the
    // repo root with relative paths; no absolute Windows paths reach the shell.
    function setupRepo(config?: string): void {
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test'], { stdio: 'ignore' });
      if (config !== undefined) {
        fs.mkdirSync('.charter', { recursive: true });
        fs.writeFileSync(path.join('.charter', 'config.json'), config);
      }
    }

    async function installHook(): Promise<void> {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await hookCommand(baseOptions, ['install', '--commit-msg'])).toBe(0);
    }

    function commit(message: string) {
      return spawnSync('git', ['commit', '--allow-empty', '-q', '-m', message], { encoding: 'utf-8' });
    }

    function lastMessage(): string {
      return execFileSync('git', ['log', '-1', '--format=%B'], { encoding: 'utf-8' });
    }

    const strict = JSON.stringify({ git: { requireTrailers: true }, validation: { citationStrictness: 'FAIL' } });

    it('rejects a message with no trailer when requireTrailers is on', { timeout: 30000 }, async () => {
      setupRepo(strict);
      await installHook();

      const result = commit('feat: no trailer here');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('git.requireTrailers is on');
      expect(result.stderr).toContain('Governed-By: ADR-001');
      expect(spawnSync('git', ['rev-parse', '--verify', 'HEAD']).status).not.toBe(0);
    });

    it('rejects under the default strictness, and ignores a trailer-like line outside the trailer block', { timeout: 30000 }, async () => {
      setupRepo(JSON.stringify({ git: { requireTrailers: true } }));
      await installHook();

      // Same rule as charter validate: only the terminal trailer block counts.
      const result = commit('feat: thing\n\nGoverned-By:\n\nmore body text');

      expect(result.status).toBe(1);
    });

    it('accepts either trailer, case-insensitively, and still normalizes it', { timeout: 30000 }, async () => {
      setupRepo(strict);
      await installHook();

      expect(commit('feat: governed\n\ngoverned-by:   ADR-007').status).toBe(0);
      expect(lastMessage()).toContain('Governed-By: ADR-007');

      expect(commit('feat: request\n\nResolves-Request: REQ-12').status).toBe(0);
      expect(lastMessage()).toContain('Resolves-Request: REQ-12');
    });

    it('moves a body-only Governed-By line into the trailer block and accepts it', { timeout: 30000 }, async () => {
      setupRepo(strict);
      await installHook();

      expect(commit('feat: misplaced\n\nGoverned-By: ADR-003\n\ntrailing paragraph').status).toBe(0);
      expect(lastMessage().trimEnd().endsWith('Governed-By: ADR-003')).toBe(true);
    });

    it('only warns when citation strictness is advisory', { timeout: 30000 }, async () => {
      setupRepo(JSON.stringify({ git: { requireTrailers: true }, validation: { citationStrictness: 'WARN' } }));
      await installHook();

      const result = commit('chore: advisory');

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('not blocking');
    });

    it('blocks under advisory strictness when ci.failOnWarn makes CI fail', { timeout: 30000 }, async () => {
      setupRepo(JSON.stringify({
        git: { requireTrailers: true },
        validation: { citationStrictness: 'WARN' },
        ci: { failOnWarn: true },
      }));
      await installHook();

      expect(commit('chore: fails on warn').status).toBe(1);
    });

    // loadConfig merges each section over requireTrailers: true and
    // citationStrictness: FAIL and tests requireTrailers for truthiness, so
    // charter validate --ci fails all of these; the hook must too.
    it.each([
      ['requireTrailers is absent', JSON.stringify({ git: {} })],
      ['the git section is absent', JSON.stringify({ project: 'x' })],
      ['requireTrailers is a truthy non-boolean', JSON.stringify({ git: { requireTrailers: 'true' } })],
    ])('rejects when %s, as loadConfig defaults do', { timeout: 30000 }, async (_label, config) => {
      setupRepo(config);
      await installHook();

      const result = commit('chore: ungoverned');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Governed-By: ADR-001');
    });

    it('rejects under the defaults when the config is malformed JSON, and says why', { timeout: 30000 }, async () => {
      setupRepo('{ "git": { "requireTrailers": false ');
      await installHook();

      const result = commit('chore: ungoverned');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('.charter/config.json is unparseable');
    });

    it('does not block when requireTrailers is false', { timeout: 30000 }, async () => {
      setupRepo(JSON.stringify({ git: { requireTrailers: false } }));
      await installHook();

      const result = commit('chore: ungoverned');

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('[commit-msg]');
    });

    it('skips the gate with a warning when there is no config file', { timeout: 30000 }, async () => {
      setupRepo(undefined);
      await installHook();

      const result = commit('chore: ungoverned');

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('no .charter/config.json; trailer gate skipped');
    });

    it('agrees with doctor: a config doctor treats as strict is one the hook enforces', { timeout: 30000 }, async () => {
      setupRepo(JSON.stringify({ git: {} }));
      await installHook();

      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => logs.push(args.map(String).join(' ')));
      await doctorCommand({ ...baseOptions, format: 'json' }, []);
      const checks = (JSON.parse(logs.join('\n')) as { checks: Array<{ name: string; status: string }> }).checks;

      expect(checks.find(check => check.name === 'gate enforcement')?.status).toBe('PASS');
      expect(commit('chore: ungoverned').status).toBe(1);
    });
  });

  describe('pre-commit tidy block (#320)', () => {
    const REPO_CLI = 'node packages/cli/dist/bin.js';
    const repoHook = (): string => fs.readFileSync(path.resolve(__dirname, '../../../../.githooks/pre-commit'), 'utf-8').replace(/\r\n/g, '\n');

    /** From the block's first comment to the `fi` that closes it, inclusive. */
    function tidyBlock(script: string): string {
      const start = script.indexOf('# Vendor file auto-tidy');
      const end = script.indexOf('\n# ADF evidence gate');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return script.slice(start, end);
    }

    async function generatedHook(): Promise<string> {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await hookCommand(baseOptions, ['install', '--pre-commit'])).toBe(0);
      return fs.readFileSync(path.join(tempDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
    }

    it('INV-P4-4: the generated and repo blocks are the template, differing only in {CLI}', async () => {
      const generated = tidyBlock(await generatedHook());
      const repo = tidyBlock(repoHook());
      expect(generated).toBe(renderHookTidyBlock(HOOK_CLI));
      expect(repo).toBe(renderHookTidyBlock(REPO_CLI));
      expect(generated.split(HOOK_CLI).join('{CLI}')).toBe(repo.split(REPO_CLI).join('{CLI}'));
      expect(generated.split(HOOK_CLI).join('{CLI}')).toBe(HOOK_TIDY_BLOCK_TEMPLATE);
    });

    it('pins the scope marker, the compiled fast path, --print-paths and staged-only re-staging', async () => {
      const hook = await generatedHook();
      for (const block of [tidyBlock(hook), tidyBlock(repoHook())]) {
        expect(block).toContain(PRE_COMMIT_SCOPE_MARKER);
        expect(block).toContain("grep -q 'GENERATED by charter adf compile' \"$vf\"");
        expect(block).toContain('adf tidy --dry-run --print-paths $SOURCES');
        expect(block).toContain('adf tidy --print-paths $SOURCES');
        expect(block).toContain('git diff --cached --name-only --diff-filter=d');
        expect(block).toContain('VENDOR_FILES="CLAUDE.md .cursorrules AGENTS.md agents.md GEMINI.md copilot-instructions.md .github/copilot-instructions.md"');
        // CP-1: only files tidy wrote are staged; the .ai/ sweep is gone for good.
        expect(block).not.toMatch(/git add[^\n]*\.ai\/\*/);
        expect(block.match(/git add --/g)).toEqual(['git add --']);
        expect(block).toContain('elif ! git add -- "$f" 2>/dev/null; then');
        expect(block).toContain('git check-ignore -q -- "$p"');
        expect(block).toContain('f="${line#*:}"');
        // #320 note: the whole-tree totalExtracted grep is gone deliberately.
        expect(block).not.toContain('totalExtracted');
      }
      expect(hook).toContain(PRE_COMMIT_HOOK_MARKER);
      expect(hook).toBe(PRE_COMMIT_HOOK_CONTENT);
    });

    it('INV-P4-7: the tidy block uses no bash-only syntax, jq or node -e', async () => {
      const block = tidyBlock(await generatedHook());
      expect(block).not.toMatch(/\[\[|\bjq\b|node -e|\blocal\b|\bdeclare\b|<<<|\$\(\(|\bfunction\b|==/);
      expect(block).not.toMatch(/\w+=\(/);
    });

    it.each([
      ['sh', ['-n']],
      ['dash', ['-n']],
      ['bash', ['--posix', '-n']],
    ])('INV-P4-7: %s parses the generated and repo hooks', async (shell, flags) => {
      const probe = spawnSync(shell, ['-c', 'exit 0']);
      if (probe.error || probe.status !== 0) return; // shell not installed here
      await generatedHook();
      const files = [path.join(tempDir, '.git', 'hooks', 'pre-commit'), path.resolve(__dirname, '../../../../.githooks/pre-commit')];
      for (const file of files) {
        const result = spawnSync(shell, [...flags, file], { encoding: 'utf-8' });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
      }
    });
  });

  describe('doctor: pre-commit hook row (#320)', () => {
    const OLD_HOOK = `#!/usr/bin/env sh\n${PRE_COMMIT_HOOK_MARKER}\nset -eu\n\n# Vendor file auto-tidy: extract bloat from staged vendor config files\ngit add .ai/*.adf 2>/dev/null || true\n`;
    // The gate #360 shipped: scoped only when package.json has no verify:adf script.
    const GATE_360 = `# ADF evidence gate: check LOC ceilings if manifest exists
${PRE_COMMIT_GATE_SCOPE_MARKER}
if [ -f ".ai/manifest.adf" ]; then
  echo '[pre-commit] Running ADF evidence check...'
  if [ -f "package.json" ] && grep -q '"verify:adf"' package.json; then
    pnpm run verify:adf || {
      echo ''
      echo '[pre-commit] ADF verification FAILED.'
      echo '  Run: pnpm run verify:adf'
      exit 1
    }
  else
    npx charter doctor --adf-only --ci --staged --tidy-skipped "$TIDY_SKIPPED" --format text && npx charter adf evidence --auto-measure --ci || {
      exit 1
    }
  fi
fi
`;
    // A pre-#366 hook: no CLI resolution block, every call a bare `npx charter`.
    const toPre366 = (hook: string): string => hook
      .replace(`${HOOK_CLI_RESOLVE_BLOCK}${HOOK_CLI_PROBE_BLOCK}\n`, '')
      .split(HOOK_CLI).join('npx charter')
      .split('$CHARTER_RUN').join('npx charter');
    const HOOK_360 = toPre366(PRE_COMMIT_HOOK_CONTENT.slice(0, PRE_COMMIT_HOOK_CONTENT.indexOf('# ADF evidence gate'))) + GATE_360;
    const HOOK_365 = toPre366(PRE_COMMIT_HOOK_CONTENT);

    async function doctorChecks(): Promise<Array<{ name: string; status: string; details: string }>> {
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => logs.push(args.map(String).join(' ')));
      await doctorCommand({ ...baseOptions, format: 'json' }, []);
      vi.restoreAllMocks();
      return (JSON.parse(logs.join('\n')) as { checks: Array<{ name: string; status: string; details: string }> }).checks;
    }

    function writeHook(dir: string, content: string): void {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'pre-commit'), content);
    }

    it('INV-P4-8: INFO, naming the hook and the fix, for a pre-#320 Charter hook', async () => {
      writeHook(path.join(tempDir, '.git', 'hooks'), OLD_HOOK);
      const rows = (await doctorChecks()).filter(c => c.name === 'pre-commit hook');
      expect(rows).toEqual([{
        name: 'pre-commit hook',
        status: 'INFO',
        details: 'The Charter pre-commit hook at .git/hooks/pre-commit predates staged-only tidy: it tidies every vendor file and re-stages all of .ai/*.adf, which can sweep unrelated edits into a commit. Re-run: charter hook install --pre-commit',
      }]);
    });

    it('#357: INFO for a #356-era hook (staged-only tidy, unscoped gate)', async () => {
      // The #356 hook: the #360 text without the gate marker and with its unscoped gate.
      const hook356 = HOOK_360
        .replace(`${PRE_COMMIT_GATE_SCOPE_MARKER}\n`, '')
        .replace(/npx charter doctor --adf-only --ci --staged --tidy-skipped "\$TIDY_SKIPPED" --format text/, 'npx charter doctor --adf-only --ci --format text');
      expect(hook356).toContain(PRE_COMMIT_SCOPE_MARKER);
      expect(hook356).toContain('npx charter doctor --adf-only --ci --format text && ');
      expect(hook356).not.toContain(PRE_COMMIT_GATE_SCOPE_MARKER);
      writeHook(path.join(tempDir, '.git', 'hooks'), hook356);
      const rows = (await doctorChecks()).filter(c => c.name === 'pre-commit hook');
      expect(rows).toEqual([{
        name: 'pre-commit hook',
        status: 'INFO',
        details: 'The Charter pre-commit hook at .git/hooks/pre-commit predates the commit-scoped evidence gate: it blocks a commit on vendor bloat in files the commit does not include, and in files its tidy step skipped. Re-run: charter hook install --pre-commit',
      }]);

      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await hookCommand(baseOptions, ['install', '--pre-commit'])).toBe(0);
      vi.restoreAllMocks();
      expect((await doctorChecks()).some(c => c.name === 'pre-commit hook')).toBe(false);
    });

    it('#357: INFO for a #360-era hook (gate unscoped, and pnpm-only, in repos with verify:adf)', async () => {
      expect(HOOK_360).toContain(PRE_COMMIT_GATE_SCOPE_MARKER);
      expect(HOOK_360).not.toContain(PRE_COMMIT_VERIFY_SCOPE_MARKER);
      writeHook(path.join(tempDir, '.git', 'hooks'), HOOK_360);
      fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { 'verify:adf': 'charter doctor --adf-only --ci' } }));
      const rows = (await doctorChecks()).filter(c => c.name === 'pre-commit hook');
      expect(rows).toEqual([{
        name: 'pre-commit hook',
        status: 'INFO',
        details: 'The Charter pre-commit hook at .git/hooks/pre-commit predates the commit-scoped gate for repos with a verify:adf script, as this one has: it runs pnpm run verify:adf in place of that gate, so its doctor blocks a commit on vendor bloat in files the commit does not include, and the gate fails where pnpm is not installed. Re-run: charter hook install --pre-commit',
      }]);

      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await hookCommand(baseOptions, ['install', '--pre-commit'])).toBe(0);
      vi.restoreAllMocks();
      expect((await doctorChecks()).some(c => c.name === 'pre-commit hook')).toBe(false);
    });

    it.each([
      ['no package.json', null],
      ['a package.json without verify:adf', JSON.stringify({ scripts: { test: 'vitest' } })],
    ])('#357: no row for a #360-era hook with %s (its gate is already scoped there)', async (_label, pkg) => {
      writeHook(path.join(tempDir, '.git', 'hooks'), HOOK_360);
      if (pkg !== null) fs.writeFileSync(path.join(tempDir, 'package.json'), pkg);
      expect((await doctorChecks()).some(c => c.name === 'pre-commit hook')).toBe(false);
    });

    it('#366: HOOK_365 is the current hook minus CLI resolution', () => {
      expect(HOOK_365).toContain(PRE_COMMIT_VERIFY_SCOPE_MARKER);
      expect(HOOK_365).not.toContain(PRE_COMMIT_PM_CLI_MARKER);
      expect(HOOK_365).not.toContain(HOOK_CLI);
      expect(HOOK_365).toContain('  npx charter doctor --adf-only --ci --staged --tidy-skipped "$TIDY_SKIPPED" --format text || {');
      expect(HOOK_365).toContain('PLAN=$(npx charter adf tidy --dry-run --print-paths $SOURCES 2>&1)');
    });

    it.each([
      ['.pnp.cjs', '.pnp.cjs', ''],
      ['.pnp.js', '.pnp.js', ''],
      ['.yarnrc.yml nodeLinker: pnp', '.yarnrc.yml', 'yarnPath: .yarn/releases/yarn-4.5.0.cjs\nnodeLinker: pnp\n'],
      ['.yarnrc.yml nodeLinker: "pnp"', '.yarnrc.yml', 'nodeLinker: "pnp" # PnP\n'],
    ])('#366: INFO for a pre-#366 hook in a Yarn PnP repo (%s), gone after reinstall', async (_label, file, content) => {
      writeHook(path.join(tempDir, '.git', 'hooks'), HOOK_365);
      fs.writeFileSync(path.join(tempDir, file), content);
      const rows = (await doctorChecks()).filter(c => c.name === 'pre-commit hook');
      expect(rows).toEqual([{
        name: 'pre-commit hook',
        status: 'INFO',
        details: "The Charter pre-commit hook at .git/hooks/pre-commit runs Charter with npx charter, which cannot find a Charter installed under Yarn Plug'n'Play, as this repo uses, so its gate fails unless Charter is also installed globally. Re-run: charter hook install --pre-commit (the new hook runs yarn charter)",
      }]);

      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await hookCommand(baseOptions, ['install', '--pre-commit'])).toBe(0);
      vi.restoreAllMocks();
      expect((await doctorChecks()).some(c => c.name === 'pre-commit hook')).toBe(false);
    });

    it.each([
      ['no lockfile', null, ''],
      ['yarn.lock (node_modules linker)', 'yarn.lock', ''],
      ['.yarnrc.yml nodeLinker: node-modules', '.yarnrc.yml', 'nodeLinker: node-modules\n'],
      ['.yarnrc.yml nodeLinker: pnpm', '.yarnrc.yml', 'nodeLinker: pnpm\n'],
      ['pnpm-lock.yaml', 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n"],
    ])('#366: no row for a pre-#366 hook outside Yarn PnP (%s): npx charter still finds node_modules/.bin there', async (_label, file, content) => {
      writeHook(path.join(tempDir, '.git', 'hooks'), HOOK_365);
      if (file !== null) fs.writeFileSync(path.join(tempDir, file), content);
      expect((await doctorChecks()).some(c => c.name === 'pre-commit hook')).toBe(false);
    });

    it('#357: the generated gate always runs the scoped doctor, then verify:adf (with the token) or evidence', () => {
      const gate = PRE_COMMIT_HOOK_CONTENT.slice(PRE_COMMIT_HOOK_CONTENT.indexOf('\n# ADF evidence gate'));
      expect(gate).toContain(PRE_COMMIT_GATE_SCOPE_MARKER);
      expect(gate).toContain(PRE_COMMIT_VERIFY_SCOPE_MARKER);
      const doctorAt = gate.indexOf('  charter_cli doctor --adf-only --ci --staged --tidy-skipped "$TIDY_SKIPPED" --format text || {');
      const branchAt = gate.indexOf(`if [ -f "package.json" ] && grep -q '"verify:adf"' package.json; then`);
      // The scoped doctor runs before, and outside, the verify:adf branch.
      expect(doctorAt).toBeGreaterThan(-1);
      expect(branchAt).toBeGreaterThan(doctorAt);
      expect(gate).toContain('    "$PM" run verify:adf || {');
      expect(gate).not.toContain('pnpm run verify:adf');
      // One file per hook run, named after its token; a failing rev-parse never aborts the hook.
      expect(gate).toContain(`SCOPE_FILE=$(git rev-parse --git-path "${HOOK_SCOPED_DOCTOR_FILE}-$SCOPE_TOKEN" 2>/dev/null) || SCOPE_FILE=""`);
      // The braces put the redirection's own error under 2>/dev/null too.
      expect(gate).toContain(`if [ -n "$SCOPE_FILE" ] && { printf '%s\\n' "$SCOPE_TOKEN" > "$SCOPE_FILE"; } 2>/dev/null; then`);
      expect(gate).toContain('[pre-commit] Could not write the scope token in the git dir');
      expect(gate).toContain(`      ${HOOK_SCOPED_DOCTOR_ENV}="$SCOPE_TOKEN"\n      export ${HOOK_SCOPED_DOCTOR_ENV}\n`);
      expect(gate).toContain(`trap 'rm -f "$SCOPE_FILE"' EXIT`);
      expect(gate).toContain('    charter_cli adf evidence --auto-measure --ci || {');
      expect(gate).not.toContain('Blocked because');
      expect(gate).not.toContain('totalExtracted');
      // #366: no bare npx charter; two calls through charter_cli, three echoed hints naming $CHARTER_RUN.
      expect(gate).not.toContain('npx charter');
      expect(gate.match(/^\s*charter_cli /gm)?.length).toBe(2);
      expect(gate.match(/Run: \$CHARTER_RUN /g)?.length).toBe(3);
    });

    it('re-running hook install --pre-commit replaces the old hook without --force, and the row goes away', async () => {
      writeHook(path.join(tempDir, '.git', 'hooks'), OLD_HOOK);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await hookCommand(baseOptions, ['install', '--pre-commit'])).toBe(0);
      vi.restoreAllMocks();
      expect(fs.readFileSync(path.join(tempDir, '.git', 'hooks', 'pre-commit'), 'utf-8')).toBe(PRE_COMMIT_HOOK_CONTENT);
      expect((await doctorChecks()).some(c => c.name === 'pre-commit hook')).toBe(false);
    });

    it.each([
      ['a current hook', PRE_COMMIT_HOOK_CONTENT],
      ['a foreign hook', '#!/usr/bin/env sh\necho custom\ngit add .ai/*.adf\n'],
      ['no hook', null],
    ])('no row at all for %s', async (_label, content) => {
      if (content !== null) writeHook(path.join(tempDir, '.git', 'hooks'), content);
      const checks = await doctorChecks();
      expect(checks.some(c => c.name === 'pre-commit hook')).toBe(false);
    });

    it('honours core.hooksPath: reads the configured dir, not .git/hooks', async () => {
      writeHook(path.join(tempDir, '.git', 'hooks'), OLD_HOOK);
      writeHook(path.join(tempDir, 'custom hooks'), PRE_COMMIT_HOOK_CONTENT);
      execFileSync('git', ['config', 'core.hooksPath', 'custom hooks'], { stdio: 'ignore' });
      expect((await doctorChecks()).some(c => c.name === 'pre-commit hook')).toBe(false);

      writeHook(path.join(tempDir, 'custom hooks'), OLD_HOOK);
      const row = (await doctorChecks()).find(c => c.name === 'pre-commit hook');
      expect(row?.status).toBe('INFO');
      expect(row?.details).toContain('custom hooks/pre-commit');
    });

    it('INV-P4-8: the row never makes doctor --ci fail', async () => {
      writeHook(path.join(tempDir, '.git', 'hooks'), OLD_HOOK);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const withOld = await doctorCommand({ ...baseOptions, ciMode: true, format: 'json' }, ['--adf-only']);
      fs.rmSync(path.join(tempDir, '.git', 'hooks', 'pre-commit'));
      const without = await doctorCommand({ ...baseOptions, ciMode: true, format: 'json' }, ['--adf-only']);
      expect(withOld).toBe(without);
    });
  });

  it('skips existing non-charter hook without --force', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const hookPath = path.join(tempDir, '.git', 'hooks', 'commit-msg');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/usr/bin/env sh\necho "custom"\n');

    const exitCode = await hookCommand(baseOptions, ['install', '--commit-msg']);
    expect(exitCode).toBe(0);

    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('echo "custom"');
  });

  it('surfaces a CLIError (not a raw fs Error) when the hook file cannot be written', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Point the hooks dir at an existing regular file so creating the hooks
    // directory fails for real — no fs mocking, exercises the actual guard.
    const blocker = path.join(tempDir, 'blocker');
    fs.writeFileSync(blocker, 'i am a file, not a directory');
    execFileSync('git', ['config', 'core.hooksPath', blocker], { stdio: 'ignore' });

    await expect(hookCommand(baseOptions, ['install', '--commit-msg'])).rejects.toMatchObject({
      name: 'CLIError',
      message: expect.stringContaining('Could not write git hook'),
    });
  });

  it('hook print --claude returns 0 and outputs UserPromptSubmit config', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const exitCode = await hookCommand(baseOptions, ['print', '--claude']);
    expect(exitCode).toBe(0);

    const output = logs.join('\n');
    expect(output).toContain('UserPromptSubmit');
    expect(output).toContain('charter context-refresh --once');
  });

  it('printClaudeHookConfig outputs valid JSON with correct shape', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    printClaudeHookConfig();

    const output = logs.join('\n');
    const parsed = JSON.parse(output) as {
      hooks: { UserPromptSubmit: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
    };
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toBe('charter context-refresh --once');
  });

  it('hook print without --claude throws', async () => {
    await expect(hookCommand(baseOptions, ['print'])).rejects.toThrow('hook print requires --claude');
  });

  describe('hook print --mcp-config', () => {
    it('returns 0 and emits mcpServers JSON to stdout', async () => {
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const exitCode = await hookCommand(baseOptions, ['print', '--mcp-config']);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(logs.join('\n')) as { mcpServers: { charter: { command: string; args: string[] } } };
      expect(parsed.mcpServers.charter.command).toBe('charter');
      expect(parsed.mcpServers.charter.args).toEqual(['serve']);
    });

    it('defaults to --client claude when --client is absent', async () => {
      const errors: string[] = [];
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });

      await hookCommand(baseOptions, ['print', '--mcp-config']);
      expect(errors.join('\n')).toContain('.claude/settings.json');
    });

    it('--client cursor emits .mcp.json hint', async () => {
      const errors: string[] = [];
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });

      await hookCommand(baseOptions, ['print', '--mcp-config', '--client', 'cursor']);
      expect(errors.join('\n')).toContain('.mcp.json');
    });

    it('--ai-dir adds --ai-dir to server args', async () => {
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await hookCommand(baseOptions, ['print', '--mcp-config', '--ai-dir', 'custom/ai']);
      const parsed = JSON.parse(logs.join('\n')) as { mcpServers: { charter: { args: string[] } } };
      expect(parsed.mcpServers.charter.args).toEqual(['serve', '--ai-dir', 'custom/ai']);
    });

    it('unknown --client value falls back to claude', async () => {
      const errors: string[] = [];
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });

      await hookCommand(baseOptions, ['print', '--mcp-config', '--client', 'vscode']);
      expect(errors.join('\n')).toContain('.claude/settings.json');
    });
  });
});

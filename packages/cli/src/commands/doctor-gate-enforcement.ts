import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit } from '../git-helpers';
import { PRE_COMMIT_GATE_SCOPE_MARKER, PRE_COMMIT_HOOK_MARKER, PRE_COMMIT_PM_CLI_MARKER, PRE_COMMIT_SCOPE_MARKER, PRE_COMMIT_VERIFY_SCOPE_MARKER } from './hook';

interface GateEnforcementCheck {
  name: 'gate enforcement';
  status: 'PASS' | 'WARN';
  details: string;
}

const COMMIT_MSG_NORMALIZER_MARKER = 'Managed by Charter: commit-msg trailer normalizer';
// Present only in commit-msg hooks generated since #299, which reject missing trailers.
const COMMIT_MSG_GATE_MARKER = 'Charter commit-msg trailer gate';

/** Check whether a strict trailer policy has a local hook or CI gate wired. */
export function checkGateEnforcement(): GateEnforcementCheck {
  const hooksDir = resolveHooksDir();
  const hook = findValidateHook(hooksDir);
  const workflow = findValidateWorkflow('.github/workflows');

  if (hook || workflow) {
    const mechanisms = [
      hook ? `Local validation hook: ${hook}` : '',
      workflow ? `CI validation: ${workflow}` : '',
    ].filter(Boolean);
    return {
      name: 'gate enforcement',
      status: 'PASS',
      details: `Strict trailer gate wired. ${mechanisms.join('; ')}.`,
    };
  }

  const normalizer = findCommitMsgNormalizer(hooksDir);
  const normalizerNote = normalizer
    ? ` The Charter commit-msg hook at ${normalizer} normalizes supplied trailers but does not reject missing trailers; re-run "charter hook install --commit-msg" to replace it with the trailer gate.`
    : '';
  return {
    name: 'gate enforcement',
    status: 'WARN',
    details: `git.requireTrailers is true with strict citation validation, but no local hook or CI step invokes "charter validate --ci". Active hooks directory: ${displayPath(hooksDir)}.${normalizerNote} Add charter validate --ci to CI or an enforcing git hook.`,
  };
}

interface PreCommitScopeCheck {
  name: 'pre-commit hook';
  status: 'INFO';
  details: string;
}

export const DOCTOR_OLD_PRE_COMMIT_MSG = 'The Charter pre-commit hook at {hookPath} predates staged-only tidy: it tidies every vendor file and re-stages all of .ai/*.adf, which can sweep unrelated edits into a commit. Re-run: charter hook install --pre-commit';
export const DOCTOR_UNSCOPED_GATE_MSG = 'The Charter pre-commit hook at {hookPath} predates the commit-scoped evidence gate: it blocks a commit on vendor bloat in files the commit does not include, and in files its tidy step skipped. Re-run: charter hook install --pre-commit';
export const DOCTOR_VERIFY_ADF_GATE_MSG = 'The Charter pre-commit hook at {hookPath} predates the commit-scoped gate for repos with a verify:adf script, as this one has: it runs pnpm run verify:adf in place of that gate, so its doctor blocks a commit on vendor bloat in files the commit does not include, and the gate fails where pnpm is not installed. Re-run: charter hook install --pre-commit';
export const DOCTOR_PNP_CLI_MSG = 'The Charter pre-commit hook at {hookPath} runs Charter with npx charter, which cannot find a Charter installed under Yarn Plug\'n\'Play, as this repo uses, so its gate fails unless Charter is also installed globally. Re-run: charter hook install --pre-commit (the new hook runs yarn charter)';

/**
 * INFO when the active pre-commit hook is a Charter-generated one from before
 * #320 (it carries PRE_COMMIT_HOOK_MARKER but not PRE_COMMIT_SCOPE_MARKER), or
 * from #320 but before #357 (no PRE_COMMIT_GATE_SCOPE_MARKER), or from #360
 * (no PRE_COMMIT_VERIFY_SCOPE_MARKER) in a repo whose package.json has a
 * verify:adf script. A #360 hook without that script already runs the scoped
 * doctor and then adf evidence, exactly as the current hook does there, so it
 * gets no row: there is nothing to fix. The script test is the hook's own
 * (`grep '"verify:adf"' package.json` at the repo root), so the row appears as
 * soon as the hook would take the unscoped path. A pre-#366 hook (no
 * PRE_COMMIT_PM_CLI_MARKER) gets a row only in a Yarn PnP repo, the one place
 * its `npx charter` cannot find a locally installed Charter.
 * Undefined, so no row at all, for a current, foreign or missing hook.
 * INFO, not WARN: doctor --ci fails on WARN, and an old hook over-stages but
 * enforces nothing less, so warning would break CI on upgrade (#186).
 */
export function checkPreCommitScope(): PreCommitScopeCheck | undefined {
  const hookPath = path.join(resolveHooksDir(), 'pre-commit');
  const content = readText(hookPath);
  if (!content.includes(PRE_COMMIT_HOOK_MARKER)) return undefined;
  const message = !content.includes(PRE_COMMIT_SCOPE_MARKER) ? DOCTOR_OLD_PRE_COMMIT_MSG
    : !content.includes(PRE_COMMIT_GATE_SCOPE_MARKER) ? DOCTOR_UNSCOPED_GATE_MSG
      : !content.includes(PRE_COMMIT_VERIFY_SCOPE_MARKER) && repoHasVerifyAdfScript() ? DOCTOR_VERIFY_ADF_GATE_MSG
        : !content.includes(PRE_COMMIT_PM_CLI_MARKER) && repoUsesYarnPnp() ? DOCTOR_PNP_CLI_MSG
          : undefined;
  if (!message) return undefined;
  return {
    name: 'pre-commit hook',
    status: 'INFO',
    details: message.replace('{hookPath}', displayPath(hookPath)),
  };
}

/**
 * The hook's own PnP test (#366): .pnp.cjs or .pnp.js at the repo root, or a
 * .yarnrc.yml whose nodeLinker is pnp. Same regex as HOOK_CLI_RESOLVE_BLOCK.
 */
function repoUsesYarnPnp(): boolean {
  const repoRoot = getGitPath(['rev-parse', '--show-toplevel']) || process.cwd();
  if (fs.existsSync(path.join(repoRoot, '.pnp.cjs')) || fs.existsSync(path.join(repoRoot, '.pnp.js'))) return true;
  return /^[ \t]*nodeLinker:[ \t]*["']?pnp(["' \t#]|$)/m.test(readText(path.join(repoRoot, '.yarnrc.yml')));
}

/** The hook's own test: package.json at the repo root mentions "verify:adf". */
function repoHasVerifyAdfScript(): boolean {
  const repoRoot = getGitPath(['rev-parse', '--show-toplevel']) || process.cwd();
  return readText(path.join(repoRoot, 'package.json')).includes('"verify:adf"');
}

function resolveHooksDir(): string {
  const repoRoot = getGitPath(['rev-parse', '--show-toplevel']) || process.cwd();
  const configured = getGitPath(['config', '--get', 'core.hooksPath']);
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured);
  }

  const gitHooksPath = getGitPath(['rev-parse', '--git-path', 'hooks']);
  return gitHooksPath
    ? path.isAbsolute(gitHooksPath) ? gitHooksPath : path.resolve(repoRoot, gitHooksPath)
    : path.resolve(repoRoot, '.git', 'hooks');
}

function getGitPath(args: string[]): string {
  try {
    return runGit(args).trim();
  } catch {
    return '';
  }
}

function findValidateHook(hooksDir: string): string | undefined {
  for (const name of ['commit-msg', 'pre-commit']) {
    const hookPath = path.join(hooksDir, name);
    const content = readText(hookPath);
    if (content && (invokesCharterValidate(content) || (name === 'commit-msg' && content.includes(COMMIT_MSG_GATE_MARKER)))) {
      return displayPath(hookPath);
    }
  }
  return undefined;
}

function findCommitMsgNormalizer(hooksDir: string): string | undefined {
  const hookPath = path.join(hooksDir, 'commit-msg');
  return readText(hookPath).includes(COMMIT_MSG_NORMALIZER_MARKER)
    ? displayPath(hookPath)
    : undefined;
}

function findValidateWorkflow(workflowsDir: string): string | undefined {
  if (!fs.existsSync(workflowsDir)) return undefined;

  let files: string[];
  try {
    files = fs.readdirSync(workflowsDir)
      .filter(file => /\.ya?ml$/i.test(file))
      .sort();
  } catch {
    return undefined;
  }

  for (const file of files) {
    const workflowPath = path.join(workflowsDir, file);
    const content = readText(workflowPath);
    if (content && invokesCharterValidate(content)) {
      return displayPath(workflowPath);
    }
  }
  return undefined;
}

function invokesCharterValidate(content: string): boolean {
  const uncommented = content
    .split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n');
  return /(?:\bcharter|(?:packages\/cli\/)?dist\/bin\.js)\s+validate\b[\s\\]*[^\n]{0,200}--ci\b/m.test(uncommented);
}

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function displayPath(targetPath: string): string {
  const relative = path.relative(process.cwd(), targetPath).replace(/\\/g, '/');
  return relative && !relative.startsWith('../') ? relative : targetPath.replace(/\\/g, '/');
}

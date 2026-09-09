import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit } from '../git-helpers';

interface GateEnforcementCheck {
  name: 'gate enforcement';
  status: 'PASS' | 'WARN';
  details: string;
}

const COMMIT_MSG_NORMALIZER_MARKER = 'Managed by Charter: commit-msg trailer normalizer';

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
    ? ` The Charter commit-msg hook at ${normalizer} normalizes supplied trailers but does not reject missing trailers.`
    : '';
  return {
    name: 'gate enforcement',
    status: 'WARN',
    details: `git.requireTrailers is true with strict citation validation, but no local hook or CI step invokes "charter validate --ci". Active hooks directory: ${displayPath(hooksDir)}.${normalizerNote} Add charter validate --ci to CI or an enforcing git hook.`,
  };
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
    if (content && invokesCharterValidate(content)) {
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

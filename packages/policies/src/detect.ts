import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FloatingPin {
  file: string;
  line: number;
  uses: string;
  tag: string;
}

export interface RepoConfig {
  packageManager: 'npm' | 'pnpm';
  nodeVersion: string;
  existingWorkflows: string[];
  floatingPins: FloatingPin[];
  hasSupplyChainWorkflow: boolean;
}

// Matches `uses: owner/action@vN[.N.N]` — excludes local (./) and Stackbilt-dev refs
const FLOATING_PIN_LINE_RE = /uses:\s+(?!Stackbilt-dev\/)(?!\.\/)[^\s@]+@(v[\d][\d.]*)/;

export function detectRepoConfig(repoPath: string): RepoConfig {
  const abs = path.resolve(repoPath);

  const packageManager: 'npm' | 'pnpm' = fs.existsSync(path.join(abs, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : 'npm';

  const nodeVersion = detectNodeVersion(abs);

  const workflowsDir = path.join(abs, '.github', 'workflows');
  const existingWorkflows: string[] = [];
  if (fs.existsSync(workflowsDir)) {
    for (const f of fs.readdirSync(workflowsDir)) {
      if (f.endsWith('.yml') || f.endsWith('.yaml')) {
        existingWorkflows.push(path.join(workflowsDir, f));
      }
    }
  }

  const floatingPins: FloatingPin[] = [];
  for (const wfPath of existingWorkflows) {
    const content = fs.readFileSync(wfPath, 'utf-8');
    content.split('\n').forEach((line, idx) => {
      const m = line.match(FLOATING_PIN_LINE_RE);
      if (m) {
        floatingPins.push({ file: wfPath, line: idx + 1, uses: line.trim(), tag: m[1] });
      }
    });
  }

  const hasSupplyChainWorkflow = existingWorkflows.some(
    (w) => path.basename(w) === 'supply-chain.yml' || path.basename(w) === 'supply-chain.yaml',
  );

  return { packageManager, nodeVersion, existingWorkflows, floatingPins, hasSupplyChainWorkflow };
}

function detectNodeVersion(repoPath: string): string {
  // .nvmrc
  const nvmrc = path.join(repoPath, '.nvmrc');
  if (fs.existsSync(nvmrc)) {
    const v = fs.readFileSync(nvmrc, 'utf-8').trim().replace(/^v/, '');
    if (/^\d+/.test(v)) return v;
  }

  // ci.yml matrix or single value
  const ciYml = path.join(repoPath, '.github', 'workflows', 'ci.yml');
  if (fs.existsSync(ciYml)) {
    const content = fs.readFileSync(ciYml, 'utf-8');
    const matrixMatch = content.match(/node-version:\s*\[([^\]]+)\]/);
    if (matrixMatch) {
      const nums = matrixMatch[1]
        .split(',')
        .map((v) => parseInt(v.trim().replace(/['"]/g, ''), 10))
        .filter(Boolean);
      if (nums.length > 0) return String(Math.max(...nums));
    }
    const singleMatch = content.match(/node-version:\s*['"]?(\d+)/);
    if (singleMatch) return singleMatch[1];
  }

  return '20';
}

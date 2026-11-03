import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const cli = path.resolve(__dirname, '../../dist/bin.js');
const fixtures: string[] = [];

function fixture(source = 'LLMProviders.fromEnv();\n', minScore?: number, security = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-drift-threshold-'));
  fixtures.push(dir);
  fs.mkdirSync(path.join(dir, '.charter', 'patterns'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.charter', 'config.json'), JSON.stringify({
    drift: { ...(minScore === undefined ? {} : { minScore }), include: ['**/*.ts'] },
  }));
  fs.writeFileSync(path.join(dir, '.charter', 'patterns', 'blessed.json'), JSON.stringify({
    name: 'Explicit Inference Clients', customized: true, anti_patterns: 'Avoid /LLMProviders\\.fromEnv/',
  }));
  if (security) {
    fs.writeFileSync(path.join(dir, '.charter', 'patterns', 'security-deny.json'), JSON.stringify({
      patterns: [{ name: 'Security Deny', anti_patterns: 'Avoid /dangerousSecret/' }],
    }));
  }
  fs.writeFileSync(path.join(dir, 'example.ts'), source);
  return dir;
}

function run(dir: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, 'drift', ...args], { cwd: dir, encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  return result;
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('drift threshold explanations (#411)', () => {
  it('explains why an ordinary violation passes the default CI threshold', () => {
    const result = run(fixture(), '--ci');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Drift Score: 90% (threshold: 70%)');
    expect(result.stdout).toContain('Violations (1)');
    expect(result.stdout).toContain('CI policy: PASS. Reported pattern violations are within');
    expect(result.stdout).toContain('do not fail --ci');
    expect(result.stdout).toContain('set drift.minScore to 1');
  });

  it('reports strict ordinary violations as CI failures', () => {
    const result = run(fixture(undefined, 1), '--ci');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('CI policy: FAIL. The drift score is below');
    expect(result.stdout).not.toContain('CI policy: PASS');
  });

  it('explains security blocking even when the score meets the default threshold', () => {
    const result = run(fixture('dangerousSecret();\n', undefined, true), '--ci');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Drift Score: 100% (threshold: 70%)');
    expect(result.stdout).toContain('Security blockers: 1');
    expect(result.stdout).toContain('Security deny violations block regardless');
    expect(result.stdout).not.toContain('CI policy: PASS');
  });

  it('keeps clean output free of violation-only guidance', () => {
    const result = run(fixture('const safe = true;\n'), '--ci');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No violations found.');
    expect(result.stdout).not.toContain('CI policy:');
    expect(result.stdout).not.toContain('set drift.minScore');
  });

  it('keeps JSON policy fields and their meaning unchanged', () => {
    const result = run(fixture(), '--ci', '--format', 'json');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(Object.keys(report).sort()).toEqual([
      'configPath', 'minScore', 'patternsCustomized', 'scannedFiles', 'scannedPatterns',
      'score', 'securityBlockers', 'status', 'thresholdPercent', 'timestamp', 'violations',
    ].sort());
    expect(report).toMatchObject({ status: 'PASS', score: 0.9, minScore: 0.7, securityBlockers: 0 });
    expect(report.violations).toHaveLength(1);
    expect(result.stdout).not.toContain('CI policy:');
  });

  it('does not turn non-CI reporting into a failing command', () => {
    const result = run(fixture(undefined, 1));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CI policy: FAIL.');
  });
});

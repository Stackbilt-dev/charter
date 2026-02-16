/**
 * charter doctor
 *
 * Prints environment and configuration diagnostics for humans and agents.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { loadPatterns } from '../config';

interface DoctorResult {
  status: 'PASS' | 'WARN';
  checks: Array<{
    name: string;
    status: 'PASS' | 'WARN';
    details: string;
  }>;
}

export async function doctorCommand(options: CLIOptions): Promise<number> {
  const checks: DoctorResult['checks'] = [];
  const configFile = path.join(options.configPath, 'config.json');
  const inGitRepo = isGitRepo();

  checks.push({
    name: 'git repository',
    status: inGitRepo ? 'PASS' : 'WARN',
    details: inGitRepo ? 'Repository detected.' : 'Not inside a git repository.',
  });

  const hasConfig = fs.existsSync(configFile);
  checks.push({
    name: 'config file',
    status: hasConfig ? 'PASS' : 'WARN',
    details: hasConfig ? `${configFile} exists.` : `${configFile} not found. Run charter setup.`,
  });

  if (hasConfig) {
    checks.push(validateJSONConfig(configFile));
  }

  const patterns = loadPatterns(options.configPath);
  checks.push({
    name: 'patterns',
    status: patterns.length > 0 ? 'PASS' : 'WARN',
    details: patterns.length > 0
      ? `${patterns.length} pattern(s) loaded.`
      : 'No patterns found in .charter/patterns/*.json.',
  });

  const policyDir = path.join(options.configPath, 'policies');
  const policyCount = fs.existsSync(policyDir)
    ? fs.readdirSync(policyDir).filter((f) => f.endsWith('.md')).length
    : 0;

  checks.push({
    name: 'policy docs',
    status: policyCount > 0 ? 'PASS' : 'WARN',
    details: policyCount > 0 ? `${policyCount} markdown policy file(s).` : 'No policy markdown files found.',
  });

  const hasWarn = checks.some((check) => check.status === 'WARN');
  const result: DoctorResult = {
    status: hasWarn ? 'WARN' : 'PASS',
    checks,
  };

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`  Doctor status: ${result.status}`);
    for (const check of result.checks) {
      const icon = check.status === 'PASS' ? '[ok]' : '[warn]';
      console.log(`  ${icon} ${check.name}: ${check.details}`);
    }
  }

  if (options.ciMode && hasWarn) {
    return EXIT_CODE.POLICY_VIOLATION;
  }

  return EXIT_CODE.SUCCESS;
}

function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function validateJSONConfig(configFile: string): DoctorResult['checks'][number] {
  try {
    JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    return {
      name: 'config parse',
      status: 'PASS',
      details: 'config.json is valid JSON.',
    };
  } catch {
    return {
      name: 'config parse',
      status: 'WARN',
      details: 'config.json is invalid JSON.',
    };
  }
}

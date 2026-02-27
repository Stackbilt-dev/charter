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
import { parseAdf, parseManifest } from '@stackbilt/adf';

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

  // ADF readiness checks
  const aiDir = '.ai';
  const manifestPath = path.join(aiDir, 'manifest.adf');
  const hasManifest = fs.existsSync(manifestPath);

  checks.push({
    name: 'adf manifest',
    status: hasManifest ? 'PASS' : 'WARN',
    details: hasManifest ? `${manifestPath} exists.` : `${manifestPath} not found. Run: charter adf init`,
  });

  if (hasManifest) {
    try {
      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifestDoc = parseAdf(manifestContent);
      const manifest = parseManifest(manifestDoc);

      checks.push({
        name: 'adf manifest parse',
        status: 'PASS',
        details: `Parsed: ${manifest.defaultLoad.length} default-load, ${manifest.onDemand.length} on-demand module(s).`,
      });

      // Check that all defaultLoad modules exist and parse
      const missingModules: string[] = [];
      for (const mod of manifest.defaultLoad) {
        const modPath = path.join(aiDir, mod);
        if (!fs.existsSync(modPath)) {
          missingModules.push(mod);
        } else {
          try {
            parseAdf(fs.readFileSync(modPath, 'utf-8'));
          } catch {
            missingModules.push(`${mod} (parse error)`);
          }
        }
      }

      checks.push({
        name: 'adf default modules',
        status: missingModules.length === 0 ? 'PASS' : 'WARN',
        details: missingModules.length === 0
          ? `All ${manifest.defaultLoad.length} default-load module(s) present and parseable.`
          : `Missing or unparseable: ${missingModules.join(', ')}`,
      });

      // Agent config pointer check: flag files with stack rules that should be in .ai/
      const AGENT_CONFIG_FILES = ['CLAUDE.md', '.cursorrules', 'agents.md', 'AGENTS.md', 'GEMINI.md', 'copilot-instructions.md'];
      const POINTER_MARKERS = ['Do not duplicate ADF rules here', 'Do not duplicate rules from .ai/'];
      const nonPointerFiles: string[] = [];
      for (const file of AGENT_CONFIG_FILES) {
        if (fs.existsSync(file)) {
          const content = fs.readFileSync(file, 'utf-8');
          const isPointer = POINTER_MARKERS.some(marker => content.includes(marker));
          if (!isPointer) {
            nonPointerFiles.push(file);
          }
        }
      }
      if (nonPointerFiles.length > 0) {
        checks.push({
          name: 'adf agent config',
          status: 'WARN',
          details: `${nonPointerFiles.join(', ')} contain${nonPointerFiles.length === 1 ? 's' : ''} stack rules that should live in .ai/. Run: charter adf migrate --dry-run`,
        });
      } else {
        const pointerCount = AGENT_CONFIG_FILES.filter(f => fs.existsSync(f)).length;
        if (pointerCount > 0) {
          checks.push({
            name: 'adf agent config',
            status: 'PASS',
            details: `${pointerCount} agent config file(s) are thin pointers to .ai/.`,
          });
        }
      }

      // Sync lock status
      if (manifest.sync.length > 0) {
        const lockFile = path.join(aiDir, '.adf.lock');
        const hasLock = fs.existsSync(lockFile);
        checks.push({
          name: 'adf sync lock',
          status: hasLock ? 'PASS' : 'WARN',
          details: hasLock
            ? `${lockFile} exists (${manifest.sync.length} sync entry/entries).`
            : `${lockFile} not found. Run: charter adf sync --write`,
        });
      }
    } catch {
      checks.push({
        name: 'adf manifest parse',
        status: 'WARN',
        details: `${manifestPath} failed to parse.`,
      });
    }
  }

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

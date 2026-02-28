/**
 * charter drift
 *
 * Scans files for governance drift - codebase patterns that violate
 * the blessed stack defined in .charter/patterns/.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { loadConfig, loadPatterns, getPatternCustomizationStatus } from '../config';
import { scanForDrift } from '@stackbilt/drift';
import type { DriftReport } from '@stackbilt/types';

export async function driftCommand(options: CLIOptions, args: string[]): Promise<number> {
  const config = loadConfig(options.configPath);

  if (!config.drift.enabled) {
    if (options.format === 'json') {
      console.log(JSON.stringify({
        status: 'PASS',
        summary: 'Drift scanning is disabled in config.',
        minScore: config.drift.minScore,
        thresholdPercent: Math.round(config.drift.minScore * 100),
        configPath: options.configPath,
      }, null, 2));
    } else {
      console.log('  Drift scanning is disabled in config.');
    }
    return EXIT_CODE.SUCCESS;
  }

  const patterns = loadPatterns(options.configPath);
  if (patterns.length === 0) {
    if (options.format === 'json') {
      console.log(JSON.stringify({
        status: 'WARN',
        summary: 'No patterns defined.',
        minScore: config.drift.minScore,
        thresholdPercent: Math.round(config.drift.minScore * 100),
        configPath: options.configPath,
      }, null, 2));
    } else {
      console.log('  No patterns defined in .charter/patterns/');
      console.log('  Run: charter init to create example patterns.');
    }
    return options.ciMode ? EXIT_CODE.POLICY_VIOLATION : EXIT_CODE.SUCCESS;
  }

  const scanPath = getFlag(args, '--path') || '.';
  const files = collectFiles(scanPath, config.drift.include, config.drift.exclude);

  if (Object.keys(files).length === 0) {
    if (options.format === 'json') {
      console.log(JSON.stringify({
        status: 'WARN',
        summary: 'No files matched the scan criteria.',
        minScore: config.drift.minScore,
        thresholdPercent: Math.round(config.drift.minScore * 100),
        configPath: options.configPath,
      }, null, 2));
    } else {
      console.log('  No files matched the scan criteria.');
    }
    return options.ciMode ? EXIT_CODE.POLICY_VIOLATION : EXIT_CODE.SUCCESS;
  }

  const report = scanForDrift(files, patterns);
  const status: 'PASS' | 'FAIL' = report.score >= config.drift.minScore ? 'PASS' : 'FAIL';
  const patternsCustomized = getPatternCustomizationStatus(options.configPath);
  const output = {
    status,
    minScore: config.drift.minScore,
    thresholdPercent: Math.round(config.drift.minScore * 100),
    configPath: options.configPath,
    patternsCustomized,
    ...report,
  };

  if (options.format === 'json') {
    console.log(JSON.stringify(output, null, 2));
  } else {
    printReport(report, config.drift.minScore, patternsCustomized);
  }

  if (options.ciMode && report.score < config.drift.minScore) {
    return EXIT_CODE.POLICY_VIOLATION;
  }

  return EXIT_CODE.SUCCESS;
}

function printReport(report: DriftReport, minScore: number, patternsCustomized: boolean | null): void {
  const icon = report.score >= minScore ? '[ok]' : '[fail]';
  const pct = Math.round(report.score * 100);

  console.log(`\n  ${icon} Drift Score: ${pct}% (threshold: ${Math.round(minScore * 100)}%)`);
  console.log(`     Scanned: ${report.scannedFiles} files against ${report.scannedPatterns} patterns`);
  if (patternsCustomized !== null) {
    console.log(`     Patterns customized: ${patternsCustomized ? 'yes' : 'no'}`);
  }

  if (report.violations.length > 0) {
    console.log(`\n  Violations (${report.violations.length}):`);

    const grouped = new Map<string, typeof report.violations>();
    for (const v of report.violations) {
      const existing = grouped.get(v.patternName) || [];
      existing.push(v);
      grouped.set(v.patternName, existing);
    }

    for (const [pattern, violations] of grouped) {
      console.log(`\n    Pattern: ${pattern}`);
      for (const v of violations.slice(0, 5)) {
        console.log(`      ${v.file}:${v.line} - ${v.snippet}`);
      }
      if (violations.length > 5) {
        console.log(`      ... and ${violations.length - 5} more`);
      }
    }
  } else {
    console.log('  No violations found.');
  }

  console.log('');
}

function collectFiles(
  rootPath: string,
  include: string[],
  exclude: string[]
): Record<string, string> {
  const files: Record<string, string> = {};
  const extensions = extractExtensions(include);
  const excludeDirs = extractDirNames(exclude);

  function walk(dir: string, relativeTo: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(relativeTo, fullPath);

      if (entry.isDirectory()) {
        if (!excludeDirs.includes(entry.name)) {
          walk(fullPath, relativeTo);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.length === 0 || extensions.includes(ext)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            files[relPath] = content;
          } catch {
            // Skip unreadable files.
          }
        }
      }
    }
  }

  walk(path.resolve(rootPath), path.resolve(rootPath));
  return files;
}

function extractExtensions(patterns: string[]): string[] {
  const exts: string[] = [];
  for (const p of patterns) {
    const match = p.match(/\*\.(\w+)$/);
    if (match) exts.push(`.${match[1]}`);
  }
  return exts;
}

function extractDirNames(patterns: string[]): string[] {
  const dirs: string[] = [];
  for (const p of patterns) {
    const match = p.match(/^([^*]+)\//);
    if (match) dirs.push(match[1]);
  }
  return dirs;
}

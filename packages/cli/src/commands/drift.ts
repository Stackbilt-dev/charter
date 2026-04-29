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
import type { DriftReport, DriftViolation, Pattern } from '@stackbilt/types';

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

  const securityPatterns = loadSecurityDenyPatterns(options.configPath);
  const securityReport = securityPatterns.length > 0 ? scanForDrift(files, securityPatterns) : null;
  const securityViolations = (securityReport?.violations || []).map((violation) => ({
    ...violation,
    severity: 'BLOCKER' as const,
  }));
  const report = mergeReports(scanForDrift(files, patterns), securityViolations, securityPatterns.length);
  const hasSecurityBlocker = securityViolations.length > 0;
  const status: 'PASS' | 'FAIL' = report.score >= config.drift.minScore && !hasSecurityBlocker ? 'PASS' : 'FAIL';
  const patternsCustomized = getPatternCustomizationStatus(options.configPath);
  const output = {
    status,
    securityBlockers: securityViolations.length,
    minScore: config.drift.minScore,
    thresholdPercent: Math.round(config.drift.minScore * 100),
    configPath: options.configPath,
    patternsCustomized,
    ...report,
  };

  if (options.format === 'json') {
    console.log(JSON.stringify(output, null, 2));
  } else {
    printReport(report, config.drift.minScore, patternsCustomized, securityViolations.length);
  }

  if (options.ciMode && (report.score < config.drift.minScore || hasSecurityBlocker)) {
    return EXIT_CODE.POLICY_VIOLATION;
  }

  return EXIT_CODE.SUCCESS;
}

function printReport(report: DriftReport, minScore: number, patternsCustomized: boolean | null, securityBlockers: number): void {
  const icon = report.score >= minScore && securityBlockers === 0 ? '[ok]' : '[fail]';
  const pct = Math.round(report.score * 100);

  console.log(`\n  ${icon} Drift Score: ${pct}% (threshold: ${Math.round(minScore * 100)}%)`);
  console.log(`     Scanned: ${report.scannedFiles} files against ${report.scannedPatterns} patterns`);
  if (patternsCustomized !== null) {
    console.log(`     Patterns customized: ${patternsCustomized ? 'yes' : 'no'}`);
  }
  if (securityBlockers > 0) {
    console.log(`     Security blockers: ${securityBlockers}`);
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

function loadSecurityDenyPatterns(configPath: string): Pattern[] {
  const denyPath = path.join(configPath, 'patterns', 'security-deny.json');
  if (!fs.existsSync(denyPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(denyPath, 'utf-8'));
    const rawPatterns = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.patterns)
        ? parsed.patterns
        : [];

    return rawPatterns.map((item: Record<string, unknown>, index: number) => ({
      id: String(item.id || `security-deny-${index}`),
      name: String(item.name || `Security Deny ${index + 1}`),
      category: String(item.category || 'SECURITY'),
      blessedSolution: String(item.blessed_solution || item.blessedSolution || ''),
      rationale: typeof item.rationale === 'string' ? item.rationale : null,
      antiPatterns: typeof item.anti_patterns === 'string'
        ? item.anti_patterns
        : typeof item.antiPatterns === 'string'
          ? item.antiPatterns
          : null,
      documentationUrl: null,
      relatedLedgerId: null,
      status: 'ACTIVE' as const,
      createdAt: new Date().toISOString(),
      projectId: null,
    }));
  } catch {
    console.warn(`Warning: Failed to parse security deny pattern file: ${denyPath}`);
    return [];
  }
}

function mergeReports(base: DriftReport, securityViolations: DriftViolation[], extraPatternCount: number): DriftReport {
  const violations = [...base.violations, ...securityViolations];
  return {
    ...base,
    violations,
    scannedPatterns: base.scannedPatterns + extraPatternCount,
    score: Math.max(0, 1.0 - (violations.length * 0.1)),
  };
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

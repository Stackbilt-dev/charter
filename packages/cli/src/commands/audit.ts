/**
 * charter audit
 *
 * Generates a governance audit report for the current repository.
 * Summarizes governance coverage, pattern adoption, and policy compliance.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { loadConfig, loadPatterns } from '../config';
import { parseAllTrailers } from '@stackbilt/git';
import { assessCommitRisk } from '@stackbilt/git';
import type { GitCommit } from '@stackbilt/types';

interface AuditReport {
  project: string;
  generatedAt: string;
  configVersion: string;
  git: {
    totalCommits: number;
    commitsWithTrailers: number;
    coveragePercent: number;
    highRiskUnlinked: number;
    governedByRefs: string[];
    resolvesRequestRefs: string[];
  };
  patterns: {
    total: number;
    active: number;
    categories: Record<string, number>;
  };
  policies: {
    files: string[];
  };
  score: {
    overall: number;
    breakdown: {
      trailerCoverage: number;
      patternDefinitions: number;
      policyDocumentation: number;
    };
  };
}

export async function auditCommand(options: CLIOptions): Promise<number> {
  const config = loadConfig(options.configPath);
  const patterns = loadPatterns(options.configPath);

  const report = generateAuditReport(config.project, options.configPath, patterns);

  if (options.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (options.ciMode && report.score.overall < 50) {
    return EXIT_CODE.POLICY_VIOLATION;
  }

  return EXIT_CODE.SUCCESS;
}

function generateAuditReport(
  projectName: string,
  configPath: string,
  patterns: Array<{ name: string; category: string; status: string }>
): AuditReport {
  const commits = getRecentCommits(50);
  const parsed = parseAllTrailers(commits);

  const linkedCommits = new Set<string>();
  parsed.governedBy.forEach((t) => linkedCommits.add(t.commitSha));
  parsed.resolvesRequest.forEach((t) => linkedCommits.add(t.commitSha));

  let highRiskUnlinked = 0;
  for (const commit of commits) {
    if (!linkedCommits.has(commit.sha)) {
      const risk = assessCommitRisk(commit.files_changed, commit.message);
      if (risk === 'HIGH') highRiskUnlinked++;
    }
  }

  const coveragePercent = commits.length > 0
    ? Math.round((linkedCommits.size / commits.length) * 100)
    : 0;

  const activePatterns = patterns.filter((p) => p.status === 'ACTIVE');
  const categories: Record<string, number> = {};
  for (const p of activePatterns) {
    categories[p.category] = (categories[p.category] || 0) + 1;
  }

  const policiesDir = `${configPath}/policies`;
  const policyFiles = fs.existsSync(policiesDir)
    ? fs.readdirSync(policiesDir).filter((f) => f.endsWith('.md'))
    : [];

  const trailerScore = Math.min(100, coveragePercent * 1.5);
  const patternScore = Math.min(100, activePatterns.length * 20);
  const policyScore = Math.min(100, policyFiles.length * 33);

  const overall = Math.round((trailerScore * 0.5) + (patternScore * 0.3) + (policyScore * 0.2));

  return {
    project: projectName,
    generatedAt: new Date().toISOString(),
    configVersion: '0.1',
    git: {
      totalCommits: commits.length,
      commitsWithTrailers: linkedCommits.size,
      coveragePercent,
      highRiskUnlinked,
      governedByRefs: parsed.governedBy.map((t) => t.reference),
      resolvesRequestRefs: parsed.resolvesRequest.map((t) => t.reference),
    },
    patterns: {
      total: patterns.length,
      active: activePatterns.length,
      categories,
    },
    policies: {
      files: policyFiles,
    },
    score: {
      overall,
      breakdown: {
        trailerCoverage: Math.round(trailerScore),
        patternDefinitions: Math.round(patternScore),
        policyDocumentation: Math.round(policyScore),
      },
    },
  };
}

function printReport(report: AuditReport): void {
  const scoreIcon = report.score.overall >= 70 ? '[ok]'
    : report.score.overall >= 40 ? '[warn]'
    : '[fail]';

  console.log('');
  console.log('  Charter Governance Audit');
  console.log(`  Project: ${report.project}`);
  console.log(`  Score:   ${scoreIcon} ${report.score.overall}/100`);
  console.log('');
  console.log('  Git Governance Coverage');
  console.log(`    Commits analyzed:   ${report.git.totalCommits}`);
  console.log(`    With trailers:      ${report.git.commitsWithTrailers} (${report.git.coveragePercent}%)`);
  console.log(`    High-risk unlinked: ${report.git.highRiskUnlinked}`);
  console.log('');
  console.log('  Blessed Stack Patterns');
  console.log(`    Total defined:      ${report.patterns.total}`);
  console.log(`    Active:             ${report.patterns.active}`);
  console.log(`    Categories:         ${Object.entries(report.patterns.categories).map(([k, v]) => `${k}(${v})`).join(', ') || 'none'}`);
  console.log('');
  console.log('  Policy Documentation');
  console.log(`    Policy files:       ${report.policies.files.length}`);
  for (const file of report.policies.files) {
    console.log(`    - ${file}`);
  }
  console.log('');
  console.log('  Score Breakdown');
  console.log(`    Trailer coverage:     ${report.score.breakdown.trailerCoverage}/100 (50% weight)`);
  console.log(`    Pattern definitions:  ${report.score.breakdown.patternDefinitions}/100 (30% weight)`);
  console.log(`    Policy documentation: ${report.score.breakdown.policyDocumentation}/100 (20% weight)`);
  console.log('');
}

function getRecentCommits(count: number): GitCommit[] {
  try {
    const log = runGit(['log', `-${count}`, '--format=%H|%an|%aI|%B---END---', '--name-only']);

    const commits: GitCommit[] = [];
    const entries = log.split('---END---');

    for (const entry of entries) {
      const lines = entry.trim().split('\n').filter((l) => l.trim());
      if (lines.length === 0) continue;

      const firstLine = lines[0];
      if (!firstLine.includes('|')) continue;

      const pipeIdx = firstLine.indexOf('|');
      const sha = firstLine.slice(0, pipeIdx);
      const rest = firstLine.slice(pipeIdx + 1);
      const [author, timestamp, ...msgParts] = rest.split('|');

      const files: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line && !line.includes('|')) {
          files.push(line);
        }
      }

      commits.push({
        sha,
        author: author || 'unknown',
        timestamp: timestamp || new Date().toISOString(),
        message: msgParts.join('|') || '',
        files_changed: files,
      });
    }

    return commits;
  } catch {
    return [];
  }
}

function runGit(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

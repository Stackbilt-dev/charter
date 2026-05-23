/**
 * Drift Scanner
 *
 * Detects state drift where actual codebase diverges from governance patterns.
 * Scans file content against anti-pattern rules defined in blessed patterns.
 *
 * Extracted from Charter Cloud (ADR-001).
 *
 * Note: In the Cloud version, patterns are fetched from D1. In the Kit version,
 * patterns are provided directly (loaded from .charter/patterns/ by the CLI).
 */

import type { Pattern, DriftViolation, DriftReport } from '@stackbilt/types';

// ============================================================================
// Public API
// ============================================================================

/**
 * Scan files for governance violations (drift) against provided patterns.
 *
 * @param files - Map of filename to file content
 * @param patterns - Active blessed-stack patterns to check against
 * @returns Drift report with score and violations
 */
export function scanForDrift(
  files: Record<string, string>,
  patterns: Pattern[]
): DriftReport {
  const violations: DriftViolation[] = [];
  let totalFiles = 0;

  for (const [filename, content] of Object.entries(files)) {
    totalFiles++;

    // Skip binary or large files
    if (content.length > 500000) continue;

    for (const pattern of patterns) {
      if (pattern.antiPatterns) {
        const rules = extractRules(pattern.antiPatterns);

        for (const rule of rules) {
          const lines = content.split('\n');
          lines.forEach((line, index) => {
            if (rule.test(line)) {
              violations.push({
                file: filename,
                line: index + 1,
                snippet: line.trim().substring(0, 100),
                patternName: pattern.name,
                antiPattern: pattern.antiPatterns!,
                severity: 'MAJOR'
              });
            }
          });
        }
      }
    }

    // Also scan extracted template literals as virtual files
    const templateVirtualFiles = extractTemplateLiterals(content, filename);
    for (const [vFilename, vContent] of Object.entries(templateVirtualFiles)) {
      for (const pattern of patterns) {
        if (pattern.antiPatterns) {
          const rules = extractRules(pattern.antiPatterns);

          for (const rule of rules) {
            const lines = vContent.split('\n');
            lines.forEach((line, index) => {
              if (rule.test(line)) {
                violations.push({
                  file: vFilename,
                  line: index + 1,
                  snippet: line.trim().substring(0, 100),
                  patternName: pattern.name,
                  antiPattern: pattern.antiPatterns!,
                  severity: 'MAJOR'
                });
              }
            });
          }
        }
      }
    }
  }

  const score = Math.max(0, 1.0 - (violations.length * 0.1));

  return {
    score,
    violations,
    scannedFiles: totalFiles,
    scannedPatterns: patterns.length,
    timestamp: new Date().toISOString()
  };
}

/**
 * Extract template literal bodies from a source file.
 *
 * For .ts, .tsx, .js, and .mjs files, finds all backtick template literal
 * bodies and returns them as a map of virtual filenames to extracted content.
 * Virtual filenames have the format: `filename[template:N]`
 *
 * Handles nested backticks conservatively via non-greedy matching.
 * Short template literals (≤20 chars) are skipped as trivially uninteresting.
 *
 * @param content - File content to extract from
 * @param filename - Filename used to determine extension and virtual names
 * @returns Map of virtual filename → extracted template body
 */
export function extractTemplateLiterals(content: string, filename: string): Record<string, string> {
  const supportedExtensions = ['.ts', '.tsx', '.js', '.mjs'];
  const isSupported = supportedExtensions.some(ext => filename.endsWith(ext));
  if (!isSupported) return {};

  const result: Record<string, string> = {};
  // Match outermost backtick strings — simplified: find `...` blocks
  const re = /`([\s\S]*?)`/g;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(content)) !== null) {
    const body = match[1];
    if (body.length > 20) { // skip trivially short template strings
      result[`${filename}[template:${i++}]`] = body;
    }
  }
  return result;
}

// ============================================================================
// Rule Extraction
// ============================================================================

/**
 * Extract testable regexes from anti-pattern text.
 *
 * Supports:
 * - Regex literals: /pattern/flags
 * - Code tokens: `keyword`
 */
export function extractRules(antiPatternText: string): RegExp[] {
  const rules: RegExp[] = [];

  // Look for regex-like strings: /regex/flags
  const regexMatches = [...antiPatternText.matchAll(/\/([^\/]+)\/([gimsuy]*)/g)];
  if (regexMatches.length > 0) {
    regexMatches.forEach(match => {
      const pattern = match[1];
      const flags = match[2] || '';
      try {
        rules.push(new RegExp(pattern, flags));
      } catch {
        // Ignore invalid regex
      }
    });
  }

  // Look for code-like tokens: `code`
  const codeMatches = antiPatternText.match(/`([^`]+)`/g);
  if (codeMatches) {
    codeMatches.forEach(m => {
      const keyword = m.slice(1, -1);
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rules.push(new RegExp(escaped));
    });
  }

  return rules;
}

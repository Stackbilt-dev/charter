/**
 * charter validate --policy typed-data-access
 *
 * Ontology policy check: loads a data-registry YAML file (or uses an
 * explicit path) and scans the current diff for references to registered
 * business concepts. Flags non-canonical alias usage in new code as WARN.
 *
 * Delegates the detection logic to @stackbilt/validate's ontology module;
 * this file handles only the CLI surface: flag parsing, config lookup,
 * registry loading, git diff extraction, output formatting.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseOntologyRegistry,
  checkOntologyDiff,
  normalizeToken,
  type OntologyRegistry,
  type OntologyChangedLine,
  type OntologyCheckResult,
  type OntologyReference,
  type OntologyViolation,
} from '@stackbilt/validate';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { runGit } from '../git-helpers';
import { loadConfig } from '../config';

// ============================================================================
// Types
// ============================================================================

interface OntologyValidateOutput {
  status: 'PASS' | 'WARN' | 'FAIL';
  summary: string;
  registryPath: string;
  registrySource: 'explicit-flag' | 'config' | 'default';
  conceptCount: number;
  changedLineCount: number;
  scannedFileCount: number;
  referencedConceptSummary: Array<{
    canonical: string;
    owner: string;
    sensitivity: string;
    count: number;
  }>;
  violations: OntologyViolation[];
  references: OntologyReference[];
  suggestions: string[];
}

// ============================================================================
// Entry Point
// ============================================================================

export function runOntologyPolicyCheck(options: CLIOptions, args: string[]): number {
  const ciMode = options.ciMode;
  const config = loadConfig(options.configPath);

  // ---- Load registry --------------------------------------------------------

  const registryInfo = resolveRegistryPath(args, options, config);
  let registry: OntologyRegistry;
  try {
    const yamlText = fs.readFileSync(registryInfo.path, 'utf-8');
    registry = parseOntologyRegistry(yamlText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CLIError(
      `Ontology registry load failed at ${registryInfo.path}: ${msg}\n  Configure with .charter/config.json → ontology.registry or pass --registry <path>.`,
      EXIT_CODE.RUNTIME_ERROR
    );
  }

  // ---- Collect changed lines ------------------------------------------------

  const range = getDiffRange(args);
  let changedLines: OntologyChangedLine[];
  const scannedFiles = new Set<string>();
  try {
    changedLines = collectChangedLines(range, scannedFiles, args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CLIError(
      `Ontology diff extraction failed for range ${range}: ${msg}`,
      EXIT_CODE.RUNTIME_ERROR
    );
  }

  // ---- Resolve per-repo alias ignore list -----------------------------------

  const ignoredAliasTokens = new Set<string>(
    (config.ontology?.ignoreAliases ?? []).map(normalizeToken)
  );

  // ---- Run the check --------------------------------------------------------

  const result = checkOntologyDiff(changedLines, registry, {
    ignoredAliasTokens: ignoredAliasTokens.size > 0 ? ignoredAliasTokens : undefined,
  });

  // ---- Format output --------------------------------------------------------

  const output: OntologyValidateOutput = buildOutputPayload(
    result,
    registry,
    registryInfo,
    changedLines,
    scannedFiles,
    range
  );

  if (options.format === 'json') {
    console.log(JSON.stringify(output, null, 2));
  } else {
    printTextOutput(output, range);
  }

  // ---- Decide exit code -----------------------------------------------------

  const hasFailViolation = result.violations.some(v => v.severity === 'FAIL');
  const hasWarnViolation = result.violations.some(v => v.severity === 'WARN');

  if (hasFailViolation) return EXIT_CODE.POLICY_VIOLATION;
  if (ciMode && hasWarnViolation) return EXIT_CODE.POLICY_VIOLATION;
  return EXIT_CODE.SUCCESS;
}

// ============================================================================
// Registry Path Resolution
// ============================================================================

function resolveRegistryPath(
  args: string[],
  options: CLIOptions,
  config: ReturnType<typeof loadConfig>
): { path: string; source: 'explicit-flag' | 'config' | 'default' } {
  const explicitFlag = getFlag(args, '--registry');
  if (explicitFlag) {
    return { path: path.resolve(explicitFlag), source: 'explicit-flag' };
  }

  const configured = config.ontology?.registry;
  if (configured && configured.length > 0) {
    // Resolve relative to the .charter/ config dir
    const configDir = path.resolve(options.configPath);
    const resolved = path.isAbsolute(configured)
      ? configured
      : path.resolve(configDir, configured);
    return { path: resolved, source: 'config' };
  }

  // Default: look for .charter/data-registry.yaml
  const defaultPath = path.resolve(options.configPath, 'data-registry.yaml');
  return { path: defaultPath, source: 'default' };
}

// ============================================================================
// Diff Extraction
// ============================================================================

function getDiffRange(args: string[]): string {
  const explicit = getFlag(args, '--range');
  if (explicit) return explicit;
  // Default: current working tree vs the merge-base with main/master,
  // falling back to HEAD~1..HEAD if no base is found.
  try {
    const mainRef = (() => {
      try {
        return runGit(['rev-parse', '--verify', 'main']).trim();
      } catch {
        return runGit(['rev-parse', '--verify', 'master']).trim();
      }
    })();
    const head = runGit(['rev-parse', 'HEAD']).trim();
    if (mainRef && mainRef !== head) {
      return `${mainRef}..HEAD`;
    }
  } catch {
    // Fall through
  }
  return 'HEAD~1..HEAD';
}

/**
 * Default skip patterns: test files and fixture directories whose alias
 * content is expected and shouldn't trigger violations. Controlled by
 * `--scan-tests` (opts back in) and `--include-fixtures` flags.
 */
const DEFAULT_SKIP_PATTERNS = [
  /(?:^|\/)__tests__\//,
  /(?:^|\/)__fixtures__\//,
  /(?:^|\/)__mocks__\//,
  /\.test\.(?:ts|tsx|js|jsx|mjs|cjs)$/,
  /\.spec\.(?:ts|tsx|js|jsx|mjs|cjs)$/,
  /(?:^|\/)fixtures\//,
  /(?:^|\/)test-fixtures\//,
];

function shouldSkipFile(filePath: string, args: string[]): boolean {
  if (args.includes('--scan-tests')) return false;
  return DEFAULT_SKIP_PATTERNS.some(re => re.test(filePath));
}

/**
 * Run git diff --unified=0 for the given range and return added lines
 * (lines starting with + in the hunk body, excluding the +++ file header).
 *
 * Files matching DEFAULT_SKIP_PATTERNS (test files, fixture dirs) are
 * filtered out unless `--scan-tests` is passed. Test fixtures intentionally
 * contain alias strings (e.g., `aliases: [workspace, organization]` in a
 * registry YAML fixture) and should not count as production alias usage.
 */
function collectChangedLines(
  range: string,
  scannedFilesOut: Set<string>,
  args: string[] = []
): OntologyChangedLine[] {
  // --unified=0 yields hunks with no context lines, so every +line is a real
  // added line. Exclude the "+++ b/file" header line explicitly.
  const diffOutput = runGit(['diff', '--unified=0', range]);

  const lines: OntologyChangedLine[] = [];
  let currentFile: string | null = null;
  let currentAddLine = 0;
  let skipCurrentFile = false;

  for (const raw of diffOutput.split(/\r?\n/)) {
    // File header: "+++ b/path/to/file.ts"
    if (raw.startsWith('+++ ')) {
      const match = raw.match(/^\+\+\+ (?:b\/)?(.+)$/);
      if (match && match[1] !== '/dev/null') {
        currentFile = match[1];
        skipCurrentFile = shouldSkipFile(currentFile, args);
        if (!skipCurrentFile) {
          scannedFilesOut.add(currentFile);
        }
      } else {
        currentFile = null;
        skipCurrentFile = false;
      }
      continue;
    }
    // Skip other file headers: "--- a/...", "diff --git", "index ...", binary markers, etc.
    if (
      raw.startsWith('--- ') ||
      raw.startsWith('diff --git') ||
      raw.startsWith('index ') ||
      raw.startsWith('new file') ||
      raw.startsWith('deleted file') ||
      raw.startsWith('rename ') ||
      raw.startsWith('similarity ') ||
      raw.startsWith('Binary files ')
    ) {
      continue;
    }

    // Hunk header: "@@ -a,b +c,d @@" — advance line counter
    const hunkMatch = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentAddLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    // Added line: "+content" (not "+++" which is caught above)
    if (raw.startsWith('+') && currentFile && !skipCurrentFile) {
      const text = raw.slice(1);
      lines.push({ file: currentFile, line: currentAddLine, text });
      currentAddLine++;
      continue;
    }

    // Removed lines (-prefix) don't affect the add counter in --unified=0
  }

  return lines;
}

// ============================================================================
// Output Formatting
// ============================================================================

function buildOutputPayload(
  result: OntologyCheckResult,
  registry: OntologyRegistry,
  registryInfo: { path: string; source: 'explicit-flag' | 'config' | 'default' },
  changedLines: OntologyChangedLine[],
  scannedFiles: Set<string>,
  range: string
): OntologyValidateOutput {
  const hasWarn = result.violations.some(v => v.severity === 'WARN');
  const hasFail = result.violations.some(v => v.severity === 'FAIL');
  const status: 'PASS' | 'WARN' | 'FAIL' = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';

  const referencedConceptSummary = Array.from(result.referencedConcepts.entries())
    .map(([canonical, count]) => {
      const concept = registry.concepts.get(canonical)!;
      return {
        canonical,
        owner: concept.owner,
        sensitivity: concept.sensitivity,
        count,
      };
    })
    .sort((a, b) => b.count - a.count);

  const suggestions: string[] = [];
  if (result.violations.length > 0) {
    const uniqueAliases = new Set(
      result.violations
        .filter(v => v.type === 'NON_CANONICAL_ALIAS')
        .map(v => `${v.identifier} → ${v.canonical}`)
    );
    if (uniqueAliases.size > 0) {
      suggestions.push(
        `Prefer canonical forms in new code: ${Array.from(uniqueAliases).slice(0, 5).join(', ')}${uniqueAliases.size > 5 ? ` (+${uniqueAliases.size - 5} more)` : ''}`
      );
    }
    suggestions.push('Aliases are acceptable in user-facing copy only; rename variable/type identifiers to the canonical name.');
  }
  if (result.passed && result.references.length === 0) {
    suggestions.push('No registered concepts were referenced in this diff — ontology check surfaced nothing to validate.');
  }

  const plural = (n: number, singular: string, plural: string): string => `${n} ${n === 1 ? singular : plural}`;
  const summary =
    status === 'FAIL'
      ? `${plural(result.violations.filter(v => v.severity === 'FAIL').length, 'policy violation', 'policy violations')} in ontology check (range: ${range}).`
      : status === 'WARN'
      ? `${plural(result.violations.length, 'non-canonical alias', 'non-canonical aliases')} found in ${plural(scannedFiles.size, 'changed file', 'changed files')}.`
      : result.references.length === 0
      ? `No registered concepts referenced in ${plural(scannedFiles.size, 'changed file', 'changed files')}.`
      : `${plural(result.referencedConcepts.size, 'registered concept', 'registered concepts')} referenced cleanly across ${plural(scannedFiles.size, 'changed file', 'changed files')}.`;

  return {
    status,
    summary,
    registryPath: registryInfo.path,
    registrySource: registryInfo.source,
    conceptCount: registry.concepts.size,
    changedLineCount: changedLines.length,
    scannedFileCount: scannedFiles.size,
    referencedConceptSummary,
    violations: result.violations,
    references: result.references,
    suggestions,
  };
}

function printTextOutput(output: OntologyValidateOutput, range: string): void {
  const icon = output.status === 'PASS' ? '[ok]' : output.status === 'WARN' ? '[warn]' : '[fail]';
  console.log('');
  console.log(`  ${icon} Ontology policy: ${output.status}`);
  console.log(`     ${output.summary}`);
  console.log(`     Registry: ${output.registryPath} (${output.registrySource})`);
  console.log(`     Concepts loaded: ${output.conceptCount}`);
  console.log(`     Range: ${range} — ${output.changedLineCount} added line(s) across ${output.scannedFileCount} file(s)`);

  if (output.referencedConceptSummary.length > 0) {
    console.log('');
    console.log('  Referenced concepts:');
    for (const entry of output.referencedConceptSummary.slice(0, 15)) {
      console.log(`    - ${entry.canonical.padEnd(20)} ${String(entry.count).padStart(3)}× | ${entry.owner} | ${entry.sensitivity}`);
    }
    if (output.referencedConceptSummary.length > 15) {
      console.log(`    (+${output.referencedConceptSummary.length - 15} more)`);
    }
  }

  if (output.violations.length > 0) {
    console.log('');
    console.log(`  Violations (${output.violations.length}):`);
    for (const v of output.violations.slice(0, 20)) {
      const loc = v.file ? `${v.file}:${v.line}` : '(unknown location)';
      console.log(`    - [${v.severity}] ${loc}`);
      console.log(`      ${v.message}`);
    }
    if (output.violations.length > 20) {
      console.log(`    (+${output.violations.length - 20} more)`);
    }
  }

  if (output.suggestions.length > 0) {
    console.log('');
    console.log('  Suggestions:');
    for (const s of output.suggestions) {
      console.log(`    - ${s}`);
    }
  }

  console.log('');
}

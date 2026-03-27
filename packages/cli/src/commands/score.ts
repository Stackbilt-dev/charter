/**
 * charter score
 *
 * Deterministic, local AI-readiness audit for any repository.
 * Scores agent config, grounding, architecture, testing, governance, and freshness.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAdf, parseManifest } from '@stackbilt/adf';
import type { AdfDocument } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { detectPackageManager, inferProjectName, loadPackageContexts } from './setup';
import { hasCommits, isGitRepo, runGit } from '../git-helpers';
import { POINTER_MARKERS } from './adf';

type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
type CategoryStatus = 'strong' | 'partial' | 'weak';

interface ScoreCategory {
  id: 'agent-config' | 'grounding' | 'architecture' | 'testing' | 'governance' | 'freshness';
  label: string;
  score: number;
  max: number;
  status: CategoryStatus;
  summary: string;
}

interface ScoreSignals {
  agentConfig: {
    claude: { exists: boolean; substantive: boolean };
    cursorRules: { exists: boolean; substantive: boolean; files: string[] };
    agents: { exists: boolean; substantive: boolean; file?: string };
    manifest: { exists: boolean; path: string };
    alternateAgentFiles: string[];
  };
  grounding: {
    filesScanned: string[];
    pathReferences: {
      total: number;
      valid: number;
      broken: string[];
    };
    commands: {
      total: number;
      runnable: number;
      invalid: string[];
      documentedTestCommands: string[];
    };
  };
  architecture: {
    manifest: {
      exists: boolean;
      parsed: boolean;
      defaultLoad: string[];
      onDemand: string[];
      parseError?: string;
    };
    modules: {
      total: number;
      existing: string[];
      missing: string[];
    };
    constraints: {
      defined: boolean;
      sources: string[];
    };
    state: {
      defined: boolean;
      source?: string;
    };
  };
  testing: {
    packageManager: 'npm' | 'pnpm';
    documentedCommands: string[];
    derivedCommands: string[];
    ciFiles: string[];
  };
  governance: {
    skillFiles: string[];
    permissionFiles: string[];
    hookFiles: string[];
  };
  freshness: {
    strategy: 'git' | 'mtime' | 'none';
    latestCodeChange?: string;
    latestConfigChange?: string;
    deltaDays?: number;
  };
}

interface ScoreReport {
  repo: string;
  generatedAt: string;
  score: {
    total: number;
    grade: Grade;
  };
  categories: ScoreCategory[];
  recommendations: string[];
  signals: ScoreSignals;
}

interface RepoInventory {
  files: string[];
  fileSet: Set<string>;
}

interface RecommendationCandidate {
  priority: number;
  text: string;
}

interface CommandSignal {
  file: string;
  command: string;
  runnable: boolean;
  kind: 'test' | 'general';
}

interface ResolvedPathReference {
  source: string;
  candidate: string;
  resolved: string;
}

const AGENT_FILES = ['CLAUDE.md', 'AGENTS.md', 'agents.md', 'GEMINI.md', 'copilot-instructions.md'];
const ROOT_DOC_FILES = ['README.md', 'CONTRIBUTING.md'];
const KNOWN_COMMANDS = new Set([
  'bash',
  'bun',
  'cargo',
  'cd',
  'charter',
  'deno',
  'docker',
  'docker-compose',
  'git',
  'go',
  'just',
  'make',
  'node',
  'npm',
  'npx',
  'pip',
  'pnpm',
  'pnpx',
  'poetry',
  'pytest',
  'python',
  'sh',
  'tsx',
  'turbo',
  'uv',
  'vitest',
  'yarn',
]);
const KNOWN_PATH_FILENAMES = new Set([
  '.cursorrules',
  'AGENTS.md',
  'CLAUDE.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'Cargo.toml',
  'Dockerfile',
  'Jenkinsfile',
  'Makefile',
  'README.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'tsconfig.json',
  'vitest.config.ts',
  'vitest.config.mts',
  'wrangler.toml',
]);
const KNOWN_PATH_EXTENSIONS = new Set([
  '.adf',
  '.cjs',
  '.conf',
  '.config',
  '.css',
  '.go',
  '.graphql',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdc',
  '.mdx',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);
const CODE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.go',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.mjs',
  '.mts',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.scala',
  '.sh',
  '.sql',
  '.swift',
  '.ts',
  '.tsx',
]);
const CI_FILES = [
  '.github/workflows',
  '.gitlab-ci.yml',
  '.circleci/config.yml',
  'azure-pipelines.yml',
  'buildkite.yml',
  'Jenkinsfile',
];
const STATE_DOC_FILES = ['STATE.md', 'STATUS.md', 'ROADMAP.md', 'TODO.md', 'CHANGELOG.md'];
const WALK_IGNORE_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.yarn',
  'coverage',
  'dist',
  'build',
  'node_modules',
  'target',
]);
const MAX_TEXT_FILE_BYTES = 256 * 1024;
const GIT_TIMESTAMP_FILE_LIMIT = 4000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CI_MIN_SCORE = 60;

export async function scoreCommand(options: CLIOptions, args: string[] = []): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return EXIT_CODE.SUCCESS;
  }

  const aiDir = normalizeRelativePath(getFlag(args, '--ai-dir') || '.ai');
  const inventory = collectRepoInventory();
  const report = buildScoreReport(inventory, aiDir);

  if (options.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printScoreReport(report);
  }

  if (options.ciMode && report.score.total < CI_MIN_SCORE) {
    return EXIT_CODE.POLICY_VIOLATION;
  }

  return EXIT_CODE.SUCCESS;
}

function buildScoreReport(inventory: RepoInventory, aiDir: string): ScoreReport {
  const contexts = loadPackageContexts();
  const packageManager = detectPackageManager(contexts);
  const repo = inferProjectName(contexts);
  const textCache = new Map<string, string | null>();
  const readText = (relativePath: string): string => {
    if (textCache.has(relativePath)) {
      return textCache.get(relativePath) || '';
    }
    const absolutePath = path.resolve(relativePath);
    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile() || stat.size > MAX_TEXT_FILE_BYTES) {
        textCache.set(relativePath, null);
        return '';
      }
      const content = fs.readFileSync(absolutePath, 'utf-8');
      textCache.set(relativePath, content);
      return content;
    } catch {
      textCache.set(relativePath, null);
      return '';
    }
  };

  const manifestPath = normalizeRelativePath(path.posix.join(aiDir, 'manifest.adf'));
  const aiFiles = inventory.files.filter((file) => file.startsWith(`${aiDir}/`) && file.endsWith('.adf'));
  const alternateAgentFiles = AGENT_FILES.filter((file) => inventory.fileSet.has(file) && file !== 'CLAUDE.md' && !/^agents\.md$/i.test(file));
  const claudeContent = readText('CLAUDE.md');
  const claudeExists = inventory.fileSet.has('CLAUDE.md');
  const claudeSubstantive = claudeExists && isSubstantiveInstruction(claudeContent);
  const cursorFiles = inventory.fileSet.has('.cursorrules')
    ? ['.cursorrules']
    : inventory.files.filter((file) => file.startsWith('.cursor/rules/'));
  const cursorContent = cursorFiles.map((file) => readText(file)).join('\n');
  const cursorExists = cursorFiles.length > 0;
  const cursorSubstantive = cursorExists && isSubstantiveInstruction(cursorContent);
  const agentsFile = inventory.fileSet.has('AGENTS.md')
    ? 'AGENTS.md'
    : inventory.fileSet.has('agents.md')
      ? 'agents.md'
      : undefined;
  const agentsContent = agentsFile ? readText(agentsFile) : '';
  const agentsExists = !!agentsFile;
  const agentsSubstantive = agentsExists && isSubstantiveInstruction(agentsContent);
  const manifestExists = inventory.fileSet.has(manifestPath);

  let agentConfigScore = 0;
  if (claudeExists) agentConfigScore += 5;
  if (claudeSubstantive) agentConfigScore += 5;
  if (cursorExists) agentConfigScore += cursorSubstantive ? 5 : 2;
  if (agentsExists) agentConfigScore += agentsSubstantive ? 5 : 2;
  if (manifestExists) agentConfigScore += 5;

  const groundingFiles = [...new Set(
    AGENT_FILES.filter((file) => inventory.fileSet.has(file))
      .concat(cursorFiles)
      .concat(ROOT_DOC_FILES.filter((file) => inventory.fileSet.has(file)))
      .concat(manifestExists ? [manifestPath] : [])
      .concat(aiFiles.filter((file) => file !== manifestPath))
  )];

  const pathReferences = new Map<string, ResolvedPathReference>();
  const commandSignals: CommandSignal[] = [];

  for (const file of groundingFiles) {
    const content = readText(file);
    if (!content) continue;

    for (const candidate of extractPathCandidates(content)) {
      const reference = resolveReferencedPath(file, candidate);
      pathReferences.set(`${reference.source}:${reference.resolved}`, reference);
    }
    commandSignals.push(...extractCommandSignals(file, content, inventory.fileSet, packageManager));
  }

  const brokenPaths = [...pathReferences.values()]
    .filter((reference) => !pathExists(reference.resolved))
    .map((reference) => reference.resolved);
  const validPaths = pathReferences.size - brokenPaths.length;
  const documentedTestCommands = [...new Set(
    commandSignals
      .filter((signal) => signal.runnable && signal.kind === 'test')
      .map((signal) => signal.command)
  )];
  const invalidCommands = commandSignals
    .filter((signal) => !signal.runnable)
    .map((signal) => `${signal.file}: ${signal.command}`);
  const runnableCommandCount = commandSignals.filter((signal) => signal.runnable).length;
  const pathScore = pathReferences.size > 0
    ? Math.round(10 * (validPaths / pathReferences.size))
    : 0;
  const commandScore = commandSignals.length > 0
    ? Math.round(10 * (((runnableCommandCount / commandSignals.length) + Math.min(1, runnableCommandCount / 2)) / 2))
    : 0;
  const groundingScore = pathScore + commandScore;

  let manifestParsed = false;
  let manifestDoc: AdfDocument | null = null;
  let manifestParseError: string | undefined;
  let manifestDefaultLoad: string[] = [];
  let manifestOnDemand: string[] = [];
  let referencedModules: string[] = [];
  const existingModules: string[] = [];
  const missingModules: string[] = [];
  const constraintSources = new Set<string>();
  let stateDefined = false;
  let stateSource: string | undefined;

  if (manifestExists) {
    try {
      manifestDoc = parseAdf(readText(manifestPath));
      const manifest = parseManifest(manifestDoc);
      manifestParsed = true;
      manifestDefaultLoad = manifest.defaultLoad;
      manifestOnDemand = manifest.onDemand.map((mod) => mod.path);
      referencedModules = [...new Set([...manifest.defaultLoad, ...manifest.onDemand.map((mod) => mod.path)])];

      for (const modulePath of referencedModules) {
        const normalizedModule = normalizeRelativePath(path.posix.join(aiDir, modulePath));
        if (!inventory.fileSet.has(normalizedModule)) {
          missingModules.push(normalizedModule);
          continue;
        }

        existingModules.push(normalizedModule);
        try {
          const moduleDoc = parseAdf(readText(normalizedModule));
          if (hasConstraints(moduleDoc)) {
            constraintSources.add(normalizedModule);
          }
          if (!stateDefined && hasAdfState(moduleDoc)) {
            stateDefined = true;
            stateSource = normalizedModule;
          }
        } catch {
          // Keep module presence signal even if the content is malformed.
        }
      }
    } catch (error) {
      manifestParseError = error instanceof Error ? error.message : String(error);
    }
  }

  if (constraintSources.size === 0) {
    for (const file of groundingFiles) {
      if (hasDocumentedConstraints(readText(file))) {
        constraintSources.add(file);
      }
    }
  }

  if (!stateDefined) {
    const fallbackStateFile = STATE_DOC_FILES.find((file) => inventory.fileSet.has(file));
    if (fallbackStateFile) {
      stateDefined = true;
      stateSource = fallbackStateFile;
    }
  }

  const manifestScore = manifestParsed ? 8 : manifestExists ? 4 : 0;
  const moduleScore = referencedModules.length > 0
    ? Math.round(5 * (existingModules.length / referencedModules.length))
    : aiFiles.length > 0
      ? 2
      : 0;
  const constraintsScore = constraintSources.size > 0 ? 4 : 0;
  const stateScore = stateDefined ? 3 : 0;
  const architectureScore = manifestScore + moduleScore + constraintsScore + stateScore;

  const derivedTestCommands = deriveTestCommands(inventory, packageManager);
  const documentedTestingScore = documentedTestCommands.length >= 2
    ? 8
    : documentedTestCommands.length === 1
      ? 6
      : derivedTestCommands.length > 0
        ? 5
        : 0;
  const ciFiles = detectCiFiles(inventory);
  const ciScore = ciFiles.length > 0 ? 7 : 0;
  const testingScore = documentedTestingScore + ciScore;

  const skillFiles = inventory.files.filter((file) => path.posix.basename(file) === 'SKILL.md');
  const permissionFiles = detectPermissionFiles(inventory, readText);
  const hookFiles = detectHookFiles(inventory);
  const governanceScore = (skillFiles.length > 0 ? 4 : 0)
    + (permissionFiles.length > 0 ? 3 : 0)
    + (hookFiles.length > 0 ? 3 : 0);

  const configFiles = [...new Set(
    [
      ...AGENT_FILES.filter((file) => inventory.fileSet.has(file)),
      ...cursorFiles,
      manifestPath,
      ...aiFiles,
      ...ciFiles,
      ...skillFiles,
      ...permissionFiles,
      ...hookFiles.filter((file) => !file.startsWith('.git/')),
      '.charter/config.json',
    ].filter((file) => file && fileExists(file))
  )];
  const codeFiles = detectCodeFiles(inventory, configFiles);
  const freshnessSignals = evaluateFreshness(configFiles, codeFiles);
  const freshnessScore = scoreFreshness(freshnessSignals);

  const categories: ScoreCategory[] = [
    createCategory(
      'agent-config',
      'Agent config',
      agentConfigScore,
      25,
      agentConfigSummary(claudeExists, claudeSubstantive, cursorFiles, cursorSubstantive, agentsFile, agentsSubstantive, manifestExists, manifestPath),
    ),
    createCategory(
      'grounding',
      'Grounding',
      groundingScore,
      20,
      groundingSummary(pathReferences.size, validPaths, brokenPaths.length, commandSignals.length, runnableCommandCount),
    ),
    createCategory(
      'architecture',
      'Architecture',
      architectureScore,
      20,
      architectureSummary(manifestExists, manifestParsed, existingModules.length, missingModules.length, constraintSources.size > 0, stateDefined),
    ),
    createCategory(
      'testing',
      'Testing',
      testingScore,
      15,
      testingSummary(documentedTestCommands, derivedTestCommands, ciFiles),
    ),
    createCategory(
      'governance',
      'Governance',
      governanceScore,
      10,
      governanceSummary(skillFiles, permissionFiles, hookFiles),
    ),
    createCategory(
      'freshness',
      'Freshness',
      freshnessScore,
      10,
      freshnessSummary(freshnessSignals),
    ),
  ];

  const total = categories.reduce((sum, category) => sum + category.score, 0);
  const report: ScoreReport = {
    repo,
    generatedAt: new Date().toISOString(),
    score: {
      total,
      grade: toGrade(total),
    },
    categories,
    recommendations: buildRecommendations({
      aiDir,
      manifestPath,
      claudeExists,
      claudeSubstantive,
      cursorFiles,
      agentsFile,
      manifestExists,
      brokenPaths,
      commandSignals,
      documentedTestCommands,
      derivedTestCommands,
      manifestParsed,
      missingModules,
      constraintsDefined: constraintSources.size > 0,
      stateDefined,
      ciFiles,
      skillFiles,
      permissionFiles,
      hookFiles,
      freshnessSignals,
    }),
    signals: {
      agentConfig: {
        claude: { exists: claudeExists, substantive: claudeSubstantive },
        cursorRules: { exists: cursorExists, substantive: cursorSubstantive, files: cursorFiles },
        agents: { exists: agentsExists, substantive: agentsSubstantive, file: agentsFile },
        manifest: { exists: manifestExists, path: manifestPath },
        alternateAgentFiles,
      },
      grounding: {
        filesScanned: groundingFiles,
        pathReferences: {
          total: pathReferences.size,
          valid: validPaths,
          broken: brokenPaths,
        },
        commands: {
          total: commandSignals.length,
          runnable: runnableCommandCount,
          invalid: invalidCommands,
          documentedTestCommands,
        },
      },
      architecture: {
        manifest: {
          exists: manifestExists,
          parsed: manifestParsed,
          defaultLoad: manifestDefaultLoad,
          onDemand: manifestOnDemand,
          parseError: manifestParseError,
        },
        modules: {
          total: referencedModules.length,
          existing: existingModules,
          missing: missingModules,
        },
        constraints: {
          defined: constraintSources.size > 0,
          sources: [...constraintSources],
        },
        state: {
          defined: stateDefined,
          source: stateSource,
        },
      },
      testing: {
        packageManager,
        documentedCommands: documentedTestCommands,
        derivedCommands: derivedTestCommands,
        ciFiles,
      },
      governance: {
        skillFiles,
        permissionFiles,
        hookFiles,
      },
      freshness: freshnessSignals,
    },
  };

  return report;
}

function createCategory(
  id: ScoreCategory['id'],
  label: string,
  score: number,
  max: number,
  summary: string,
): ScoreCategory {
  return {
    id,
    label,
    score,
    max,
    status: toCategoryStatus(score, max),
    summary,
  };
}

function collectRepoInventory(): RepoInventory {
  const files = collectRepoFiles();
  return {
    files,
    fileSet: new Set(files),
  };
}

function collectRepoFiles(): string[] {
  if (isGitRepo()) {
    try {
      const output = runGit(['ls-files', '--cached', '--others', '--exclude-standard']);
      const files = output
        .split(/\r?\n/)
        .map((line) => normalizeRelativePath(line))
        .filter(Boolean);
      if (files.length > 0) {
        return [...new Set(files)];
      }
    } catch {
      // Fall through to filesystem walk.
    }
  }

  const files: string[] = [];
  walkRepo(process.cwd(), '', files);
  return [...new Set(files)];
}

function walkRepo(absoluteDir: string, relativeDir: string, files: string[]): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    const nextRelative = normalizeRelativePath(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
    const nextAbsolute = path.join(absoluteDir, entry.name);

    if (entry.isDirectory()) {
      if (WALK_IGNORE_DIRS.has(entry.name)) continue;
      walkRepo(nextAbsolute, nextRelative, files);
      continue;
    }

    if (!entry.isFile()) continue;
    files.push(nextRelative);
  }
}

function deriveTestCommands(inventory: RepoInventory, packageManager: 'npm' | 'pnpm'): string[] {
  const commands = new Set<string>();

  for (const packageJsonPath of inventory.files.filter((file) => path.posix.basename(file) === 'package.json')) {
    try {
      const raw = fs.readFileSync(path.resolve(packageJsonPath), 'utf-8');
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
      const scripts = parsed.scripts || {};
      for (const name of Object.keys(scripts)) {
        if (name === 'test') {
          commands.add(`${packageManager} test`);
        } else if (name.startsWith('test:')) {
          commands.add(`${packageManager} run ${name}`);
        }
      }
    } catch {
      // ignore malformed package files
    }
  }

  if (inventory.fileSet.has('pytest.ini') || inventory.fileSet.has('pyproject.toml') || inventory.fileSet.has('tox.ini')) {
    commands.add('pytest');
  }
  if (inventory.fileSet.has('Cargo.toml')) {
    commands.add('cargo test');
  }
  if (inventory.fileSet.has('go.mod') || inventory.files.some((file) => file.endsWith('_test.go'))) {
    commands.add('go test ./...');
  }
  if (inventory.files.some((file) => /^vitest\.config\.(ts|mts|js|mjs)$/i.test(path.posix.basename(file)))) {
    commands.add(`${packageManager} exec vitest run`);
  }
  if (inventory.files.some((file) => /^jest\.config\.(ts|js|cjs|mjs)$/i.test(path.posix.basename(file)))) {
    commands.add(`${packageManager} exec jest`);
  }

  return [...commands];
}

function detectCiFiles(inventory: RepoInventory): string[] {
  const results = new Set<string>();
  for (const prefix of CI_FILES) {
    if (prefix === '.github/workflows') {
      for (const file of inventory.files.filter((candidate) => candidate.startsWith('.github/workflows/'))) {
        results.add(file);
      }
      continue;
    }

    if (inventory.fileSet.has(prefix)) {
      results.add(prefix);
    }
  }
  return [...results];
}

function detectPermissionFiles(inventory: RepoInventory, readText: (relativePath: string) => string): string[] {
  const candidates = inventory.files.filter((file) => (
    file === 'CLAUDE.md'
    || file === 'AGENTS.md'
    || file === 'agents.md'
    || file === '.cursorrules'
    || file.startsWith('.claude/')
    || file.startsWith('.codex/')
    || file.startsWith('.cursor/')
  ));

  const matches: string[] = [];
  for (const file of candidates) {
    const content = readText(file);
    if (!content) continue;
    if (/\b(permissions?|sandbox|approval|allowlist|denylist)\b/i.test(content) || /["'](allow|deny)["']\s*:/i.test(content)) {
      matches.push(file);
    }
  }
  return [...new Set(matches)];
}

function detectHookFiles(inventory: RepoInventory): string[] {
  const hooks = new Set<string>();
  for (const file of ['.husky/pre-commit', '.husky/commit-msg', '.githooks/pre-commit', '.githooks/commit-msg']) {
    if (inventory.fileSet.has(file)) {
      hooks.add(file);
    }
  }

  for (const file of ['.git/hooks/pre-commit', '.git/hooks/commit-msg']) {
    if (fs.existsSync(path.resolve(file))) {
      hooks.add(file);
    }
  }

  if (isGitRepo()) {
    try {
      const configuredHooksPath = runGit(['config', '--get', 'core.hooksPath']).trim();
      if (configuredHooksPath) {
        for (const file of ['pre-commit', 'commit-msg']) {
          const relative = normalizeRelativePath(path.posix.join(configuredHooksPath.replace(/\\/g, '/'), file));
          if (fs.existsSync(path.resolve(relative))) {
            hooks.add(relative);
          }
        }
      }
    } catch {
      // no configured hooks path
    }
  }

  return [...hooks];
}

function detectCodeFiles(inventory: RepoInventory, configFiles: string[]): string[] {
  const configSet = new Set(configFiles.map((file) => normalizeRelativePath(file)));
  const codeFiles = inventory.files.filter((file) => {
    if (configSet.has(file)) return false;
    if (file.endsWith('.md') || file.endsWith('.mdx') || file.endsWith('.adf')) return false;
    const base = path.posix.basename(file);
    if (KNOWN_PATH_FILENAMES.has(base)) return false;
    return CODE_EXTENSIONS.has(path.posix.extname(file).toLowerCase());
  });

  if (codeFiles.length > 0) {
    return codeFiles;
  }

  return inventory.files.filter((file) => !configSet.has(file) && !file.startsWith('.git/'));
}

function evaluateFreshness(configFiles: string[], codeFiles: string[]): ScoreSignals['freshness'] {
  const useGit = shouldUseGitTimestamps(configFiles, codeFiles);
  const latestCode = getLatestTimestamp(codeFiles, useGit);
  const latestConfig = getLatestTimestamp(configFiles, useGit);

  if (!latestCode || !latestConfig) {
    return {
      strategy: latestCode || latestConfig ? (useGit ? 'git' : 'mtime') : 'none',
      latestCodeChange: latestCode ? formatDate(latestCode) : undefined,
      latestConfigChange: latestConfig ? formatDate(latestConfig) : undefined,
    };
  }

  const deltaDays = Math.max(0, Math.round((latestCode.getTime() - latestConfig.getTime()) / MS_PER_DAY));
  return {
    strategy: useGit ? 'git' : 'mtime',
    latestCodeChange: formatDate(latestCode),
    latestConfigChange: formatDate(latestConfig),
    deltaDays,
  };
}

function scoreFreshness(freshness: ScoreSignals['freshness']): number {
  if (!freshness.latestCodeChange || !freshness.latestConfigChange) {
    return 0;
  }

  const deltaDays = freshness.deltaDays ?? 0;
  if (deltaDays <= 7) return 10;
  if (deltaDays <= 30) return 8;
  if (deltaDays <= 90) return 5;
  if (deltaDays <= 180) return 2;
  return 0;
}

function shouldUseGitTimestamps(configFiles: string[], codeFiles: string[]): boolean {
  return isGitRepo() && hasCommits() && configFiles.length > 0 && codeFiles.length > 0 && (configFiles.length + codeFiles.length) <= GIT_TIMESTAMP_FILE_LIMIT;
}

function getLatestTimestamp(files: string[], useGit: boolean): Date | null {
  const uniqueFiles = [...new Set(files.map((file) => normalizeRelativePath(file)).filter((file) => fileExists(file)))];
  if (uniqueFiles.length === 0) return null;

  if (useGit) {
    const fromGit = getLatestGitTimestamp(uniqueFiles);
    if (fromGit) {
      return fromGit;
    }
  }

  let latest = 0;
  for (const file of uniqueFiles) {
    try {
      const stat = fs.statSync(path.resolve(file));
      if (stat.mtimeMs > latest) {
        latest = stat.mtimeMs;
      }
    } catch {
      // ignore unreadable files
    }
  }
  return latest > 0 ? new Date(latest) : null;
}

function getLatestGitTimestamp(files: string[]): Date | null {
  if (!isGitRepo() || !hasCommits() || files.length === 0 || files.length > GIT_TIMESTAMP_FILE_LIMIT) {
    return null;
  }

  let latestSeconds = 0;
  for (let i = 0; i < files.length; i += 200) {
    const chunk = files.slice(i, i + 200);
    try {
      const raw = runGit(['log', '-1', '--format=%ct', '--', ...chunk]).trim();
      const seconds = Number.parseInt(raw, 10);
      if (Number.isFinite(seconds) && seconds > latestSeconds) {
        latestSeconds = seconds;
      }
    } catch {
      // Ignore chunk-level git failures; fallback handled by caller.
    }
  }

  return latestSeconds > 0 ? new Date(latestSeconds * 1000) : null;
}

function hasConstraints(doc: AdfDocument): boolean {
  return doc.sections.some((section) => (
    section.key === 'CONSTRAINTS'
    || section.weight === 'load-bearing'
  ) && sectionHasContent(section.content));
}

function hasAdfState(doc: AdfDocument): boolean {
  return doc.sections.some((section) => {
    if (section.key !== 'STATE') return false;
    if (section.content.type === 'map') {
      return section.content.entries.some((entry) => entry.key === 'CURRENT' || entry.key === 'NEXT');
    }
    return sectionHasContent(section.content);
  });
}

function sectionHasContent(content: AdfDocument['sections'][number]['content']): boolean {
  switch (content.type) {
    case 'list':
      return content.items.length > 0;
    case 'map':
      return content.entries.length > 0;
    case 'metric':
      return content.entries.length > 0;
    case 'text':
      return content.value.trim().length > 0;
    default:
      return false;
  }
}

function hasDocumentedConstraints(content: string): boolean {
  if (!content) return false;
  return /^#{1,3}\s+(constraints|guardrails|rules|non-negotiables)\b/im.test(content)
    || /\b(non-negotiable|must always|never do|guardrails?)\b/i.test(content);
}

function isSubstantiveInstruction(content: string): boolean {
  if (!content) return false;
  let normalized = content;
  for (const marker of POINTER_MARKERS) {
    normalized = normalized.replaceAll(marker, '');
  }
  normalized = normalized
    .replace(/auto-managed by Charter/gi, '')
    .replace(/\.ai\/manifest\.adf/gi, '')
    .replace(/Do not duplicate rules from \.ai\//gi, '')
    .trim();

  const nonEmptyLines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return nonEmptyLines.length >= 3 || normalized.length >= 80;
}

function extractPathCandidates(content: string): string[] {
  const candidates = new Set<string>();

  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = normalizePathCandidate(match[1]);
    if (looksLikePath(target)) candidates.add(target);
  }

  for (const match of content.matchAll(/`([^`\n]+)`/g)) {
    const candidate = normalizePathCandidate(match[1]);
    if (looksLikePath(candidate)) candidates.add(candidate);
  }

  for (const match of content.matchAll(/(^|[\s(])((?:\.{1,2}\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)?)/gm)) {
    const candidate = normalizePathCandidate(match[2]);
    if (looksLikePath(candidate)) candidates.add(candidate);
  }

  return [...candidates];
}

function normalizePathCandidate(raw: string): string {
  return raw
    .trim()
    .replace(/^['"`(]+/, '')
    .replace(/[),.:;"'`]+$/, '')
    .replace(/#.*/, '')
    .replace(/^\.\//, '')
    .replace(/\\/g, '/');
}

function resolveReferencedPath(sourceFile: string, candidate: string): ResolvedPathReference {
  if (candidate.startsWith('/')) {
    return {
      source: sourceFile,
      candidate,
      resolved: normalizeRelativePath(candidate),
    };
  }

  const sourceDir = path.posix.dirname(sourceFile);
  const resolved = sourceDir === '.'
    ? normalizeRelativePath(candidate)
    : normalizeRelativePath(path.posix.join(sourceDir, candidate));
  return {
    source: sourceFile,
    candidate,
    resolved,
  };
}

function looksLikePath(candidate: string): boolean {
  if (!candidate) return false;
  if (candidate.startsWith('http://') || candidate.startsWith('https://') || candidate.startsWith('mailto:')) return false;
  if (candidate.startsWith('#') || candidate.startsWith('--')) return false;
  if (candidate.includes('<') || candidate.includes('>') || candidate.includes('*') || candidate.includes('${')) return false;
  if (candidate.includes(' ')) return false;
  if (KNOWN_PATH_FILENAMES.has(candidate) || KNOWN_PATH_FILENAMES.has(path.posix.basename(candidate))) return true;
  if (candidate.includes('/')) return true;
  return KNOWN_PATH_EXTENSIONS.has(path.posix.extname(candidate).toLowerCase());
}

function pathExists(relativePath: string): boolean {
  return fileExists(relativePath);
}

function fileExists(relativePath: string): boolean {
  try {
    return fs.existsSync(path.resolve(relativePath));
  } catch {
    return false;
  }
}

function extractCommandSignals(
  file: string,
  content: string,
  fileSet: Set<string>,
  packageManager: 'npm' | 'pnpm',
): CommandSignal[] {
  const signals: CommandSignal[] = [];

  for (const block of extractFencedCodeBlocks(content)) {
    if (!isShellLikeBlock(block.language)) continue;
    const lines = block.content.split(/\r?\n/);
    let captured = 0;

    for (const rawLine of lines) {
      const cleaned = normalizeCommandLine(rawLine);
      if (!cleaned) continue;
      captured++;
      signals.push({
        file,
        command: cleaned,
        runnable: isRunnableCommand(cleaned, fileSet, packageManager),
        kind: isTestCommand(cleaned) ? 'test' : 'general',
      });
      if (captured >= 8) break;
    }
  }

  return signals;
}

function extractFencedCodeBlocks(content: string): Array<{ language: string; content: string }> {
  const blocks: Array<{ language: string; content: string }> = [];
  for (const match of content.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)) {
    blocks.push({
      language: match[1].trim().toLowerCase(),
      content: match[2],
    });
  }
  return blocks;
}

function isShellLikeBlock(language: string): boolean {
  return language === ''
    || language === 'bash'
    || language === 'console'
    || language === 'shell'
    || language === 'sh'
    || language === 'zsh';
}

function normalizeCommandLine(rawLine: string): string {
  let line = rawLine.trim();
  if (!line || line.startsWith('#')) return '';
  line = line.replace(/^(?:\$|>|%|\u203A)\s+/, '').trim();
  if (!line || line.startsWith('#')) return '';
  if (/\b(todo|placeholder)\b/i.test(line) || line.includes('<') || /(^|\s)\.\.\.(\s|$)/.test(line)) return '';
  return line;
}

function isRunnableCommand(command: string, fileSet: Set<string>, packageManager: 'npm' | 'pnpm'): boolean {
  const segment = command.split(/\s*(?:&&|\|\||;|\|)\s*/)[0].trim();
  if (!segment) return false;

  const parts = segment.split(/\s+/);
  const head = parts[0];
  if (head.startsWith('./') || head.startsWith('../')) {
    return fileSet.has(normalizeRelativePath(head));
  }

  if (!KNOWN_COMMANDS.has(head)) {
    return false;
  }

  if (head === 'npm' || head === 'pnpm' || head === 'yarn') {
    const scriptMatch = segment.match(/^(npm|pnpm|yarn)\s+(?:run\s+)?([A-Za-z0-9:_-]+)\b/);
    if (scriptMatch && !COMMON_PACKAGE_MANAGER_SUBCOMMANDS.has(scriptMatch[2])) {
      return hasPackageScript(scriptMatch[2]);
    }
    return true;
  }

  if ((head === 'npx' || head === 'pnpx') && parts.length > 1) {
    return KNOWN_COMMANDS.has(parts[1]) || hasPackageScript(parts[1]) || fileSet.has(normalizeRelativePath(parts[1]));
  }

  if (head === 'charter') return true;
  if (head === 'vitest' || head === 'pytest' || head === 'cargo' || head === 'go') return true;
  if (head === 'node' || head === 'python' || head === 'bash' || head === 'sh') {
    if (parts.length === 1) return true;
    const target = normalizeRelativePath(parts[1]);
    if (fileSet.has(target)) return true;
    return !looksLikePath(parts[1]);
  }

  if (head === 'make' || head === 'just') return true;
  if (head === packageManager && segment === `${packageManager} test`) return true;

  return true;
}

const COMMON_PACKAGE_MANAGER_SUBCOMMANDS = new Set([
  'add',
  'build',
  'create',
  'dev',
  'dlx',
  'exec',
  'install',
  'lint',
  'remove',
  'test',
  'why',
]);

function hasPackageScript(scriptName: string): boolean {
  for (const packageJsonPath of ['package.json', 'apps/web/package.json']) {
    if (!fileExists(packageJsonPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(packageJsonPath), 'utf-8')) as { scripts?: Record<string, string> };
      if (parsed.scripts && scriptName in parsed.scripts) {
        return true;
      }
    } catch {
      // ignore malformed package file
    }
  }
  return false;
}

function isTestCommand(command: string): boolean {
  return /\b(test|tests|vitest|jest|pytest|cargo test|go test|phpunit|tox|playwright test)\b/i.test(command);
}

function toGrade(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function toCategoryStatus(score: number, max: number): CategoryStatus {
  const ratio = max === 0 ? 0 : score / max;
  if (ratio >= 0.8) return 'strong';
  if (ratio >= 0.4) return 'partial';
  return 'weak';
}

function agentConfigSummary(
  claudeExists: boolean,
  claudeSubstantive: boolean,
  cursorFiles: string[],
  cursorSubstantive: boolean,
  agentsFile: string | undefined,
  agentsSubstantive: boolean,
  manifestExists: boolean,
  manifestPath: string,
): string {
  const parts: string[] = [];
  parts.push(claudeExists
    ? claudeSubstantive ? 'CLAUDE.md is substantive' : 'CLAUDE.md exists but is thin'
    : 'CLAUDE.md missing');
  parts.push(cursorFiles.length > 0
    ? cursorSubstantive ? `${cursorFiles[0]} present` : `${cursorFiles[0]} exists but is thin`
    : '.cursorrules missing');
  parts.push(agentsFile
    ? agentsSubstantive ? `${agentsFile} present` : `${agentsFile} exists but is thin`
    : 'AGENTS.md missing');
  parts.push(manifestExists ? `${manifestPath} present` : `${manifestPath} missing`);
  return parts.join('; ');
}

function groundingSummary(pathTotal: number, validPaths: number, brokenPaths: number, commandTotal: number, runnableCommands: number): string {
  const pathPart = pathTotal > 0
    ? `${validPaths}/${pathTotal} referenced paths resolve`
    : 'no file-path grounding found';
  const commandPart = commandTotal > 0
    ? `${runnableCommands}/${commandTotal} code-block commands look runnable`
    : 'no runnable command blocks found';
  if (brokenPaths > 0) {
    return `${pathPart}; ${commandPart}; ${brokenPaths} broken reference(s)`;
  }
  return `${pathPart}; ${commandPart}`;
}

function architectureSummary(
  manifestExists: boolean,
  manifestParsed: boolean,
  existingModules: number,
  missingModules: number,
  constraintsDefined: boolean,
  stateDefined: boolean,
): string {
  const manifestPart = manifestExists
    ? manifestParsed ? 'manifest parses cleanly' : 'manifest exists but does not parse'
    : 'no ADF manifest';
  const modulePart = existingModules > 0
    ? `${existingModules} module(s) found${missingModules > 0 ? `, ${missingModules} missing` : ''}`
    : 'no routed modules found';
  const constraintsPart = constraintsDefined ? 'constraints defined' : 'constraints missing';
  const statePart = stateDefined ? 'state tracking present' : 'state tracking missing';
  return `${manifestPart}; ${modulePart}; ${constraintsPart}; ${statePart}`;
}

function testingSummary(documented: string[], derived: string[], ciFiles: string[]): string {
  const testPart = documented.length > 0
    ? `${documented.length} documented test command(s)`
    : derived.length > 0
      ? `${derived.length} discoverable test command(s), but not documented`
      : 'no test command found';
  const ciPart = ciFiles.length > 0
    ? `CI config present (${ciFiles.join(', ')})`
    : 'CI config missing';
  return `${testPart}; ${ciPart}`;
}

function governanceSummary(skillFiles: string[], permissionFiles: string[], hookFiles: string[]): string {
  const skillPart = skillFiles.length > 0 ? `${skillFiles.length} skill file(s)` : 'no skills found';
  const permissionPart = permissionFiles.length > 0 ? `${permissionFiles.length} permission config file(s)` : 'permissions not explicit';
  const hookPart = hookFiles.length > 0 ? `${hookFiles.length} hook(s) wired` : 'hooks not wired';
  return `${skillPart}; ${permissionPart}; ${hookPart}`;
}

function freshnessSummary(freshness: ScoreSignals['freshness']): string {
  if (!freshness.latestCodeChange || !freshness.latestConfigChange) {
    return 'not enough signal to compare config freshness';
  }
  if ((freshness.deltaDays ?? 0) === 0) {
    return `config is current with code (${freshness.latestConfigChange} vs ${freshness.latestCodeChange})`;
  }
  return `config trails code by ${freshness.deltaDays} day(s) (${freshness.latestConfigChange} vs ${freshness.latestCodeChange})`;
}

function buildRecommendations(input: {
  aiDir: string;
  manifestPath: string;
  claudeExists: boolean;
  claudeSubstantive: boolean;
  cursorFiles: string[];
  agentsFile: string | undefined;
  manifestExists: boolean;
  brokenPaths: string[];
  commandSignals: CommandSignal[];
  documentedTestCommands: string[];
  derivedTestCommands: string[];
  manifestParsed: boolean;
  missingModules: string[];
  constraintsDefined: boolean;
  stateDefined: boolean;
  ciFiles: string[];
  skillFiles: string[];
  permissionFiles: string[];
  hookFiles: string[];
  freshnessSignals: ScoreSignals['freshness'];
}): string[] {
  const recommendations: RecommendationCandidate[] = [];

  if (!input.manifestExists) {
    recommendations.push({
      priority: 10,
      text: `Add ${input.manifestPath} and baseline ADF modules with \`charter bootstrap --yes\` so agents get routed repo context.`,
    });
  } else if (!input.manifestParsed) {
    recommendations.push({
      priority: 9,
      text: `Fix ${input.manifestPath} so it parses cleanly; broken routing removes architecture signal for agents.`,
    });
  }

  if (!input.claudeExists) {
    recommendations.push({
      priority: 8,
      text: 'Add `CLAUDE.md` with repo-specific entrypoints, test commands, and review constraints.',
    });
  } else if (!input.claudeSubstantive) {
    recommendations.push({
      priority: 6,
      text: 'Expand `CLAUDE.md` beyond a thin pointer so it captures the repo-specific commands and guardrails an agent needs on first read.',
    });
  }

  if (input.cursorFiles.length === 0) {
    recommendations.push({
      priority: 5,
      text: 'Add `.cursorrules` or `.cursor/rules/*` so Cursor-class agents inherit the same repo rules.',
    });
  }

  if (!input.agentsFile) {
    recommendations.push({
      priority: 5,
      text: 'Add `AGENTS.md` to document multi-agent handoffs, ownership boundaries, and local operating rules.',
    });
  }

  if (input.brokenPaths.length > 0) {
    recommendations.push({
      priority: 8,
      text: `Fix or remove ${input.brokenPaths.length} broken path reference(s): ${input.brokenPaths.slice(0, 3).join(', ')}${input.brokenPaths.length > 3 ? ', ...' : ''}.`,
    });
  }

  if (input.commandSignals.length === 0) {
    recommendations.push({
      priority: 7,
      text: 'Document at least one runnable setup/test command in `README.md`, `CLAUDE.md`, or your ADF files.',
    });
  } else if (input.commandSignals.some((signal) => !signal.runnable)) {
    recommendations.push({
      priority: 6,
      text: 'Replace placeholder or non-runnable command examples with commands that match the repo tooling exactly.',
    });
  }

  if (input.missingModules.length > 0) {
    recommendations.push({
      priority: 7,
      text: `Restore or register missing ADF module(s): ${input.missingModules.slice(0, 3).join(', ')}${input.missingModules.length > 3 ? ', ...' : ''}.`,
    });
  }

  if (!input.constraintsDefined) {
    recommendations.push({
      priority: 7,
      text: `Define non-negotiable constraints in \`${input.aiDir}/core.adf\` or \`CLAUDE.md\` so agents have explicit load-bearing rules.`,
    });
  }

  if (!input.stateDefined) {
    recommendations.push({
      priority: 5,
      text: `Track current state and next steps in \`${input.aiDir}/state.adf\` or a top-level status doc.`,
    });
  }

  if (input.documentedTestCommands.length === 0 && input.derivedTestCommands.length > 0) {
    recommendations.push({
      priority: 6,
      text: `Document the canonical test command for agents to run, for example \`${input.derivedTestCommands[0]}\`.`,
    });
  } else if (input.documentedTestCommands.length === 0) {
    recommendations.push({
      priority: 6,
      text: 'Add a runnable test command so agents can verify changes locally before handing work back.',
    });
  }

  if (input.ciFiles.length === 0) {
    recommendations.push({
      priority: 6,
      text: 'Add CI under `.github/workflows/` or your platform equivalent so agent-written changes have an automated gate.',
    });
  }

  if (input.skillFiles.length === 0) {
    recommendations.push({
      priority: 4,
      text: 'Define reusable repo skills with `SKILL.md` files for repeated workflows or specialist tasks.',
    });
  }

  if (input.permissionFiles.length === 0) {
    recommendations.push({
      priority: 4,
      text: 'Add explicit agent permission or sandbox settings under `.claude/`, `.codex/`, `.cursor/`, or equivalent config.',
    });
  }

  if (input.hookFiles.length === 0) {
    recommendations.push({
      priority: 4,
      text: 'Wire `pre-commit` or `commit-msg` hooks with `.husky/`, `.githooks/`, or `charter hook install`.',
    });
  }

  if ((input.freshnessSignals.deltaDays ?? 0) > 30 && input.freshnessSignals.latestCodeChange && input.freshnessSignals.latestConfigChange) {
    recommendations.push({
      priority: 7,
      text: `Refresh agent config after recent code changes; config is last updated on ${input.freshnessSignals.latestConfigChange} while code changed on ${input.freshnessSignals.latestCodeChange}.`,
    });
  }

  return recommendations
    .sort((a, b) => b.priority - a.priority || a.text.localeCompare(b.text))
    .slice(0, 5)
    .map((entry) => entry.text);
}

function printScoreReport(report: ScoreReport): void {
  const gradeColor = report.score.grade === 'A' || report.score.grade === 'B'
    ? 'green'
    : report.score.grade === 'C' || report.score.grade === 'D'
      ? 'yellow'
      : 'red';
  const labelWidth = Math.max(...report.categories.map((category) => category.label.length));

  console.log('');
  console.log(`  ${style('Charter Score', 'bold')}`);
  console.log(`  Repo:  ${report.repo}`);
  console.log(`  Score: ${style(`${report.score.total}/100 ${report.score.grade}`, gradeColor, 'bold')}`);
  console.log('');
  console.log('  Categories');
  for (const category of report.categories) {
    const color = category.status === 'strong' ? 'green' : category.status === 'partial' ? 'yellow' : 'red';
    const icon = category.status === 'strong' ? '[ok]' : category.status === 'partial' ? '[warn]' : '[miss]';
    console.log(`    ${style(icon, color)} ${category.label.padEnd(labelWidth)} ${style(`${String(category.score).padStart(2)}/${category.max}`, color)}  ${category.summary}`);
  }

  if (report.recommendations.length > 0) {
    console.log('');
    console.log('  Recommendations');
    for (const recommendation of report.recommendations) {
      console.log(`    - ${recommendation}`);
    }
  }

  console.log('');
}

function printHelp(): void {
  console.log('');
  console.log('  charter score');
  console.log('');
  console.log('  Usage:');
  console.log('    charter score [--ai-dir <dir>] [--format text|json] [--ci]');
  console.log('');
  console.log('  Deterministic local AI-readiness audit for the current repo.');
  console.log('  Scores agent config, grounding, architecture, testing, governance, and freshness.');
  console.log('');
  console.log('  --ai-dir <dir>: Override the ADF directory (default: .ai)');
  console.log(`  --ci: exit 1 when score is below ${CI_MIN_SCORE}`);
  console.log('');
}

function style(text: string, ...styles: Array<'bold' | 'dim' | 'green' | 'red' | 'yellow' | 'cyan'>): string {
  if (!supportsColor()) return text;
  const codes: Record<string, string> = {
    bold: '\u001b[1m',
    cyan: '\u001b[36m',
    dim: '\u001b[2m',
    green: '\u001b[32m',
    red: '\u001b[31m',
    yellow: '\u001b[33m',
  };
  return `${styles.map((entry) => codes[entry]).join('')}${text}\u001b[0m`;
}

function supportsColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === '0') return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return !!process.stdout.isTTY && process.env.TERM !== 'dumb';
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

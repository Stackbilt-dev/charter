/**
 * charter context
 *
 * Generates a pre-digested repo brief for AI agents: routes, hotspots,
 * governance, and sensitivity — all within a token budget.
 *
 * Output modes:
 *   charter context              print to stdout + write .charter/context.md
 *   charter context --stdout-only  print to stdout only
 *   charter context --verbose    no token ceiling (for human review)
 *   charter context --write      write .charter/context.md only, no stdout
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import cliPkg from '../../package.json';
import { analyze as analyzeBlast, BlastInputSchema } from '@stackbilt/blast';
import { analyze as analyzeSurface, SurfaceInputSchema } from '@stackbilt/surface';
import { parseAdf, parseManifest } from '@stackbilt/adf';
import { detectTsconfigAliases } from './blast';
import { detectStack, loadPackageContexts } from './setup';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';

// ============================================================================
// Public types
// ============================================================================

export interface BriefOptions {
  configPath?: string; // default '.charter'
  aiDir?: string; // default '.ai'
  verbose?: boolean; // if true, no token ceiling — for human use
}

export interface BriefResult {
  markdown: string;
  tokenCount: number; // estimated (chars / 4, ceiling)
  truncated: boolean;
  truncatedSections: string[];
}

// ============================================================================
// Constants
// ============================================================================

const TOKEN_CEILING = 2000;
const CHAR_CEILING = TOKEN_CEILING * 4; // 8000 chars

/** Estimate tokens from a string (ceiling). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ============================================================================
// Git SHA
// ============================================================================

function getGitSha(): string {
  try {
    return execSync('git rev-parse HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    })
      .trim()
      .slice(0, 8);
  } catch {
    return '<no-git>';
  }
}

// ============================================================================
// Seed strategy (keyed by preset)
// ============================================================================

function getSeedCandidates(preset: string, root: string, pkgBin: Record<string, string>): string[] {
  const candidates: string[] = [];

  const tryExts = (base: string): string[] =>
    ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'].map((ext) => base + ext);

  const srcIndex = tryExts(path.join(root, 'src', 'index'));
  const srcMain = tryExts(path.join(root, 'src', 'main'));
  const srcApp = tryExts(path.join(root, 'src', 'App'));
  const srcServer = tryExts(path.join(root, 'src', 'server'));
  const srcAppLower = tryExts(path.join(root, 'src', 'app'));
  const wranglerEntry = resolveWranglerEntry(root);

  // Files with "routes" in name
  const routeFiles = findFilesWithNamePattern(root, /routes/i);

  const workerSeeds = [
    ...srcIndex,
    ...routeFiles,
    ...(wranglerEntry ? [wranglerEntry] : []),
  ];
  const frontendSeeds = [...srcApp, ...srcMain, ...srcIndex];
  const backendSeeds = [...srcIndex, ...srcServer, ...srcAppLower];
  const cliSeeds = [
    ...Object.values(pkgBin).map((b) => path.resolve(root, b)),
    ...findCommandFiles(root),
  ];

  switch (preset) {
    case 'worker':
      candidates.push(...workerSeeds);
      break;
    case 'frontend':
      candidates.push(...frontendSeeds);
      break;
    case 'backend':
      candidates.push(...backendSeeds);
      break;
    case 'fullstack':
      candidates.push(...workerSeeds, ...frontendSeeds);
      break;
    case 'cli':
      candidates.push(...cliSeeds);
      break;
    case 'docs': {
      const readme = path.join(root, 'README.md');
      if (fs.existsSync(readme)) candidates.push(readme);
      const docsMds = findMarkdownFiles(root);
      candidates.push(...docsMds);
      break;
    }
    default:
      candidates.push(...srcIndex, ...srcMain);
      break;
  }

  // Filter to existing files, deduplicate, cap at 10
  const seen = new Set<string>();
  const result: string[] = [];
  for (const c of candidates) {
    if (!seen.has(c) && fs.existsSync(c)) {
      seen.add(c);
      result.push(c);
      if (result.length >= 10) break;
    }
  }
  return result;
}

function resolveWranglerEntry(root: string): string | null {
  const wranglerPath = path.join(root, 'wrangler.toml');
  if (!fs.existsSync(wranglerPath)) return null;
  try {
    const content = fs.readFileSync(wranglerPath, 'utf8');
    const m = content.match(/^main\s*=\s*["']?([^"'\n]+)["']?/m);
    if (m) return path.resolve(root, m[1].trim());
  } catch {
    // ignore
  }
  return null;
}

function findFilesWithNamePattern(root: string, pattern: RegExp): string[] {
  const result: string[] = [];
  const ignore = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'coverage', '__tests__']);
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (ignore.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && pattern.test(e.name)) result.push(full);
    }
  }
  walk(root);
  return result.slice(0, 5);
}

function findCommandFiles(root: string): string[] {
  const cmdsDir = path.join(root, 'src', 'commands');
  if (!fs.existsSync(cmdsDir)) return [];
  try {
    return fs
      .readdirSync(cmdsDir)
      .filter((f) => /\.[mc]?[tj]sx?$/.test(f))
      .slice(0, 5)
      .map((f) => path.join(cmdsDir, f));
  } catch {
    return [];
  }
}

function findMarkdownFiles(root: string): string[] {
  const docsDir = path.join(root, 'docs');
  if (!fs.existsSync(docsDir)) return [];
  try {
    return fs
      .readdirSync(docsDir)
      .filter((f) => /\.md$/i.test(f))
      .slice(0, 5)
      .map((f) => path.join(docsDir, f));
  } catch {
    return [];
  }
}

function getSectionTextValue(
  doc: ReturnType<typeof parseAdf>,
  sectionKey: string
): string | undefined {
  const section = doc.sections.find((candidate) => candidate.key === sectionKey);
  if (!section || section.content.type !== 'text') {
    return undefined;
  }
  const value = section.content.value.trim();
  return value.length > 0 ? value : undefined;
}

function collectSensitivityTagsFromDoc(
  doc: ReturnType<typeof parseAdf>,
  target: Set<string>
): void {
  for (const section of doc.sections) {
    if (section.key !== 'SENSITIVITY') continue;
    if (section.content.type === 'list') {
      for (const item of section.content.items) {
        const normalized = item.trim();
        if (normalized.length > 0) target.add(normalized);
      }
      continue;
    }
    if (section.content.type === 'map') {
      for (const entry of section.content.entries) {
        const normalizedValue = entry.value.trim();
        if (normalizedValue.length > 0) {
          target.add(`${entry.key}: ${normalizedValue}`);
        } else {
          target.add(entry.key);
        }
      }
      continue;
    }
    if (section.content.type === 'text') {
      for (const line of section.content.value.split(/\r?\n/)) {
        const normalized = line.trim();
        if (normalized.length > 0) target.add(normalized);
      }
    }
  }
}

// ============================================================================
// Brief model
// ============================================================================

interface BriefModel {
  // Identity
  packageName: string;
  stack: string;
  preset: string;
  version: string;
  description: string | null;
  bin: string | null;

  // Surface
  routes: Array<{ method: string; path: string; framework: string }>;
  totalRoutes: number;
  totalFrameworks: number;
  schemas: Array<{ name: string; columns: string[] }>;
  totalTables: number;

  // Hotspots
  hotFiles: Array<{ file: string; importers: number }>;
  fileCount: number;
  hotspotError: string | null;

  // Sensitivity
  sensitivityTags: string[];

  // Governance
  defaultLoad: string[];
  onDemand: Array<{ path: string; triggers: string[] }>;
  noManifest: boolean;

  // Footer
  gitSha: string;
  timestamp: string;
}

// ============================================================================
// Rendering
// ============================================================================

function renderBrief(
  model: BriefModel,
  opts: {
    routeLimit: number;
    tableLimit: number;
    hotfileLimit: number;
    onDemandLimit: number | null;
    truncatedSections: string[];
  }
): string {
  const lines: string[] = [];

  // Title
  lines.push(`# ${model.packageName} — repo brief`);
  lines.push('');

  // Identity
  lines.push('## Identity');
  lines.push(`- **Stack**: ${model.stack}`);
  lines.push(`- **Preset**: ${model.preset}`);
  lines.push(`- **Package**: ${model.packageName} v${model.version}`);
  if (model.description) lines.push(`- **Description**: ${model.description}`);
  if (model.bin) lines.push(`- **Bin**: ${model.bin}`);
  lines.push('');

  // Surface
  const routeLimit = opts.routeLimit;
  const tableLimit = opts.tableLimit;
  const displayedRoutes = model.routes.slice(0, routeLimit);
  const displayedTables = model.schemas.slice(0, tableLimit);

  lines.push('## Surface');
  lines.push(
    `${model.totalRoutes} routes across ${model.totalFrameworks} frameworks · ${model.totalTables} D1 tables`
  );
  lines.push('');
  if (displayedRoutes.length > 0) {
    lines.push('| Method | Path | Framework |');
    lines.push('| ------ | ---- | --------- |');
    for (const r of displayedRoutes) {
      lines.push(`| ${r.method} | ${r.path} | ${r.framework} |`);
    }
    lines.push('');
  }
  if (displayedTables.length > 0) {
    lines.push(`D1 Tables (top ${Math.min(tableLimit, displayedTables.length)} max):`);
    for (const t of displayedTables) {
      lines.push(`- \`${t.name}\`: ${t.columns.join(', ')}`);
    }
    lines.push('');
  }
  if (displayedRoutes.length === 0 && displayedTables.length === 0) {
    lines.push('_No routes or D1 tables detected._');
    lines.push('');
  }

  // Hotspots
  const hotfileLimit = opts.hotfileLimit;
  const displayedHotfiles = model.hotFiles.slice(0, hotfileLimit);

  lines.push('## Hotspots');
  if (model.hotspotError) {
    lines.push(`Hotspots: ${model.hotspotError}`);
  } else {
    lines.push(
      `${model.fileCount} source files scanned · top hot files by importer count`
    );
    lines.push('');
    if (displayedHotfiles.length > 0) {
      lines.push('| File | Importers | Flag |');
      lines.push('| ---- | --------- | ---- |');
      for (const h of displayedHotfiles) {
        const flag = h.importers >= 10 ? 'CROSS_CUTTING' : '';
        lines.push(`| ${h.file} | ${h.importers} | ${flag} |`);
      }
    }
  }
  lines.push('');

  // Sensitivity
  lines.push('## Sensitivity');
  if (model.sensitivityTags.length > 0) {
    for (const tag of model.sensitivityTags) {
      lines.push(`- ${tag}`);
    }
  } else {
    lines.push('No sensitivity configuration found.');
  }
  lines.push('');

  // Governance
  lines.push('## Governance');
  if (model.noManifest) {
    lines.push('No ADF manifest found.');
  } else {
    lines.push(`**DEFAULT_LOAD**: ${model.defaultLoad.join(', ') || '(none)'}`);
    const onDemandEntries =
      opts.onDemandLimit !== null
        ? model.onDemand.slice(0, opts.onDemandLimit)
        : model.onDemand;
    if (onDemandEntries.length > 0) {
      const parts = onDemandEntries.map((m) => {
        const triggers = m.triggers.length > 0 ? ` (triggers: ${m.triggers.join(', ')})` : '';
        return `${m.path}${triggers}`;
      });
      lines.push(`**ON_DEMAND**: ${parts.join(', ')}`);
    } else {
      lines.push('**ON_DEMAND**: (none)');
    }
  }
  lines.push('');

  // See also
  lines.push('## See also');
  lines.push('- `CLAUDE.md` for human-authored rules and project conventions');
  lines.push('');

  // Truncated section
  if (opts.truncatedSections.length > 0) {
    lines.push('## Truncated');
    for (const s of opts.truncatedSections) {
      lines.push(`- ${s}`);
    }
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push(`_Generated from git SHA ${model.gitSha} · ${model.timestamp}_`);

  return lines.join('\n');
}

// ============================================================================
// generateBrief — core implementation
// ============================================================================

export async function generateBrief(options?: BriefOptions): Promise<BriefResult> {
  const configPath = path.resolve(options?.configPath ?? '.charter');
  const aiDir = path.resolve(options?.aiDir ?? '.ai');
  const verbose = options?.verbose ?? false;
  const root = process.cwd();

  // ---- Load .charter/config.json ----
  let charterConfig: Record<string, unknown> = {};
  try {
    const cfgPath = path.join(configPath, 'config.json');
    if (fs.existsSync(cfgPath)) {
      charterConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    }
  } catch {
    // ignore
  }

  const configuredStack = typeof charterConfig.stack === 'string'
    ? charterConfig.stack.trim()
    : undefined;
  const configuredPreset = typeof charterConfig.preset === 'string'
    ? charterConfig.preset.trim()
    : undefined;
  let stack = configuredStack && configuredStack.length > 0 ? configuredStack : 'unknown';
  let preset = configuredPreset && configuredPreset.length > 0 ? configuredPreset : 'default';
  const sensitivityTagSet = new Set<string>();
  const sensCfg = charterConfig.sensitivity;
  if (sensCfg && typeof sensCfg === 'object' && sensCfg !== null) {
    if (Array.isArray((sensCfg as Record<string, unknown>).tags)) {
      for (const t of (sensCfg as { tags: unknown[] }).tags) {
        if (typeof t === 'string' && t.trim().length > 0) sensitivityTagSet.add(t.trim());
      }
    }
  } else if (Array.isArray(charterConfig.sensitivityTags)) {
    for (const t of charterConfig.sensitivityTags as unknown[]) {
      if (typeof t === 'string' && t.trim().length > 0) sensitivityTagSet.add(t.trim());
    }
  }

  // ---- Load package.json ----
  let packageName = path.basename(root);
  let version = '0.0.0';
  let description: string | null = null;
  let binString: string | null = null;
  let pkgBin: Record<string, string> = {};
  try {
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
      if (typeof pkg.name === 'string') packageName = pkg.name;
      if (typeof pkg.version === 'string') version = pkg.version;
      // Private *workspace* roots (monorepos with a workspaces field) carry a stale or
      // meaningless version — use the actual published CLI version so the brief reflects
      // what's installed. Plain private packages (internal apps without workspaces) keep
      // their own version unchanged.
      if (pkg.private === true && pkg.workspaces != null) version = cliPkg.version;
      if (typeof pkg.description === 'string') description = pkg.description;
      if (pkg.bin && typeof pkg.bin === 'object' && pkg.bin !== null) {
        pkgBin = pkg.bin as Record<string, string>;
        binString = Object.entries(pkgBin)
          .map(([k, v]) => `${k} → ${v}`)
          .join(', ');
      } else if (typeof pkg.bin === 'string') {
        binString = pkg.bin;
      }
    }
  } catch {
    // ignore
  }

  // ---- Surface analysis ----
  let routes: Array<{ method: string; path: string; framework: string }> = [];
  let totalRoutes = 0;
  let totalFrameworks = 0;
  let schemas: Array<{ name: string; columns: string[] }> = [];
  let totalTables = 0;
  try {
    const surfaceInput = SurfaceInputSchema.parse({ root });
    const surface = analyzeSurface(surfaceInput);
    routes = surface.routes.map((r) => ({
      method: r.method,
      path: r.prefix ? `${r.prefix}${r.path}` : r.path,
      framework: r.framework,
    }));
    totalRoutes = surface.summary.routeCount;
    totalFrameworks = Object.keys(surface.summary.routesByFramework).length;
    schemas = surface.schemas.map((t) => ({
      name: t.name,
      columns: t.columns.map((c) => {
        const flags: string[] = [];
        if (c.primaryKey) flags.push('pk');
        const base = c.name;
        return flags.length > 0 ? `${base} (${flags.join(', ')})` : base;
      }),
    }));
    totalTables = surface.summary.schemaTableCount;
  } catch {
    // surface analysis failure is non-fatal
  }

  // ---- Blast / hotspot analysis ----
  let hotFiles: Array<{ file: string; importers: number }> = [];
  let fileCount = 0;
  let hotspotError: string | null = null;
  try {
    const seeds = getSeedCandidates(preset, root, pkgBin);
    if (seeds.length === 0) {
      hotspotError = 'analysis unavailable';
    } else {
      const aliases = detectTsconfigAliases(root);
      const blastInput = BlastInputSchema.parse({
        seeds,
        root,
        aliases,
      });
      const blastResult = analyzeBlast(blastInput);
      fileCount = blastResult.fileCount;
      hotFiles = blastResult.hotFiles.map((h) => ({
        file: h.file,
        importers: h.importers,
      }));
    }
  } catch {
    hotspotError = 'analysis unavailable';
  }

  // ---- ADF manifest ----
  let defaultLoad: string[] = [];
  let onDemand: Array<{ path: string; triggers: string[] }> = [];
  let noManifest = false;
  let manifestPreset: string | undefined;
  let manifestStack: string | undefined;
  try {
    const manifestPath = path.join(aiDir, 'manifest.adf');
    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const doc = parseAdf(raw);
      const manifest = parseManifest(doc);
      defaultLoad = manifest.defaultLoad;
      onDemand = manifest.onDemand.map((m) => ({ path: m.path, triggers: m.triggers }));
      manifestPreset = getSectionTextValue(doc, 'PRESET');
      manifestStack = getSectionTextValue(doc, 'STACK');
      collectSensitivityTagsFromDoc(doc, sensitivityTagSet);

      const modulePaths = [...new Set([...manifest.defaultLoad, ...manifest.onDemand.map((m) => m.path)])];
      for (const modulePath of modulePaths) {
        const resolvedModulePath = path.join(aiDir, modulePath);
        if (!fs.existsSync(resolvedModulePath)) continue;
        try {
          const moduleDoc = parseAdf(fs.readFileSync(resolvedModulePath, 'utf8'));
          collectSensitivityTagsFromDoc(moduleDoc, sensitivityTagSet);
        } catch {
          // Ignore malformed module files in brief generation.
        }
      }
    } else {
      noManifest = true;
    }
  } catch {
    noManifest = true;
  }

  if (manifestPreset && (preset === 'default' || !configuredPreset)) {
    preset = manifestPreset;
  }
  if (manifestStack && (stack === 'unknown' || !configuredStack)) {
    stack = manifestStack;
  }
  if ((stack === 'unknown' || stack.length === 0) && preset !== 'default') {
    stack = preset;
  }
  if (stack === 'unknown' || stack.length === 0) {
    try {
      const detection = detectStack(loadPackageContexts());
      if (preset === 'default') preset = detection.suggestedPreset;
      stack = detection.suggestedPreset;
    } catch {
      // detection unavailable — stack stays 'unknown'
    }
  }
  const sensitivityTags = [...sensitivityTagSet];

  // ---- Build model ----
  const model: BriefModel = {
    packageName,
    stack,
    preset,
    version,
    description,
    bin: binString,
    routes,
    totalRoutes,
    totalFrameworks,
    schemas,
    totalTables,
    hotFiles,
    fileCount,
    hotspotError,
    sensitivityTags,
    defaultLoad,
    onDemand,
    noManifest,
    gitSha: getGitSha(),
    timestamp: new Date().toISOString(),
  };

  // ---- Truncation loop ----
  if (verbose) {
    const markdown = renderBrief(model, {
      routeLimit: model.routes.length,
      tableLimit: model.schemas.length,
      hotfileLimit: model.hotFiles.length,
      onDemandLimit: null,
      truncatedSections: [],
    });
    return {
      markdown,
      tokenCount: estimateTokens(markdown),
      truncated: false,
      truncatedSections: [],
    };
  }

  // Truncation parameters (start at max)
  let routeLimit = Math.min(10, model.routes.length);
  let tableLimit = Math.min(5, model.schemas.length);
  let hotfileLimit = Math.min(10, model.hotFiles.length);
  let onDemandLimit: number | null = null;
  const truncatedSections: string[] = [];

  // Helper to try rendering and check budget
  const tryRender = () =>
    renderBrief(model, {
      routeLimit,
      tableLimit,
      hotfileLimit,
      onDemandLimit,
      truncatedSections,
    });

  let markdown = tryRender();

  if (markdown.length <= CHAR_CEILING) {
    return {
      markdown,
      tokenCount: estimateTokens(markdown),
      truncated: false,
      truncatedSections: [],
    };
  }

  // Step 1: Reduce hotspots to top 5
  if (hotfileLimit > 5) {
    const before = hotfileLimit;
    hotfileLimit = 5;
    truncatedSections.push(`Hotspots: reduced from ${before} to ${hotfileLimit} files`);
    markdown = tryRender();
    if (markdown.length <= CHAR_CEILING) {
      return {
        markdown,
        tokenCount: estimateTokens(markdown),
        truncated: true,
        truncatedSections: [...truncatedSections],
      };
    }
  }

  // Step 2: Reduce D1 tables to top 3
  if (tableLimit > 3) {
    const before = tableLimit;
    tableLimit = 3;
    truncatedSections.push(`D1 Tables: reduced from ${before} to ${tableLimit} tables`);
    markdown = tryRender();
    if (markdown.length <= CHAR_CEILING) {
      return {
        markdown,
        tokenCount: estimateTokens(markdown),
        truncated: true,
        truncatedSections: [...truncatedSections],
      };
    }
  }

  // Step 3: Reduce routes to top 5
  if (routeLimit > 5) {
    const before = routeLimit;
    routeLimit = 5;
    truncatedSections.push(`Routes: reduced from ${before} to ${routeLimit} routes`);
    markdown = tryRender();
    if (markdown.length <= CHAR_CEILING) {
      return {
        markdown,
        tokenCount: estimateTokens(markdown),
        truncated: true,
        truncatedSections: [...truncatedSections],
      };
    }
  }

  // Step 4: Truncate Governance ON_DEMAND to first 3
  if (onDemandLimit === null || (typeof onDemandLimit === 'number' && onDemandLimit > 3)) {
    const before = model.onDemand.length;
    onDemandLimit = 3;
    truncatedSections.push(`Governance ON_DEMAND: reduced from ${before} to ${onDemandLimit} entries`);
    markdown = tryRender();
    if (markdown.length <= CHAR_CEILING) {
      return {
        markdown,
        tokenCount: estimateTokens(markdown),
        truncated: true,
        truncatedSections: [...truncatedSections],
      };
    }
  }

  // Step 5: Hard-slice to guarantee the budget is never exceeded.
  // Reached only when all prior steps still leave the brief over budget
  // (e.g. very long route paths or ON_DEMAND trigger lists).
  if (markdown.length > CHAR_CEILING) {
    truncatedSections.push('Content hard-sliced to fit token budget');
    markdown = markdown.slice(0, CHAR_CEILING) + '\n\n## Truncated\n- Content hard-sliced to fit token budget\n';
  }

  return {
    markdown,
    tokenCount: estimateTokens(markdown),
    truncated: truncatedSections.length > 0,
    truncatedSections: [...truncatedSections],
  };
}

// ============================================================================
// CLI adapter
// ============================================================================

export async function contextCommand(options: CLIOptions, args: string[]): Promise<number> {
  const stdoutOnly = args.includes('--stdout-only');
  const verbose = args.includes('--verbose');
  const writeOnly = args.includes('--write');

  if (stdoutOnly && writeOnly) {
    process.stderr.write('charter context: --stdout-only and --write are mutually exclusive\n');
    return EXIT_CODE.RUNTIME_ERROR;
  }

  const result = await generateBrief({
    configPath: options.configPath,
    aiDir: '.ai',
    verbose,
  });

  const { markdown } = result;

  if (!writeOnly) {
    console.log(markdown);
  }

  if (!stdoutOnly) {
    const configDir = path.resolve(options.configPath);
    try {
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      const outPath = path.join(configDir, 'context.md');
      fs.writeFileSync(outPath, markdown, 'utf8');
    } catch (err) {
      // Writing to .charter/ is non-fatal — log and continue
      process.stderr.write(
        `charter context: failed to write .charter/context.md: ${(err as Error).message}\n`
      );
    }
  }

  return EXIT_CODE.SUCCESS;
}

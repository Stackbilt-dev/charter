/**
 * charter serve
 *
 * Exposes ADF-curated project context as an MCP server.
 * Supports stdio (default) and SSE transports.
 *
 * Usage:
 *   charter serve                              # stdio, for Claude Code/Codex/Cursor
 *   charter serve --transport sse --port 3847  # SSE, for network access
 *   charter serve --name "my-project"          # custom server name
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  parseAdf,
  formatAdf,
  applyPatches,
  parseManifest,
  bundleModules,
  resolveModules,
  validateConstraints,
  evaluateEvidence,
} from '@stackbilt/adf';
import { analyze as analyzeBlast, BlastInputSchema } from '@stackbilt/blast';
import { generateBrief } from './context';
import { contextRefreshCommand } from './context-refresh';
import {
  analyze as analyzeSurface,
  SurfaceInputSchema,
  formatSurfaceMarkdown,
} from '@stackbilt/surface';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { detectTsconfigAliases } from './blast';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PORT = 3847;
const CONTEXT_SOURCE_SET = new Set(['git', 'github'] as const);

type ContextSourceName = 'git' | 'github';

const CharterContextInputSchema = z.object({
  refresh: z.boolean().optional().describe(
    'If true, refresh context before reading by running context-refresh.',
  ),
  sources: z.array(z.enum(['git', 'github'])).optional().describe(
    'Optional source override used only when refresh=true (for example ["git","github"]).',
  ),
  ttlMinutes: z.number().optional().describe(
    'Optional TTL override used only when refresh=true.',
  ),
});

type CharterContextInput = z.infer<typeof CharterContextInputSchema>;

// ============================================================================
// Command Entry
// ============================================================================

export async function serveCommand(options: CLIOptions, args: string[]): Promise<number> {
  const transport = (getFlag(args, '--transport') ?? 'stdio') as 'stdio' | 'sse';
  const port = parseInt(getFlag(args, '--port') ?? String(DEFAULT_PORT), 10);
  const aiDir = path.resolve(getFlag(args, '--ai-dir') ?? '.ai');
  const customName = getFlag(args, '--name');

  if (!fs.existsSync(aiDir)) {
    const errMsg = `No .ai/ directory found at ${aiDir}. Run: charter init (or pass --ai-dir <path>)`;
    if (transport === 'stdio') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: `charter serve: ${errMsg}` } }) + '\n');
    }
    throw new CLIError(errMsg);
  }
  const manifestPath = path.join(aiDir, 'manifest.adf');
  if (!fs.existsSync(manifestPath)) {
    const errMsg = `ADF manifest not found at ${manifestPath}. Run: charter adf init`;
    if (transport === 'stdio') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: `charter serve: ${errMsg}` } }) + '\n');
    }
    throw new CLIError(errMsg);
  }

  if (transport === 'sse') {
    throw new CLIError(`SSE transport not yet implemented. Use stdio (default) for now.`);
  }

  const projectName = customName ?? inferProjectName(aiDir);

  // Lazy-import both MCP SDK modules here — after all guards — so the SDK's
  // stdin handle is never acquired on the error paths above.
  const [{ McpServer: McpServerClass }, { StdioServerTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
  ]);

  const server = new McpServerClass({
    name: projectName,
    version: '1.0.0',
  });

  registerTools(server, aiDir, options);
  registerResources(server, aiDir);

  if (options.format !== 'json') {
    process.stderr.write(`charter serve: ${projectName} — stdio transport ready\n`);
    process.stderr.write(`  ADF modules: ${listModuleNames(aiDir).join(', ')}\n`);
  }

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);

  return EXIT_CODE.SUCCESS;
}

// ============================================================================
// Tool Registration
// ============================================================================

function registerTools(server: McpServer, aiDir: string, options: CLIOptions): void {

  (server.registerTool as Function)(
    'charter_context',
    {
      description:
        'Returns the current `.ai/context.snapshot.json` payload as structured JSON. Set refresh=true to run `charter context-refresh` first, then return the refreshed snapshot.',
      inputSchema: CharterContextInputSchema.shape,
    },
    async (rawInput: unknown) => {
      try {
        const input = CharterContextInputSchema.parse(rawInput ?? {});
        const result = await loadCharterContextSnapshot(options, aiDir, input);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  (server.registerTool as Function)(
    'getProjectContext',
    {
      description: 'Returns the ADF bundle for this project — constraints, context, and advisory rules loaded for the given task or trigger keywords.',
      inputSchema: { task: z.string().optional().describe('Task description or trigger keywords to load on-demand modules') },
    },
    async ({ task }: { task?: string }) => {
      try {
        const manifest = loadManifest(aiDir);
        const keywords = task ? task.toLowerCase().split(/\s+/) : [];
        const modulePaths = resolveModules(manifest, keywords);
        const bundle = bundleModules(
          aiDir,
          modulePaths,
          (p) => fs.readFileSync(p, 'utf-8'),
          keywords,
          manifest,
        );
        return { content: [{ type: 'text' as const, text: formatAdf(bundle.mergedDocument) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'getArchitecturalDecisions',
    {
      description: 'Returns load-bearing constraints from core.adf — the non-negotiable rules that define this project\'s identity.',
    },
    async () => {
      try {
        const corePath = path.join(aiDir, 'core.adf');
        if (!fs.existsSync(corePath)) {
          return { content: [{ type: 'text' as const, text: 'No core.adf found.' }] };
        }
        const doc = parseAdf(fs.readFileSync(corePath, 'utf-8'));
        const constraints = doc.sections
          .filter(s => s.key === 'CONSTRAINTS' && s.content.type === 'list')
          .flatMap(s => s.content.type === 'list' ? s.content.items : []);
        if (constraints.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No CONSTRAINTS found in core.adf.' }] };
        }
        return { content: [{ type: 'text' as const, text: constraints.map(c => `- ${c}`).join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'getProjectState',
    {
      description: 'Returns evidence metrics and constraint validation results from the project\'s ADF state.',
    },
    async () => {
      try {
        const manifest = loadManifest(aiDir);
        const allModulePaths = [
          ...manifest.defaultLoad,
          ...manifest.onDemand.map(m => m.path),
        ];
        const lines: string[] = ['## Project State\n'];

        // Constraint validation
        for (const modPath of allModulePaths) {
          const fullPath = path.join(aiDir, modPath);
          if (!fs.existsSync(fullPath)) continue;
          const doc = parseAdf(fs.readFileSync(fullPath, 'utf-8'));
          const result = validateConstraints(doc);
          const failing = result.constraints.filter(c => c.status === 'fail' || c.status === 'warn');
          if (failing.length > 0) {
            lines.push(`### ${modPath} — ${failing.length} issue(s)`);
            for (const c of failing) {
              lines.push(`- [${c.status.toUpperCase()}] ${c.message}`);
            }
            lines.push('');
          }
        }

        if (lines.length === 1) {
          lines.push('All constraints pass — no violations detected.');
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  // Advertised input shape is a plain ZodRawShape with no `.default()` /
  // chained refinements — the SDK's type compatibility layer only accepts
  // simple Zod types. Authoritative validation (defaults, min lengths, etc.)
  // lives in BlastInputSchema.parse inside the handler; the descriptions
  // here document those rules for agents.
  const charterBlastInput = {
    seeds: z.array(z.string()).describe(
      'One or more file paths whose blast radius should be computed (at least one required). Paths may be absolute or relative to the server cwd.',
    ),
    root: z.string().optional().describe(
      'Directory to scan for the dependency graph. Defaults to "." (server cwd).',
    ),
    maxDepth: z.number().optional().describe(
      'Maximum BFS depth when traversing reverse dependencies. Positive integer, defaults to 3. 1 = direct importers only.',
    ),
    aliases: z.record(z.string()).optional().describe(
      'Optional tsconfig-style path alias map (e.g. { "@/": "src/" }). If omitted, aliases are auto-detected from tsconfig.json at the scan root.',
    ),
  };

  // Cast matches the other inputSchema-bearing tools in this file. The SDK's
  // `ZodRawShapeCompat` overload resolution triggers TS2589 on any
  // multi-field raw shape. Follow-up: remove all three casts once the SDK
  // ships a better type signature (or once Charter upgrades zod).
  (server.registerTool as Function)(
    'charter_blast',
    {
      description:
        'Compute blast radius for one or more source files — which other files transitively import them, up to a configurable BFS depth. Returns structured JSON including affected files, hot files, and a depth histogram. A totalAffected >= 20 is the governance signal to classify a change as CROSS_CUTTING.',
      inputSchema: charterBlastInput,
    },
    async (rawInput: unknown) => {
      try {
        const parsed = BlastInputSchema.parse(rawInput);
        // Auto-detect tsconfig aliases if the caller didn't supply any.
        const aliases =
          Object.keys(parsed.aliases).length > 0
            ? parsed.aliases
            : detectTsconfigAliases(path.resolve(parsed.root));
        const result = analyzeBlast({ ...parsed, aliases });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Advertised shape mirrors the blast pattern: plain ZodRawShape with
  // `.optional()` (no `.default()` chaining) so the SDK's type compatibility
  // layer accepts it. Authoritative validation (defaults, structure) lives
  // in SurfaceInputSchema.parse inside the handler.
  const charterSurfaceInput = {
    root: z.string().optional().describe(
      'Directory to scan. Defaults to "." (server cwd).',
    ),
    extensions: z.array(z.string()).optional().describe(
      'File extensions scanned for HTTP route registrations (each with a leading dot). Defaults to .ts/.tsx/.js/.jsx/.mjs.',
    ),
    ignoreDirs: z.array(z.string()).optional().describe(
      'Extra directory names to skip in addition to the built-in ignore list (node_modules, dist, build, .git, .next, .turbo, .wrangler, coverage, __tests__, __mocks__, __fixtures__).',
    ),
    schemaPaths: z.array(z.string()).optional().describe(
      'Explicit paths to SQL schema files. When omitted, schema files are auto-detected under the scan root.',
    ),
    format: z.enum(['json', 'markdown']).optional().describe(
      'Response format. "json" (default) returns structured output; "markdown" returns a compact human/agent-friendly summary suitable for direct prompt injection.',
    ),
  };

  // Cast matches the other inputSchema-bearing tools in this file — see the
  // charter_blast registration above for context.
  (server.registerTool as Function)(
    'charter_surface',
    {
      description:
        "Extract the project's API surface — HTTP routes (Hono/Express/itty-router) and D1/SQLite schema tables. Returns structured JSON by default, or a compact markdown summary when format=\"markdown\". Use this instead of grepping for route handlers — it's the pre-digested map of what the repo exposes.",
      inputSchema: charterSurfaceInput,
    },
    async (rawInput: unknown) => {
      try {
        const raw = (rawInput ?? {}) as { format?: 'json' | 'markdown' };
        const format = raw.format ?? 'json';
        const parsed = SurfaceInputSchema.parse(rawInput);
        const result = analyzeSurface(parsed);
        const text =
          format === 'markdown'
            ? formatSurfaceMarkdown(result)
            : JSON.stringify(result, null, 2);
        return {
          content: [{ type: 'text' as const, text }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  (server.registerTool as Function)(
    'charter_brief',
    {
      description:
        'CALL THIS FIRST when entering a Charter-governed repo. Returns routes, hotspots, sensitivity tags, and governance posture in a single pre-digested brief — replaces 15-30 discovery tool calls and 10k-50k tokens of cold-boot discovery. Returns markdown by default or structured JSON when format="json".',
      inputSchema: {
        format: z.enum(['markdown', 'json']).optional().describe(
          'Response format. "markdown" (default) returns the brief as human/agent-readable markdown. "json" returns structured metadata including tokenCount and truncated flag.',
        ),
        verbose: z.boolean().optional().describe(
          'If true, removes the 2000-token size ceiling. Use for interactive human sessions only.',
        ),
      },
    },
    async (rawInput: unknown) => {
      try {
        const input = (rawInput ?? {}) as { format?: 'markdown' | 'json'; verbose?: boolean };
        const result = await generateBrief({ verbose: input.verbose ?? false });
        const text = input.format === 'json'
          ? JSON.stringify({ markdown: result.markdown, tokenCount: result.tokenCount, truncated: result.truncated, truncatedSections: result.truncatedSections }, null, 2)
          : result.markdown;
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  (server.registerTool as Function)(
    'updateEvidence',
    {
      description:
        'Measures actual metric values from source files tracked in manifest.adf and writes them back into the ADF modules that contain those metrics. Run this after code changes that affect tracked metrics (e.g. LOC counts). Returns what was measured, what changed (before/after), and current constraint status. Does NOT update .adf.lock — run `charter adf sync --write` separately if you need lock hygiene.',
      inputSchema: {
        dryRun: z.boolean().optional().describe(
          'If true, report what would change without writing any ADF files.',
        ),
        metrics: z.array(z.string()).optional().describe(
          'Specific metric keys to update (case-insensitive). If omitted, all auto-measurable metrics defined in manifest.adf are updated.',
        ),
      },
    },
    async (rawInput: unknown) => {
      try {
        const input = (rawInput ?? {}) as { dryRun?: boolean; metrics?: string[] };
        const dryRun = input.dryRun ?? false;
        const filterKeys = (input.metrics ?? []).map(k => k.toLowerCase());

        const manifest = loadManifest(aiDir);
        if (manifest.metrics.length === 0) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'no-op', reason: 'No METRICS entries in manifest.adf' }, null, 2) }] };
        }

        // Measure each source file
        const measurements: Array<{ metricKey: string; sourcePath: string; measured: number | null; error?: string }> = [];
        for (const ms of manifest.metrics) {
          const metricKey = ms.key.toLowerCase();
          if (filterKeys.length > 0 && !filterKeys.includes(metricKey)) continue;
          const absPath = path.resolve(ms.path);
          if (!fs.existsSync(absPath)) {
            measurements.push({ metricKey, sourcePath: ms.path, measured: null, error: 'file not found' });
            continue;
          }
          const lines = fs.readFileSync(absPath, 'utf-8').split('\n').length;
          measurements.push({ metricKey, sourcePath: ms.path, measured: lines });
        }

        // For each measurement, find the ADF module that owns the metric and patch it
        const allModuleNames = listModuleNames(aiDir);
        const fileChanges: Array<{
          file: string;
          metricKey: string;
          section: string;
          before: number | null;
          after: number;
        }> = [];
        const skipped: Array<{ metricKey: string; reason: string }> = [];

        for (const m of measurements) {
          if (m.measured === null) {
            skipped.push({ metricKey: m.metricKey, reason: m.error ?? 'file not found' });
            continue;
          }
          // Locate the ADF module that owns this metric key
          let ownerModule: string | null = null;
          let ownerSection: string | null = null;
          let currentValue: number | null = null;
          for (const modName of allModuleNames) {
            const modPath = path.join(aiDir, modName);
            if (!fs.existsSync(modPath)) continue;
            const doc = parseAdf(fs.readFileSync(modPath, 'utf-8'));
            for (const sec of doc.sections) {
              if (sec.content.type !== 'metric') continue;
              const entry = sec.content.entries.find(e => e.key === m.metricKey);
              if (entry) {
                ownerModule = modName;
                ownerSection = sec.key;
                currentValue = entry.value;
                break;
              }
            }
            if (ownerModule) break;
          }

          if (!ownerModule || !ownerSection) {
            skipped.push({ metricKey: m.metricKey, reason: 'metric key not found in any ADF module' });
            continue;
          }

          if (currentValue === m.measured) {
            skipped.push({ metricKey: m.metricKey, reason: `already up to date (${m.measured})` });
            continue;
          }

          fileChanges.push({
            file: ownerModule,
            metricKey: m.metricKey,
            section: ownerSection,
            before: currentValue,
            after: m.measured,
          });
        }

        // Apply patches grouped by file
        const written: string[] = [];
        if (!dryRun && fileChanges.length > 0) {
          const byFile = new Map<string, typeof fileChanges>();
          for (const c of fileChanges) {
            const list = byFile.get(c.file) ?? [];
            list.push(c);
            byFile.set(c.file, list);
          }
          for (const [modName, changes] of byFile) {
            const modPath = path.join(aiDir, modName);
            const doc = parseAdf(fs.readFileSync(modPath, 'utf-8'));
            const ops = changes.map(c => ({
              op: 'UPDATE_METRIC' as const,
              section: c.section,
              key: c.metricKey,
              value: c.after,
            }));
            const patched = applyPatches(doc, ops);
            fs.writeFileSync(modPath, formatAdf(patched));
            written.push(modName);
          }
        }

        // Re-evaluate constraints against the (possibly updated) state
        const modulePaths = [...manifest.defaultLoad];
        const bundle = bundleModules(aiDir, modulePaths, p => fs.readFileSync(p, 'utf-8'), [], manifest);
        const report = evaluateEvidence(bundle, undefined, 1.2);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              dryRun,
              measured: measurements,
              changes: fileChanges,
              skipped,
              written: dryRun ? [] : written,
              constraints: {
                allPassing: report.allPassing,
                failCount: report.failCount,
                warnCount: report.warnCount,
                items: report.constraints,
              },
              hint: dryRun ? 'Re-run with dryRun:false to write changes' : (written.length > 0 ? 'Run `charter adf sync --write` to update .adf.lock' : undefined),
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  (server.registerTool as Function)(
    'getRecentChanges',
    {
      description: 'Returns recent git commits with their classification (feature/fix/refactor/etc.).',
      inputSchema: { days: z.number().optional().describe('Number of days to look back (default: 7)') },
    },
    async ({ days = 7 }: { days?: number }) => {
      try {
        const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
        const log = execFileSync('git', [
          'log',
          `--since=${since}`,
          '--oneline',
          '--no-merges',
        ], { encoding: 'utf-8' }).trim();

        if (!log) {
          return { content: [{ type: 'text' as const, text: `No commits in the last ${days} days.` }] };
        }
        return { content: [{ type: 'text' as const, text: `## Recent Changes (last ${days} days)\n\n${log}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error reading git log: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}

// ============================================================================
// Resource Registration
// ============================================================================

function registerResources(server: McpServer, aiDir: string): void {

  // adf://manifest — module routing table
  server.resource(
    'manifest',
    'adf://manifest',
    async () => {
      const manifestPath = path.join(aiDir, 'manifest.adf');
      if (!fs.existsSync(manifestPath)) {
        return { contents: [{ uri: 'adf://manifest', text: 'manifest.adf not found', mimeType: 'text/plain' }] };
      }
      return {
        contents: [{
          uri: 'adf://manifest',
          text: fs.readFileSync(manifestPath, 'utf-8'),
          mimeType: 'text/plain',
        }],
      };
    },
  );

  // adf://modules/{name} — individual module content
  for (const modName of listModuleNames(aiDir)) {
    const uri = `adf://modules/${modName}`;
    server.resource(
      modName,
      uri,
      async () => {
        const modPath = path.join(aiDir, modName);
        if (!fs.existsSync(modPath)) {
          return { contents: [{ uri, text: `${modName} not found`, mimeType: 'text/plain' }] };
        }
        return {
          contents: [{
            uri,
            text: fs.readFileSync(modPath, 'utf-8'),
            mimeType: 'text/plain',
          }],
        };
      },
    );
  }
}

// ============================================================================
// Helpers
// ============================================================================

function loadManifest(aiDir: string) {
  const manifestPath = path.join(aiDir, 'manifest.adf');
  return parseManifest(parseAdf(fs.readFileSync(manifestPath, 'utf-8')));
}

function listModuleNames(aiDir: string): string[] {
  try {
    return fs.readdirSync(aiDir).filter(f => f.endsWith('.adf'));
  } catch {
    return [];
  }
}

function inferProjectName(aiDir: string): string {
  try {
    const corePath = path.join(aiDir, 'core.adf');
    if (fs.existsSync(corePath)) {
      const doc = parseAdf(fs.readFileSync(corePath, 'utf-8'));
      const project = doc.sections.find(s => s.key === 'PROJECT');
      if (project?.content.type === 'text') {
        return project.content.value.trim();
      }
    }
  } catch { /* ignore */ }

  // Fall back to directory name
  return path.basename(process.cwd());
}

export async function loadCharterContextSnapshot(
  options: CLIOptions,
  aiDir: string,
  input?: CharterContextInput,
): Promise<{ refreshed: boolean; snapshotPath: string; snapshot: unknown }> {
  const refresh = input?.refresh ?? false;
  const snapshotPathAbs = path.join(aiDir, 'context.snapshot.json');
  const snapshotPathRel = path.relative(process.cwd(), snapshotPathAbs);

  if (refresh) {
    const args = ['--ai-dir', aiDir];
    if (input?.sources && input.sources.length > 0) {
      // Defensive guard: this helper is exported and may be called from plain JS.
      const invalid = input.sources.filter((entry) => !CONTEXT_SOURCE_SET.has(entry));
      if (invalid.length > 0) {
        throw new CLIError(`Invalid sources: ${invalid.join(', ')}. Supported: git, github.`);
      }
      args.push('--sources', input.sources.join(','));
    }
    if (input?.ttlMinutes !== undefined) {
      if (!Number.isFinite(input.ttlMinutes) || input.ttlMinutes <= 0) {
        throw new CLIError(`Invalid ttlMinutes: ${input.ttlMinutes}. Must be a positive number.`);
      }
      args.push('--ttl-minutes', String(Math.floor(input.ttlMinutes)));
    }

    const exitCode = await contextRefreshCommand(
      { ...options, format: 'json' },
      args,
      { log: () => {} },
    );
    if (exitCode !== EXIT_CODE.SUCCESS) {
      throw new CLIError(`context-refresh exited with code ${exitCode}`);
    }
  }

  if (!fs.existsSync(snapshotPathAbs)) {
    throw new CLIError(
      `Context snapshot not found at ${snapshotPathRel}. Run \`charter context-refresh\` or call charter_context with refresh=true.`,
    );
  }

  let snapshot: unknown;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPathAbs, 'utf-8'));
  } catch (err) {
    throw new CLIError(
      `Failed to parse context snapshot at ${snapshotPathRel}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    refreshed: refresh,
    snapshotPath: snapshotPathRel,
    snapshot,
  };
}

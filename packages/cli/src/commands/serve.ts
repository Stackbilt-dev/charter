/**
 * charter serve
 *
 * Exposes ADF-curated project context as an MCP server.
 * Supports stdio (default) and SSE transports.
 *
 * Usage:
 *   charter serve                              # stdio, for Claude Code
 *   charter serve --transport sse --port 3847  # SSE, for network access
 *   charter serve --name "my-project"          # custom server name
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  parseAdf,
  formatAdf,
  parseManifest,
  bundleModules,
  resolveModules,
  validateConstraints,
} from '@stackbilt/adf';
import { analyze as analyzeBlast, BlastInputSchema } from '@stackbilt/blast';
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

// ============================================================================
// Command Entry
// ============================================================================

export async function serveCommand(options: CLIOptions, args: string[]): Promise<number> {
  const transport = (getFlag(args, '--transport') ?? 'stdio') as 'stdio' | 'sse';
  const port = parseInt(getFlag(args, '--port') ?? String(DEFAULT_PORT), 10);
  const aiDir = getFlag(args, '--ai-dir') ?? '.ai';
  const customName = getFlag(args, '--name');

  if (!fs.existsSync(path.join(aiDir, 'manifest.adf'))) {
    throw new CLIError(`No .ai/ directory found. Run: charter init`);
  }

  if (transport === 'sse') {
    throw new CLIError(`SSE transport not yet implemented. Use stdio (default) for now.`);
  }

  const projectName = customName ?? inferProjectName(aiDir);

  const server = new McpServer({
    name: projectName,
    version: '1.0.0',
  });

  registerTools(server, aiDir);
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

function registerTools(server: McpServer, aiDir: string): void {

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
          (p) => fs.readFileSync(path.join(aiDir, p), 'utf-8'),
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

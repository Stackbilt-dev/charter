/**
 * materializer/project — project file generators
 *
 * Generates wrangler.toml, package.json, tsconfig.json, src/index.ts,
 * test/index.test.ts, README.md, schema.sql, and contract stubs.
 * Extracted from stackbilt-web/src/lib/scaffold-materializer.ts.
 * Pure — no CF Worker imports, no network calls.
 */

import type { ScaffoldFacts, ScaffoldFile } from '../types';
import { str, slugify, traitsInclude, type Facts } from './adf';

// ─── Intent Detection ─────────────────────────────────────────────────────────
// Augments scaffold output based on keywords in the user's description.

interface DomainHint {
  id: string;
  match: (intention: string) => boolean;
  deps?: Record<string, string>;
  devDeps?: Record<string, string>;
  bindings?: string[];
  scripts?: Record<string, string>;
  envInterface?: string[];
  indexImports?: string[];
  indexBody?: string;
  extraFiles?: ScaffoldFile[];
}

const DOMAIN_HINTS: DomainHint[] = [
  {
    id: 'mcp-server',
    match: (i) => /\bmcp\b/i.test(i) && /\bserver\b/i.test(i),
    deps: { '@modelcontextprotocol/sdk': '^1.0.0' },
    envInterface: ['// MCP server bindings'],
    indexBody: `
    // MCP SSE endpoint
    if (url.pathname === '/sse' || url.pathname === '/mcp') {
      // TODO: wire MCP server handler
      // See: https://modelcontextprotocol.io/docs/server
      return new Response('MCP SSE endpoint — wire server handler', {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      });
    }

    // MCP tool listing
    if (url.pathname === '/tools') {
      return Response.json({
        tools: [
          // TODO: define your MCP tools
          { name: 'example_tool', description: 'An example tool', inputSchema: { type: 'object', properties: {} } },
        ],
      });
    }`,
  },
  {
    id: 'chatroom',
    match: (i) => /\bchat\s*room\b/i.test(i) || (/\bchat\b/i.test(i) && /\broom\b/i.test(i)) || /\brealtime\b/i.test(i),
    deps: {},
    bindings: [
      `\n[[durable_objects.bindings]]\nname = "CHATROOM"\nclass_name = "ChatRoom"`,
      `\n[[migrations]]\ntag = "v1"\nnew_classes = ["ChatRoom"]`,
    ],
    envInterface: ['CHATROOM: DurableObjectNamespace;'],
    indexBody: `
    // WebSocket upgrade for chat
    if (url.pathname.startsWith('/room/')) {
      const roomId = url.pathname.split('/')[2] ?? 'default';
      const id = env.CHATROOM.idFromName(roomId);
      const stub = env.CHATROOM.get(id);
      return stub.fetch(request);
    }`,
    extraFiles: [{
      path: 'src/chatroom.ts',
      role: 'entry' as const,
      content: `// Durable Object: ChatRoom
// Each room is a persistent, named instance with WebSocket sessions.

export class ChatRoom implements DurableObject {
  private sessions: Set<WebSocket> = new Set();

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/websocket')) {
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      this.sessions.add(server);

      server.addEventListener('message', (event) => {
        // Broadcast to all connected clients
        for (const ws of this.sessions) {
          if (ws !== server && ws.readyState === WebSocket.READY_STATE_OPEN) {
            ws.send(typeof event.data === 'string' ? event.data : '');
          }
        }
      });

      server.addEventListener('close', () => {
        this.sessions.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // Room info
    return Response.json({
      room: url.pathname.split('/').pop(),
      connections: this.sessions.size,
    });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    for (const session of this.sessions) {
      if (session !== ws && session.readyState === WebSocket.READY_STATE_OPEN) {
        session.send(typeof message === 'string' ? message : '');
      }
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.sessions.delete(ws);
  }
}

interface Env {}
`,
    }],
  },
  {
    id: 'api',
    match: (i) => /\bapi\b/i.test(i) || /\brest\b/i.test(i) || /\bendpoint/i.test(i),
    deps: { 'hono': '^4.0.0' },
    indexImports: ["import { Hono } from 'hono';"],
    indexBody: `
    // API routes (Hono)
    // const app = new Hono<{ Bindings: Env }>();
    // app.get('/api/v1/items', (c) => c.json({ items: [] }));
    // return app.fetch(request, env, ctx);`,
  },
  {
    id: 'cron',
    match: (i) => /\bcron\b/i.test(i) || /\bschedul/i.test(i) || /\bperiodic/i.test(i),
    scripts: {},
    indexBody: `
    // Scheduled handler (cron trigger)
    // Configure in wrangler.toml: [triggers] crons = ["*/5 * * * *"]`,
  },
  {
    id: 'auth',
    match: (i) => /\bauth\b/i.test(i) || /\blogin\b/i.test(i) || /\bjwt\b/i.test(i),
    indexBody: `
    // Auth middleware
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      // TODO: validate JWT or API key
    }`,
  },
];

export function detectDomainHints(intention: string): DomainHint[] {
  return DOMAIN_HINTS.filter(h => h.match(intention));
}

// ─── PRD Section Parser ───────────────────────────────────────────────────────
// Extracts Stack:, Entities:, Integrations: from PRD-style intentions.

export interface PrdSections {
  stack: string[];
  entities: string[];
  integrations: string[];
}

export function parsePrdSections(intention: string): PrdSections {
  function extractSection(name: string): string[] {
    // Inline / bold: "Name: items" or "**Name**: items"
    const inlineRe = new RegExp(`(?:\\*\\*${name}\\*\\*|\\b${name})\\s*:([^\\n]+)`, 'i');
    const inlineMatch = intention.match(inlineRe);
    if (inlineMatch) {
      return inlineMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    }
    // Heading: "## Name\n- item\n- item"
    const headingRe = new RegExp(`^##\\s+${name}\\s*\\n((?:[ \\t]*[-*][ \\t]*[^\\n]+\\n?)*)`, 'im');
    const headingMatch = intention.match(headingRe);
    if (headingMatch) {
      return headingMatch[1]
        .split('\n')
        .map(line => line.replace(/^[ \t]*[-*][ \t]*/, '').trim())
        .filter(Boolean);
    }
    return [];
  }

  return {
    stack: extractSection('Stack'),
    entities: extractSection('Entities'),
    integrations: extractSection('Integrations'),
  };
}

// ─── Stack item → npm packages / wrangler bindings ───────────────────────────

interface StackItemMapping {
  test: RegExp;
  deps?: Record<string, string>;
  devDeps?: Record<string, string>;
  bindings?: (projectName: string) => string[];
}

const STACK_ITEM_MAPPINGS: StackItemMapping[] = [
  {
    test: /\bd1\b/i,
    bindings: (name) => [
      `\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${name}"\ndatabase_id = "" # TODO: wrangler d1 create ${name}`,
    ],
  },
  {
    test: /\br2\b/i,
    bindings: (name) => [
      `\n[[r2_buckets]]\nbinding = "BUCKET"\nbucket_name = "${name}"`,
    ],
  },
  {
    test: /workers?\s*ai/i,
    bindings: () => [`\n[ai]\nbinding = "AI"`],
  },
  {
    test: /\bqueue/i,
    bindings: (name) => [
      `\n[[queues.producers]]\nqueue = "${name}-tasks"\nbinding = "QUEUE"`,
    ],
  },
  {
    test: /\bkv\b/i,
    bindings: (name) => [
      `\n[[kv_namespaces]]\nbinding = "KV"\nid = "" # TODO: wrangler kv namespace create ${name}`,
    ],
  },
  { test: /stripe/i, deps: { stripe: '^16.0.0' } },
  { test: /resend/i, deps: { resend: '^4.0.0' } },
  { test: /twilio/i, deps: { twilio: '^5.0.0' } },
  { test: /google.?ads/i, deps: { 'google-ads-api': '^16.0.0' } },
  { test: /astro/i, deps: { astro: '^5.0.0' } },
  {
    test: /react/i,
    deps: { react: '^18.0.0', 'react-dom': '^18.0.0' },
    devDeps: { '@types/react': '^18.0.0', '@types/react-dom': '^18.0.0' },
  },
];

export function buildPrdHint(prd: PrdSections, projectName: string): DomainHint | null {
  if (prd.stack.length === 0 && prd.entities.length === 0) return null;

  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {};
  const bindings: string[] = [];
  const addedBindingKeys = new Set<string>();

  for (const item of prd.stack) {
    for (const mapping of STACK_ITEM_MAPPINGS) {
      if (mapping.test.test(item)) {
        if (mapping.deps) Object.assign(deps, mapping.deps);
        if (mapping.devDeps) Object.assign(devDeps, mapping.devDeps);
        if (mapping.bindings) {
          const key = mapping.test.source;
          if (!addedBindingKeys.has(key)) {
            bindings.push(...mapping.bindings(projectName));
            addedBindingKeys.add(key);
          }
        }
      }
    }
  }

  return {
    id: 'prd',
    match: () => true,
    deps: Object.keys(deps).length > 0 ? deps : undefined,
    devDeps: Object.keys(devDeps).length > 0 ? devDeps : undefined,
    bindings: bindings.length > 0 ? bindings : undefined,
  };
}

// ─── Schema SQL Renderer ──────────────────────────────────────────────────────

export function renderSchemaSQL(entityNames: string[], projectName: string): string {
  const hasTenant = entityNames.some(e => /org|tenant|account/i.test(e));

  const tables = entityNames.map(name => {
    const tableName = name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    const isRoot = hasTenant && /org|tenant|account/i.test(name);
    const tenantLine = hasTenant && !isRoot ? '  tenant_id TEXT NOT NULL,\n' : '';
    return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),\n${tenantLine}  created_at TEXT NOT NULL DEFAULT (datetime('now')),\n  updated_at TEXT NOT NULL DEFAULT (datetime('now'))\n);`;
  });

  const indexes = hasTenant
    ? entityNames
        .filter(n => !/org|tenant|account/i.test(n))
        .map(n => {
          const t = n.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
          return `CREATE INDEX IF NOT EXISTS idx_${t}_tenant ON ${t}(tenant_id);`;
        })
    : [];

  const parts = [
    `-- ${projectName} schema`,
    '-- Generated by Stackbilt scaffold engine',
    '',
    tables.join('\n\n'),
  ];
  if (indexes.length > 0) parts.push('', indexes.join('\n'));
  parts.push('');

  return parts.join('\n');
}

// ─── First-Party Dep Registry ─────────────────────────────────────────────────

interface FirstPartyDep {
  pkg: string;
  version: string;
  depType: 'dep' | 'devDep';
  deps?: Record<string, string>;
  devDeps?: Record<string, string>;
  trigger: (facts: Facts, intention: string) => boolean;
  starterFiles?: (facts: Facts, projectName: string, prd: PrdSections) => ScaffoldFile[];
}

function toPascalCase(s: string): string {
  return s.split(/[-_\s]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function renderContractTs(facts: Facts, projectName: string, prd: PrdSections): string {
  const entityName = prd.entities[0] ?? projectName;
  const pascal = toPascalCase(entityName);
  const slug = slugify(entityName);
  const hasDb = traitsInclude(facts, 'd1', 'sql', 'database') ||
    prd.stack.some(s => /\bd1\b|sql|postgres|mysql/i.test(s));
  const isWorkers = traitsInclude(facts, 'edge', 'v8-isolate', 'serverless', 'isolat') ||
    str(facts, 'runtime_name').toLowerCase().includes('worker');

  const apiRoutes = isWorkers ? `
    api: {
      basePath: '/api/${slug}s',
      routes: {
        create:  { method: 'POST',   path: '/' },
        getById: { method: 'GET',    path: '/:id' },
        update:  { method: 'PATCH',  path: '/:id' },
        delete:  { method: 'DELETE', path: '/:id' },
      },
    },` : '';

  const dbSurface = hasDb ? `
    db: {
      table: '${slug}s',
      indexes: [],
      columnOverrides: {
        createdAt: { default: 'CURRENT_TIMESTAMP' },
        updatedAt: { default: 'CURRENT_TIMESTAMP' },
      },
    },` : '';

  const surfaces = (apiRoutes || dbSurface)
    ? `\n\n  surfaces: {${apiRoutes}${dbSurface}\n  },`
    : '';

  const description = str(facts, 'requirement_name') || projectName;

  return `import { z } from 'zod';
import { defineContract } from '@stackbilt/contracts';

// TODO: rename fields and operations to match your domain.
// Run: npx @stackbilt/contracts generate

export const ${pascal}Contract = defineContract({
  name: '${pascal}',
  version: '1.0.0',
  description: '${description}',

  schema: z.object({
    id: z.string().uuid(),
    // TODO: add your domain-specific fields here
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),

  operations: {
    create: {
      input: z.object({
        // TODO: add creation input fields
      }),
      output: 'self' as const,
      emits: ['${slug}.created'],
    },
    update: {
      input: z.object({
        id: z.string().uuid(),
        // TODO: add update fields
      }),
      output: 'self' as const,
      emits: ['${slug}.updated'],
    },
    delete: {
      input: z.object({ id: z.string().uuid() }),
      output: 'self' as const,
      emits: ['${slug}.deleted'],
    },
  },${surfaces}

  authority: {
    create: { requires: 'authenticated' },
    update: { requires: 'authenticated' },
    delete: { requires: 'role', roles: ['admin'] },
  },
});
`;
}

const FIRST_PARTY_DEPS: FirstPartyDep[] = [
  {
    // Charter: ADF agent governance CLI — always needed since scaffold emits .ai/*.adf files
    pkg: '@stackbilt/cli',
    version: '^0.10.0',
    depType: 'devDep',
    trigger: () => true,
  },
  {
    pkg: '@stackbilt/contracts',
    version: '^0.2.1',
    depType: 'devDep',
    deps: { zod: '^4.3.6' },
    trigger: () => true,
    starterFiles: (facts, projectName, prd) => [{
      path: `src/contracts/${projectName}.contract.ts`,
      content: renderContractTs(facts, projectName, prd),
      role: 'contract',
    }],
  },
  {
    // Observability: always inject for Workers
    pkg: '@stackbilt/worker-observability',
    version: '^0.3.0',
    depType: 'dep',
    trigger: (facts, intention) =>
      traitsInclude(facts, 'edge', 'v8-isolate', 'serverless', 'isolat') ||
      str(facts, 'runtime_name').toLowerCase().includes('worker') ||
      /\b(worker|workers|cloudflare|wrangler)\b/i.test(intention),
  },
  {
    // Audit chain: tamper-evident audit trail
    pkg: '@stackbilt/audit-chain',
    version: '^0.1.0',
    depType: 'dep',
    trigger: (_facts, intention) =>
      /\b(audit|compliance|fintech|healthcare|hipaa|gdpr|soc2?|regulated|tamper|chain|ledger|immutable)\b/i.test(intention),
  },
  {
    pkg: '@stackbilt/llm-providers',
    version: '^1.0.0',
    depType: 'dep',
    trigger: (facts, intention) =>
      traitsInclude(facts, 'llm', 'ai', 'inference', 'chat', 'embedding') ||
      /\b(llm|generative[- ]?ai|chat(?:bot)?|inference|embed(?:ding)?|openai|anthropic|claude|gpt|workers[- ]?ai)\b/i.test(intention),
  },
];

// ─── Template Renderers ───────────────────────────────────────────────────────

export function renderPackageJson(
  facts: Facts,
  projectName: string,
  hints: DomainHint[] = [],
  extraDeps: Record<string, string> = {},
  extraDevDeps: Record<string, string> = {},
): string {
  const runtimeName = str(facts, 'runtime_name');
  const testFramework = str(facts, 'test_plan_framework', 'vitest');

  const isWorkers = traitsInclude(facts, 'edge', 'v8-isolate', 'serverless', 'isolat') ||
    runtimeName.toLowerCase().includes('worker');

  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {
    typescript: '^5.5.0',
  };

  if (isWorkers) {
    devDeps['wrangler'] = '^3.0.0';
    devDeps['@cloudflare/workers-types'] = '^4.0.0';
  }

  if (testFramework.includes('vitest') || testFramework === 'vitest') {
    devDeps['vitest'] = '^2.0.0';
  } else if (testFramework.includes('jest')) {
    devDeps['jest'] = '^29.0.0';
    devDeps['ts-jest'] = '^29.0.0';
  }

  const scripts: Record<string, string> = {
    build: 'tsc',
    typecheck: 'tsc --noEmit',
  };

  if (isWorkers) {
    scripts.dev = 'wrangler dev';
    scripts.deploy = 'wrangler deploy';
  }

  if (testFramework.includes('vitest')) {
    scripts.test = 'vitest run';
  } else {
    scripts.test = 'jest';
  }

  for (const hint of hints) {
    if (hint.deps) Object.assign(deps, hint.deps);
    if (hint.devDeps) Object.assign(devDeps, hint.devDeps);
    if (hint.scripts) Object.assign(scripts, hint.scripts);
  }

  Object.assign(deps, extraDeps);
  Object.assign(devDeps, extraDevDeps);

  return JSON.stringify({
    name: projectName,
    version: '0.1.0',
    private: true,
    scripts,
    dependencies: Object.keys(deps).length > 0 ? deps : undefined,
    devDependencies: devDeps,
  }, null, 2);
}

export function renderWranglerToml(facts: Facts, projectName: string, hints: DomainHint[] = []): string {
  const bindings: string[] = [];

  if (traitsInclude(facts, 'd1', 'sql', 'database')) {
    bindings.push(`
[[d1_databases]]
binding = "DB"
database_name = "${projectName}"
database_id = "" # TODO: create with wrangler d1 create ${projectName}`);
  }

  if (traitsInclude(facts, 'kv', 'key-value', 'cache')) {
    bindings.push(`
[[kv_namespaces]]
binding = "KV"
id = "" # TODO: create with wrangler kv namespace create ${projectName}`);
  }

  if (traitsInclude(facts, 'queue', 'async', 'background')) {
    bindings.push(`
[[queues.producers]]
queue = "${projectName}-tasks"
binding = "QUEUE"`);
  }

  for (const hint of hints) {
    if (hint.bindings) bindings.push(...hint.bindings);
  }

  return `name = "${projectName}"
main = "src/index.ts"
compatibility_date = "${new Date().toISOString().split('T')[0]}"
compatibility_flags = ["nodejs_compat"]
${bindings.join('\n')}
`;
}

export function renderIndexTs(facts: Facts, hints: DomainHint[] = []): string {
  const ifaceName = str(facts, 'interface_name');
  const reqName = str(facts, 'requirement_name');
  const threatMitigation = str(facts, 'threat_mitigation');

  const imports: string[] = [];
  const routeBodies: string[] = [];
  const envFields: string[] = [];

  for (const hint of hints) {
    if (hint.indexImports) imports.push(...hint.indexImports);
    if (hint.indexBody) routeBodies.push(hint.indexBody);
    if (hint.envInterface) envFields.push(...hint.envInterface);
  }

  const importsBlock = imports.length > 0 ? imports.join('\n') + '\n\n' : '';
  const routesBlock = routeBodies.length > 0 ? routeBodies.join('\n') + '\n' : '';
  const envBlock = envFields.length > 0 ? '\n  ' + envFields.join('\n  ') : '\n  // TODO: add bindings from wrangler.toml';

  const hasChatroom = hints.some(h => h.id === 'chatroom');
  const reExports = hasChatroom ? "\nexport { ChatRoom } from './chatroom';\n" : '';

  return `${importsBlock}// ${reqName} — main entry point
// UX pattern: ${ifaceName}
// Security: ${threatMitigation || 'standard hardening'}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }
${routesBlock}
    // TODO: implement ${reqName} handler
    return Response.json({ error: 'not implemented' }, { status: 501 });
  },
} satisfies ExportedHandler<Env>;

interface Env {${envBlock}
}
${reExports}`;
}

export function renderTestFile(facts: Facts, projectName: string): string {
  const testFramework = str(facts, 'test_plan_framework', 'vitest');
  const coverageTarget = str(facts, 'test_plan_coverage_target', '80%');
  const ciStage = str(facts, 'test_plan_ci_stage', 'pre-merge');
  const reqName = str(facts, 'requirement_name');

  if (testFramework.includes('vitest') || testFramework === 'vitest') {
    return `import { describe, it, expect } from 'vitest';

// Test plan: ${str(facts, 'test_plan_name')}
// CI stage: ${ciStage}
// Coverage target: ${coverageTarget}

describe('${reqName}', () => {
  it('should respond to health check', async () => {
    // TODO: import worker and test with miniflare or unstable_dev
    expect(true).toBe(true);
  });

  it('should handle primary use case', async () => {
    // TODO: implement ${reqName} test
    expect(true).toBe(true);
  });
});
`;
  }

  return `// Test plan: ${str(facts, 'test_plan_name')}
// CI stage: ${ciStage}
// Coverage target: ${coverageTarget}

describe('${reqName}', () => {
  it('should respond to health check', async () => {
    expect(true).toBe(true);
  });
});
`;
}

export function renderReadme(facts: Facts, projectName: string, intention: string): string {
  const reqName = str(facts, 'requirement_name');
  const reqPriority = str(facts, 'requirement_priority', 'P1');
  const ifaceName = str(facts, 'interface_name');
  const threatName = str(facts, 'threat_name');
  const runtimeName = str(facts, 'runtime_name');
  const testName = str(facts, 'test_plan_name');
  const taskName = str(facts, 'first_task_name');
  const confidence = str(facts, 'scaffold_confidence', 'moderate');

  return `# ${projectName}

> ${intention}

Scaffolded by [Stackbilt](https://stackbilt.dev). Confidence: **${confidence}**.

## Architecture

| Mode | Card | Key Detail |
|------|------|------------|
| Product | ${reqName} | Priority: ${reqPriority} |
| UX | ${ifaceName} | ${str(facts, 'interface_regions')} |
| Risk | ${threatName} | ${str(facts, 'threat_likelihood')} likelihood, ${str(facts, 'threat_impact')} impact |
| Runtime | ${runtimeName} | ${str(facts, 'runtime_traits')} |
| Test | ${testName} | ${str(facts, 'test_plan_framework')} @ ${str(facts, 'test_plan_ci_stage')} |
| Sprint | ${taskName} | ${str(facts, 'first_task_estimate')} pts, ${str(facts, 'first_task_complexity')} |

## Getting Started

\`\`\`bash
npm install
npx wrangler dev
\`\`\`

## First Task

**${taskName}** — ${str(facts, 'first_task_deliverable')}
- Estimate: ${str(facts, 'first_task_estimate')} points
- Complexity: ${str(facts, 'first_task_complexity')}
`;
}

export function renderTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ES2022',
      moduleResolution: 'bundler',
      lib: ['ES2022'],
      types: ['@cloudflare/workers-types'],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
    include: ['src'],
  }, null, 2);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate project-level ScaffoldFiles (package.json, wrangler.toml, tsconfig.json,
 * src/index.ts, test/index.test.ts, README.md, optional schema.sql + contract stubs)
 * for the given scaffold facts.
 *
 * @param scaffoldFacts - Structured scaffold facts from the classify pipeline
 * @param rawFacts      - Optional raw key-value facts from scaffold-cast (fallback to empty)
 */
export function generateProjectFiles(
  scaffoldFacts: ScaffoldFacts,
  rawFacts: Facts = {},
): ScaffoldFile[] {
  const projectName = scaffoldFacts.projectName;
  const intention = scaffoldFacts.intention;
  const hints = detectDomainHints(intention);

  const prd = parsePrdSections(intention);
  const prdHint = buildPrdHint(prd, projectName);
  if (prdHint) hints.push(prdHint);

  // Resolve first-party dep registry
  const fpDeps: Record<string, string> = {};
  const fpDevDeps: Record<string, string> = {};
  const fpFiles: ScaffoldFile[] = [];
  for (const entry of FIRST_PARTY_DEPS) {
    if (entry.trigger(rawFacts, intention)) {
      if (entry.depType === 'dep') fpDeps[entry.pkg] = entry.version;
      else fpDevDeps[entry.pkg] = entry.version;
      if (entry.deps) Object.assign(fpDeps, entry.deps);
      if (entry.devDeps) Object.assign(fpDevDeps, entry.devDeps);
      if (entry.starterFiles) fpFiles.push(...entry.starterFiles(rawFacts, projectName, prd));
    }
  }

  const files: ScaffoldFile[] = [
    { path: 'package.json', content: renderPackageJson(rawFacts, projectName, hints, fpDeps, fpDevDeps), role: 'config' },
    { path: 'tsconfig.json', content: renderTsConfig(), role: 'config' },
    { path: 'wrangler.toml', content: renderWranglerToml(rawFacts, projectName, hints), role: 'config' },
    { path: 'src/index.ts', content: renderIndexTs(rawFacts, hints), role: 'entry' },
    { path: 'test/index.test.ts', content: renderTestFile(rawFacts, projectName), role: 'test' },
    { path: 'README.md', content: renderReadme(rawFacts, projectName, intention), role: 'readme' },
  ];

  // Domain-specific extra files (e.g. chatroom.ts for Durable Objects)
  for (const hint of hints) {
    if (hint.extraFiles) {
      for (const ef of hint.extraFiles) {
        files.push({ ...ef, role: ef.path.startsWith('test/') ? 'test' : 'entry' });
      }
    }
  }

  // First-party starter files (contract stubs, provider configs, etc.)
  for (const fpFile of fpFiles) files.push(fpFile);

  // Schema SQL when entities were extracted from PRD sections
  if (prd.entities.length > 0) {
    files.push({ path: 'schema.sql', content: renderSchemaSQL(prd.entities, projectName), role: 'migration' });
  }

  return files;
}

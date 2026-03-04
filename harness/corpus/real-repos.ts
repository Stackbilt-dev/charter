/**
 * Real ecosystem repo definitions for harness testing.
 *
 * Instead of synthetic archetypes, these point at the actual .ai/ directories
 * from aegis and bizops-internal. The harness copies the real ADF structure
 * into a temp repo, generates realistic CLAUDE.md bloat grounded in the actual
 * codebase, and applies tidy for real — letting us inspect ADF health after
 * accumulation against the actual module structure.
 */

import * as path from 'node:path';

export interface RepoDefinition {
  id: string;
  label: string;
  /** Absolute path to the .ai/ directory to clone for testing */
  aiDir: string;
  /** Absolute path to the CLAUDE.md thin pointer to use as starting state */
  claudeMd: string;
  /** Context fed to Ollama so it generates content grounded in this repo */
  ollamaContext: string;
  /** Topics an AI assistant would realistically add to CLAUDE.md for this repo */
  topics: string[];
}

const ECO_ROOT = path.resolve(__dirname, '../../../');

export const REAL_REPOS: RepoDefinition[] = [
  {
    id: 'aegis',
    label: 'AEGIS daemon',
    aiDir: path.join(ECO_ROOT, 'aegis/.ai'),
    claudeMd: path.join(ECO_ROOT, 'aegis/CLAUDE.md'),
    ollamaContext: `
You are an AI assistant (Claude Code) working on AEGIS — Kurt's personal AI agent
running on Cloudflare Workers. The stack is:
- Hono router on a Cloudflare Worker (web/src/index.ts)
- D1 (SQLite) for three-tier memory: episodic, semantic, procedural
- Groq (llama-3.3-70b) for classification and triage (~free)
- Anthropic Claude (claude-sonnet-4-6) for complex reasoning ($$$)
- BizOps Copilot connected via Service Binding (Worker-to-Worker MCP)
- Local daemon (src/) with CLI REPL and PM2 scheduler — optional

Key source files:
  web/src/kernel/dispatch.ts  — edge dispatch loop, createIntent(), executors
  web/src/kernel/router.ts    — Groq classify → procedural lookup → circuit breaker
  web/src/kernel/memory.ts    — D1 CRUD for all three memory tiers
  web/src/kernel/scheduled.ts — hourly cron handler
  web/src/claude.ts           — Anthropic Messages API + MCP tool loop
  web/src/mcp-client.ts       — Streamable HTTP MCP client (Service Binding)
  web/src/groq.ts             — fetch-based Groq client
  web/src/auth.ts             — Bearer auth (cookie/header/query)

ADF modules: core.adf, kernel.adf, agent.adf, channels.adf, state.adf
`,
    topics: [
      'adding a new Groq classification intent pattern for a new message type',
      'updating the MCP tool loop in claude.ts to handle tool call errors gracefully',
      'adding a new memory tier query for semantic memory recall',
      'extending the procedural memory lifecycle — new status transitions',
      'adding a new scheduled task to the hourly cron in kernel/scheduled.ts',
      'updating the Hono router in index.ts with a new API endpoint',
      'debugging a Service Binding fetch error between aegis-web and businessops-copilot',
      'adding a new channel permission set for a new incoming message source',
      'tuning the circuit breaker thresholds in kernel/router.ts',
    ],
  },

  {
    id: 'bizops',
    label: 'BusinessOps Copilot',
    aiDir: path.join(ECO_ROOT, 'bizops-internal/.ai'),
    claudeMd: path.join(ECO_ROOT, 'bizops-internal/CLAUDE.md'),
    ollamaContext: `
You are an AI assistant (Claude Code) working on BusinessOps Copilot — Kurt's
AI-powered business operations tool for managing legal entities, compliance
deadlines, documents, and finances across multiple companies.

Stack:
- Cloudflare Worker with Hono router (worker/index.ts)
- D1 (SQLite) database with 10 migrations in migrations/
- R2 for document vault (DOCS_BUCKET binding)
- Durable Object: BizOpsMcpAgentV1 for MCP server
- React/Vite frontend (components/ directory)
- LLM: Groq primary → Gemini 2.5 Flash fallback
- 30 MCP tools across worker/mcp/tools/
- 9 REST handlers in worker/handlers/
- 11 business logic services in worker/services/

Key patterns:
- Services contain business logic; handlers do HTTP plumbing only
- MCP tools use normalizeToolResult/normalizeToolError wrappers
- Zod schemas validate all user input at API boundary
- Auth: master token + api_keys table
- Cron: 6 AM UTC daily for overdue detection + Slack digest

ADF modules: core.adf, backend.adf, frontend.adf, state.adf
`,
    topics: [
      'adding a new entity type (Texas LLC) with its own compliance deadline rules',
      'adding a new MCP tool for document retrieval from R2',
      'creating a new React component for the compliance dashboard view',
      'adding a new D1 migration for a new table or column',
      'debugging a Durable Object state issue in BizOpsMcpAgentV1',
      'adding a new REST handler for a new business feature',
      'extending the Groq advisor service with new business logic',
      'adding Slack notification support for a new event type',
      'updating the Zod validation schemas for a new API endpoint',
    ],
  },
];

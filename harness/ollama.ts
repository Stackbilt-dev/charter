/**
 * Ollama bloat generator.
 *
 * Prompts a local Ollama model to generate realistic CLAUDE.md content —
 * the kind an AI assistant would write when asked to document something
 * despite the thin pointer rules.
 *
 * Generated scenarios have no hardcoded `expected` routing. Instead the
 * runner operates in exploratory mode: it records what happened and
 * tracks core.adf bleed rate as the primary quality signal.
 */

// ============================================================================
// Types
// ============================================================================

export interface GeneratedSession {
  label: string;
  topic: string;
  inject: string;
}

export interface GeneratedScenario {
  id: string;
  archetype: string;
  model: string;
  sessions: GeneratedSession[];
}

// ============================================================================
// Prompts
// ============================================================================

const SYSTEM_PROMPT = `You are a developer documenting a project. Write content that would
realistically be added to a CLAUDE.md file — rules, conventions, architecture notes,
deployment instructions, etc.

FORMAT RULES (strict):
- Start directly with a ## H2 heading. No ### subheadings.
- Use only - bullet points (never * or numbered lists).
- No code blocks, no JSON, no bash fences.
- 3-6 bullet points per section, one rule or fact per bullet.
- Each bullet is a single sentence. No nested bullets.
- No preamble, no explanation, no closing remarks.`;

interface ArchetypeContext {
  stack: string;
  modules: string[];
}

const ARCHETYPES: Record<string, ArchetypeContext> = {
  worker: {
    stack: 'Cloudflare Worker using TypeScript, Hono, D1, KV, and Wrangler',
    modules: ['infra.adf', 'backend.adf', 'core.adf'],
  },
  backend: {
    stack: 'Node.js API using TypeScript, Express or Hono, PostgreSQL with Prisma, and Docker',
    modules: ['backend.adf', 'security.adf', 'infra.adf', 'core.adf'],
  },
  fullstack: {
    stack: 'Next.js 14 app with TypeScript, Tailwind, Prisma, and Vercel deployment',
    modules: ['frontend.adf', 'backend.adf', 'infra.adf', 'core.adf'],
  },
};

const TOPICS: Record<string, string[]> = {
  worker: [
    'wrangler deployment workflow and secrets management',
    'KV namespace conventions and key design',
    'D1 database access patterns and migrations',
    'Hono routing and middleware conventions',
    'error handling and response shapes for the API',
    'local development setup and environment variables',
    'Durable Objects usage patterns',
    'rate limiting and abuse prevention',
  ],
  backend: [
    'database access patterns and repository layer conventions',
    'authentication and authorization patterns',
    'API endpoint design and response shapes',
    'input validation and error handling',
    'Docker build and deployment workflow',
    'database migration conventions',
    'logging and observability',
    'rate limiting and security headers',
  ],
  fullstack: [
    'React component conventions and file organization',
    'server vs client component decisions',
    'authentication with NextAuth or Clerk',
    'Prisma schema conventions and migrations',
    'Tailwind usage patterns and design tokens',
    'API route conventions in the app router',
    'Vercel deployment and environment variable management',
    'testing strategy with Vitest and Playwright',
  ],
};

// ============================================================================
// Ollama Client
// ============================================================================

const OLLAMA_URL = 'http://localhost:11434';

async function generate(model: string, prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      system: SYSTEM_PROMPT,
      stream: false,
      options: {
        temperature: 0.8,
        // 800 tokens gives deepseek-r1 enough room after its <think> block;
        // llama3.2 and other direct-output models use far less.
        num_predict: 800,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as { response: string };
  // Strip <think>...</think> reasoning blocks emitted by deepseek-r1 and similar
  // chain-of-thought models before the actual output.
  const stripped = data.response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return stripped;
}

// ============================================================================
// Scenario Generator
// ============================================================================

export async function generateScenarios(
  archetype: string,
  model: string,
  sessionCount: number,
): Promise<GeneratedScenario> {
  const ctx = ARCHETYPES[archetype];
  if (!ctx) throw new Error(`Unknown archetype: ${archetype}. Use: ${Object.keys(ARCHETYPES).join(', ')}`);

  const topics = TOPICS[archetype];
  // Pick sessionCount topics, shuffled
  const picked = shuffle(topics).slice(0, sessionCount);

  const sessions: GeneratedSession[] = [];

  for (const topic of picked) {
    const prompt = `You are documenting a ${ctx.stack} project.
Write the markdown content a developer would add to CLAUDE.md to document: ${topic}.
Start with a ## heading. Be specific, realistic, and concise (3-6 items).`;

    process.stdout.write(`  generating: ${topic}... `);
    const inject = await generate(model, prompt);
    process.stdout.write('done\n');

    sessions.push({
      label: `ollama: ${topic}`,
      topic,
      inject,
    });
  }

  return {
    id: `ollama-${archetype}-${Date.now()}`,
    archetype,
    model,
    sessions,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function getArchetypeModules(archetype: string): string[] {
  return ARCHETYPES[archetype]?.modules ?? ['core.adf'];
}

export function getArchetypeManifest(archetype: string): { onDemand: { path: string; triggers: string[] }[] } {
  const manifests: Record<string, { onDemand: { path: string; triggers: string[] }[] }> = {
    worker: {
      onDemand: [
        { path: 'infra.adf', triggers: ['wrangler', 'cloudflare', 'deploy', 'worker', 'kv', 'd1', 'r2', 'binding', 'secret', 'env'] },
        { path: 'backend.adf', triggers: ['api', 'fetch', 'route', 'handler', 'middleware', 'hono', 'request', 'response'] },
      ],
    },
    backend: {
      onDemand: [
        { path: 'backend.adf', triggers: ['api', 'endpoint', 'route', 'handler', 'middleware', 'database', 'sql', 'query', 'prisma', 'postgres', 'migration'] },
        { path: 'security.adf', triggers: ['auth', 'jwt', 'token', 'session', 'password', 'bcrypt', 'secret', 'cors', 'rate', 'limit'] },
        { path: 'infra.adf', triggers: ['deploy', 'docker', 'ci', 'pipeline', 'build', 'env', 'environment'] },
      ],
    },
    fullstack: {
      onDemand: [
        { path: 'frontend.adf', triggers: ['react', 'component', 'css', 'ui', 'tailwind', 'vite', 'tsx', 'client', 'next'] },
        { path: 'backend.adf', triggers: ['api', 'route', 'handler', 'database', 'prisma', 'auth', 'server', 'middleware'] },
        { path: 'infra.adf', triggers: ['deploy', 'vercel', 'ci', 'build', 'pipeline', 'env', 'environment', 'docker'] },
      ],
    },
  };
  return manifests[archetype] ?? { onDemand: [] };
}

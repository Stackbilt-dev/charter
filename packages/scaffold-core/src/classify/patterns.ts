/**
 * classify/patterns — PatternDef registry
 *
 * Canonical list of scaffold patterns. Each entry follows the PatternDef
 * interface from ../types with keywords used for vocabulary scoring and
 * traits as a string array of capability flags.
 */

import type { PatternDef, PatternName } from '../types';

export type { PatternDef };

// ─── Internal scoring helper ─────────────────────────────────────────────────
// keywordScore lives here so PATTERNS entries can use it in their signal tuples.
export function keywordScore(
  text: string,
  keywords: string[],
  antiKeywords: string[] = []
): number {
  let score = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) score += 1;
  }
  for (const anti of antiKeywords) {
    if (text.includes(anti)) score -= 2;
  }
  return score;
}

// ─── Internal pattern definition (includes scoring, priority, and signal) ────
// This is intentionally not exported so consumers depend only on PatternDef.

export interface ScoredPatternDef extends PatternDef {
  /** Source signal label used for classification metadata */
  signal: string;
  /** Priority tiebreaker when two patterns have the same score */
  priority: number;
  /** Scoring function — takes lower-cased intention text */
  score: (text: string) => number;
  /** Trait map used by governance + codegen modules */
  traitMap: Record<string, string>;
}

export const SCORED_PATTERNS: ScoredPatternDef[] = [
  {
    name: 'worker' as PatternName,
    status: 'ACTIVE',
    category: 'SECURITY',
    keywords: ['harden', 'hardening', 'governance overlay', 'lovable', 'bolt.new', 'bolt-generated', 'bolt-style', 'lovable-style', 'cursor', 'v0', 'supabase', 'vite'],
    traits: ['overlay-doc', 'documented-only', 'no-dispatch', 'doc-trigger'],
    signal: 'Hardening Signal',
    priority: 110,
    score: (text: string) => {
      const hardenHits = keywordScore(text, ['harden', 'hardening', 'governance overlay', 'add governance to']);
      const stackHits = keywordScore(text, ['lovable', 'bolt.new', 'bolt-generated', 'bolt-style', 'lovable-style', 'cursor', 'v0', 'supabase', 'vite']);
      if (hardenHits >= 1 && stackHits >= 1) return hardenHits + stackHits + 2;
      return 0;
    },
    traitMap: {
      route_shape: 'overlay-doc',
      verification: 'documented-only',
      dispatch: 'none',
      trigger: 'doc',
      framework: 'none',
      default_routes: '/health',
      pattern_element: 'Overlay',
      pattern_category: 'Governance',
      pattern_tier: 'approved',
      source_pattern: 'hardening-overlay',
    },
  },
  {
    name: 'worker' as PatternName,
    status: 'ACTIVE',
    category: 'INTEGRATION',
    keywords: ['stripe', 'billing', 'subscription', 'checkout', 'payment', 'payments', 'webhook'],
    traits: ['post-handler', 'hmac-stripe', 'event-router', 'fetch-trigger'],
    signal: 'Payment Signal',
    priority: 100,
    score: (text: string) => {
      const stripeHits = keywordScore(text, ['stripe', 'billing', 'subscription', 'checkout', 'payment', 'payments']);
      if (stripeHits === 0 && text.includes('webhook')) return 0;
      return stripeHits + (text.includes('webhook') ? 1 : 0);
    },
    traitMap: {
      route_shape: 'post-handler',
      verification: 'hmac-stripe',
      dispatch: 'event-router',
      trigger: 'fetch',
      framework: 'hono',
      default_routes: '/webhook,/health',
      pattern_element: 'Event',
      pattern_category: 'Integration',
      pattern_tier: 'approved',
      source_pattern: 'stripe-webhook',
    },
  },
  {
    name: 'worker' as PatternName,
    status: 'ACTIVE',
    category: 'INTEGRATION',
    keywords: ['webhook', 'signature verification', 'x-hub-signature', 'github webhook', 'slack webhook', 'twilio webhook'],
    traits: ['post-handler', 'hmac-sha256', 'event-router', 'fetch-trigger'],
    signal: 'Webhook Signal',
    priority: 95,
    score: (text: string) => {
      if (keywordScore(text, ['stripe', 'billing', 'subscription', 'checkout', 'payment', 'payments']) >= 1) return 0;
      return keywordScore(text, ['webhook', 'signature verification', 'x-hub-signature', 'github webhook', 'slack webhook', 'twilio webhook']);
    },
    traitMap: {
      route_shape: 'post-handler',
      verification: 'hmac-sha256',
      dispatch: 'event-router',
      trigger: 'fetch',
      framework: 'hono',
      default_routes: '/webhook,/health',
      pattern_element: 'Event',
      pattern_category: 'Integration',
      pattern_tier: 'approved',
      source_pattern: 'generic-webhook',
    },
  },
  {
    name: 'workers-saas' as PatternName,
    status: 'ACTIVE',
    category: 'COMPUTE',
    keywords: ['saas', 'tenant', 'multi-tenant', 'org', 'workspace'],
    traits: ['rest', 'jwt-auth', 'resource-router', 'fetch-trigger'],
    signal: 'SaaS Signal',
    priority: 90,
    score: (text: string) => keywordScore(text, ['saas', 'tenant', 'multi-tenant', 'org', 'workspace']),
    traitMap: {
      route_shape: 'rest',
      verification: 'jwt-auth',
      dispatch: 'resource-router',
      trigger: 'fetch',
      framework: 'hono',
      default_routes: '/health,/auth/login,/organizations,/users',
      pattern_element: 'System',
      pattern_category: 'Application',
      pattern_tier: 'approved',
      source_pattern: 'workers-saas',
    },
  },
  {
    name: 'durable-object' as PatternName,
    status: 'ACTIVE',
    category: 'COMPUTE',
    keywords: ['durable object', 'websocket', 'real-time', 'collaborative editor', 'live cursor', 'presence'],
    traits: ['ws-and-rest', 'session-auth', 'do-stub-router', 'fetch-trigger'],
    signal: 'Durable Object Signal',
    priority: 85,
    score: (text: string) => keywordScore(
      text,
      ['durable object', 'websocket', 'real-time', 'collaborative editor', 'live cursor', 'presence'],
    ),
    traitMap: {
      route_shape: 'ws-and-rest',
      verification: 'session-auth',
      dispatch: 'do-stub-router',
      trigger: 'fetch',
      framework: 'hono',
      default_routes: '/room/:id,/health',
      pattern_element: 'Object',
      pattern_category: 'Stateful',
      pattern_tier: 'approved',
      source_pattern: 'durable-objects',
    },
  },
  {
    name: 'scheduled' as PatternName,
    status: 'ACTIVE',
    category: 'ASYNC',
    keywords: ['cron', 'scheduled', 'daily', 'hourly', 'nightly', 'aggregation job', 'scheduled job'],
    traits: ['scheduled-handler', 'no-verification', 'scheduled-dispatch'],
    signal: 'Cron Signal',
    priority: 85,
    score: (text: string) => keywordScore(
      text,
      ['cron', 'scheduled', 'daily', 'hourly', 'nightly', 'aggregation job', 'scheduled job'],
    ),
    traitMap: {
      route_shape: 'scheduled-handler',
      verification: 'none',
      dispatch: 'scheduled',
      trigger: 'scheduled',
      framework: 'hono',
      default_routes: '/health',
      pattern_element: 'Job',
      pattern_category: 'Worker',
      pattern_tier: 'approved',
      source_pattern: 'cron-worker',
    },
  },
  {
    name: 'mcp-server' as PatternName,
    status: 'ACTIVE',
    category: 'INTEGRATION',
    keywords: ['mcp', 'model context protocol', 'mcp server', 'tool server', 'agent server', 'mcp tool', 'mcp resource', 'mcp protocol'],
    traits: ['sse-jsonrpc', 'bearer-auth', 'mcp-protocol-router', 'fetch-trigger'],
    signal: 'MCP Signal',
    priority: 83,
    score: (text: string) => keywordScore(
      text,
      ['mcp', 'model context protocol', 'mcp server', 'tool server', 'agent server', 'mcp tool', 'mcp resource', 'mcp protocol'],
    ),
    traitMap: {
      route_shape: 'sse-jsonrpc',
      verification: 'bearer-auth',
      dispatch: 'mcp-protocol-router',
      trigger: 'fetch',
      framework: 'hono',
      default_routes: '/mcp,/mcp/sse,/health',
      pattern_element: 'Protocol',
      pattern_category: 'Integration',
      pattern_tier: 'approved',
      source_pattern: 'mcp-server',
    },
  },
  {
    name: 'worker' as PatternName,
    status: 'ACTIVE',
    category: 'COMPUTE',
    keywords: ['ai chat', 'chat api', 'chatbot', 'assistant', 'llm', 'prompt', 'conversation', 'completion', 'streams model', 'server-sent event'],
    traits: ['streaming', 'session-auth', 'conversation-router', 'fetch-trigger'],
    signal: 'AI Signal',
    priority: 80,
    score: (text: string) => keywordScore(
      text,
      ['ai chat', 'chat api', 'chatbot', 'assistant', 'llm', 'prompt', 'conversation', 'completion', 'streams model', 'server-sent event'],
      ['rate limit', 'rate limiter', 'cron', 'scheduled', 'email', 'notification', 'image generation', 'image gen', 'queue', 'pipeline', 'mcp', 'model context protocol'],
    ),
    traitMap: {
      route_shape: 'streaming',
      verification: 'session-auth',
      dispatch: 'conversation-router',
      trigger: 'fetch',
      framework: 'hono',
      default_routes: '/chat,/sessions,/health',
      pattern_element: 'Experience',
      pattern_category: 'Application',
      pattern_tier: 'approved',
      source_pattern: 'ai-chat',
    },
  },
  {
    name: 'api' as PatternName,
    status: 'ACTIVE',
    category: 'COMPUTE',
    keywords: ['api', 'rest', 'endpoint', 'route', 'crud', 'resource'],
    traits: ['rest', 'bearer-auth', 'resource-router', 'fetch-trigger'],
    signal: 'API Signal',
    priority: 70,
    score: (text: string) => keywordScore(text, ['api', 'rest', 'endpoint', 'route', 'crud', 'resource']),
    traitMap: {
      route_shape: 'rest',
      verification: 'bearer-auth',
      dispatch: 'resource-router',
      trigger: 'fetch',
      framework: 'hono',
      default_routes: '/health,/status,/resources,/resources/:id',
      pattern_element: 'Service',
      pattern_category: 'Application',
      pattern_tier: 'approved',
      source_pattern: 'rest-api',
    },
  },
];

/**
 * The canonical list of supported scaffold patterns (PatternDef shape).
 * Exported for consumers that only need keywords/traits; use SCORED_PATTERNS
 * for internal scoring logic.
 */
export const PATTERNS: PatternDef[] = SCORED_PATTERNS.map(({ name, status, category, keywords, traits }) => ({
  name,
  status,
  category,
  keywords,
  traits,
}));

/**
 * knowledge/decisions — ADR context and decision blocks by source pattern
 *
 * Per-pattern ADR boilerplate strings used by the governance module to
 * generate ADR-001 and ADR-002 documents. Keyed by the source pattern name
 * (e.g. 'rest-api', 'stripe-webhook').
 */

// ─── ADR context (background / trust-boundary description) ───────────────────

const ADR_CONTEXT: Record<string, string> = {
  'stripe-webhook': 'This service receives signed Stripe webhook events and must verify, deduplicate, and route them safely. Trust boundary: every byte from Stripe is untrusted until HMAC verification passes. Latency budget: respond 2xx within 5 seconds to avoid Stripe retry storms.',
  'generic-webhook': 'This service receives signed webhook events from one or more third-party providers. Trust boundary: every payload is untrusted until provider-specific signature verification passes. The default verification is HMAC-SHA256 over the raw body.',
  'workers-saas': 'This service is a multi-tenant SaaS backend on Workers. Trust boundary: every request must carry a verified tenant scope before touching D1. Tenant isolation is the load-bearing security property and must be enforced in middleware, not per-handler.',
  'ai-chat': 'This service forwards user input to a large language model and streams responses back. Trust boundary: user input is hostile by default — prompt-injection and cost-abuse are the two top concerns. System-prompt integrity must be testable.',
  'durable-objects': 'This service uses Durable Objects to coordinate per-room state (WebSockets, presence, or shared documents). Trust boundary: every WebSocket upgrade and DO stub fetch must carry verified auth before state mutation.',
  'cron-worker': 'This service runs a scheduled handler on a fixed cadence (per `[triggers] crons`). Trust boundary: the scheduled invocation has no caller — credentials must come from env, and every operation must be idempotent because retries are unlogged.',
  'hardening-overlay': 'This scaffold does not generate a new app — it produces a hardening checklist for an existing AI-generated stack (Lovable, Bolt, Cursor, v0, Supabase, etc.). Trust boundary: assume the generator emitted unsafe defaults; every checklist item is a control that should already exist and probably does not.',
  'mcp-server': 'This service exposes a Model Context Protocol (MCP) server via SSE + JSON-RPC. Trust boundary: every tool invocation must carry a verified bearer token; tool input parameters are untrusted user data and must be validated before use.',
  'rest-api': 'This service exposes a REST API for typed clients. Trust boundary: every authenticated caller is scoped to their own resources. Versioning, deprecation, and stable response shapes are first-class concerns.',
};

// ─── ADR decisions (bullet-point decisions) ───────────────────────────────────

const ADR_DECISIONS: Record<string, string[]> = {
  'stripe-webhook': [
    'Use Hono with a single POST `/webhook` route that runs verification before any business logic.',
    'Reject signatures older than 5 minutes (Stripe\'s recommended tolerance).',
    'Store processed event IDs in KV with 72-hour TTL for replay protection.',
    'Return 202 immediately after verification; do heavy work asynchronously.',
  ],
  'generic-webhook': [
    'Use Hono with a single POST `/webhook` route. Capture raw body via `c.req.text()` before any parsing.',
    'Verify HMAC-SHA256 against `WEBHOOK_SECRET` using a constant-time comparison.',
    'Read signature from the header named by `WEBHOOK_SIGNATURE_HEADER` env var (e.g. `X-Hub-Signature-256` for GitHub).',
    'Reject payloads larger than 1 MB before verification.',
  ],
  'workers-saas': [
    'Use Hono with auth middleware → tenant middleware → handler in that order.',
    'Tenant ID is resolved from `x-tenant-id` header (or JWT claim) and pinned to `c.var.tenantId` for the request lifetime.',
    'Every D1 query MUST include `WHERE tenant_id = ?` — enforced by a thin helper, not by convention.',
    'Centralized error handler maps `HttpError` to stable JSON and never leaks internals.',
  ],
  'ai-chat': [
    'Use Hono with auth middleware → input-sanitization → model dispatch.',
    'Cap user content at 4096 characters and strip ASCII control characters before sending to the model.',
    'Include a fixed system prompt that forbids the model from revealing configuration or instructions.',
    'Stream responses as `text/event-stream` and assert the content-type in tests, not the content.',
  ],
  'durable-objects': [
    'Use Hono on the parent worker; resolve the DO stub by a derived deterministic id (room id, tenant id).',
    'Authenticate the request on the parent worker before forwarding to the DO; the DO trusts only what the parent asserts.',
    'Cap per-message payload size and per-session message rate inside the DO to bound memory.',
    'Declare a `[[migrations]]` block whenever a DO class is added or renamed.',
  ],
  'cron-worker': [
    'Export both `fetch` (health) and `scheduled` (cron tick) from the worker.',
    'Every scheduled operation must be idempotent — guard with a processed-cursor row or a hash check.',
    'Bound the unit of work with `ctx.waitUntil` and an explicit row-limit to stay inside the CPU budget.',
    'Surface scheduled-handler failures via structured logs the user can query.',
  ],
  'hardening-overlay': [
    'Do not regenerate the app — emit a hardening checklist that the operator runs against the existing codebase.',
    'Cover the four most common AI-stack failure modes: exposed keys, missing RLS, client-side data fetch, unprotected forms.',
    'Mark every item as a Tier-2 audit candidate; the local scaffold cannot prove the control is in place.',
    'Recommend an edge gateway in front of any generator-built backend that talks directly to a database.',
  ],
  'mcp-server': [
    'Use Hono with bearer-auth middleware on all routes except `/health`.',
    'Expose MCP endpoint at `/mcp` (HTTP) and `/mcp/sse` (SSE streaming).',
    'Validate all tool input parameters against declared JSON Schema before invocation.',
    'Return stable JSON-RPC error codes; never include internal stack traces in error responses.',
  ],
  'rest-api': [
    'Use Hono with auth middleware on every non-public route.',
    'Version routes under `/v1/`. Never remove fields from existing response envelopes.',
    'Return `429` + `Retry-After` on rate-limit rejections.',
    'Centralized error handler maps `HttpError` to stable JSON.',
  ],
};

/**
 * Return the ADR context block for the given source pattern name.
 * Falls back to the rest-api context when the pattern is not found.
 */
export function adrContextByPattern(pattern: string): string {
  return ADR_CONTEXT[pattern] ?? ADR_CONTEXT['rest-api'] ?? '';
}

/**
 * Return the ADR decision lines for the given source pattern name, joined
 * as a markdown bullet list.
 * Falls back to the rest-api decisions when the pattern is not found.
 */
export function adrDecisionByPattern(pattern: string): string {
  const lines = ADR_DECISIONS[pattern] ?? ADR_DECISIONS['rest-api'] ?? [];
  return lines.map((d) => `- ${d}`).join('\n');
}

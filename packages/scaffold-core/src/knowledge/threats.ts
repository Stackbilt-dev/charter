/**
 * knowledge/threats — pattern-specific and domain threat catalogs
 *
 * All threat data extracted from the scaffold-core source. Each entry follows
 * the ThreatEntry interface from ../types.
 */

import type { ThreatEntry } from '../types';

// ─── Pattern-specific threats ─────────────────────────────────────────────────

const PATTERN_THREATS: Record<string, ThreatEntry[]> = {
  'stripe-webhook': [
    {
      id: 'T-001',
      category: 'Authentication',
      description: 'Webhook signature bypass',
      mitigation: 'Verify HMAC-SHA256 signature before any business logic; reject on mismatch or stale timestamp (> 5 min).',
      severity: 'CRITICAL',
    },
    {
      id: 'T-002',
      category: 'Integrity',
      description: 'Replay and duplicate event processing',
      mitigation: 'Store processed event IDs in KV with 72-hour TTL for replay protection.',
      severity: 'HIGH',
    },
    {
      id: 'T-003',
      category: 'Data',
      description: 'Excessive data exposure from unscoped responses',
      mitigation: 'Return only the fields required by the webhook handler response.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-004',
      category: 'Integrity',
      description: 'Timestamp tolerance window too wide (replay outside Stripe\'s 5-min recommendation)',
      mitigation: 'Reject signatures with timestamp older than 5 minutes.',
      severity: 'HIGH',
    },
    {
      id: 'T-005',
      category: 'Integrity',
      description: 'Idempotency-key collision across event types',
      mitigation: 'Namespace idempotency keys by event type.',
      severity: 'HIGH',
    },
    {
      id: 'T-006',
      category: 'Reliability',
      description: 'Background-task failure leaves event partially processed',
      mitigation: 'Use idempotent handlers; return 202 after signature check, process async.',
      severity: 'HIGH',
    },
    {
      id: 'T-007',
      category: 'Secrets',
      description: 'STRIPE_WEBHOOK_SECRET leaked in logs or source',
      mitigation: 'Store only in env vars; never log or expose in error responses.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-008',
      category: 'Availability',
      description: 'Webhook endpoint enumerated and probed without rate limit',
      mitigation: 'Add KV-backed rate limiting on the webhook route.',
      severity: 'MEDIUM',
    },
  ],
  'generic-webhook': [
    {
      id: 'T-001',
      category: 'Authentication',
      description: 'Forged webhook payload via missing or weak HMAC verification',
      mitigation: 'Implement HMAC-SHA256 verification over the raw request body.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-002',
      category: 'Authentication',
      description: 'Authentication bypass on protected routes',
      mitigation: 'Require verified signature before processing any payload.',
      severity: 'HIGH',
    },
    {
      id: 'T-003',
      category: 'Data',
      description: 'Excessive data exposure from unscoped responses',
      mitigation: 'Return only the fields required by the webhook handler response.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-004',
      category: 'Authentication',
      description: 'Provider-specific header parsing error treated as auth-pass',
      mitigation: 'Treat any parse failure as a verification failure; default to reject.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-005',
      category: 'Integrity',
      description: 'Raw-body capture happens after JSON parse (signature mismatch)',
      mitigation: 'Capture raw body via c.req.text() before any parsing.',
      severity: 'HIGH',
    },
    {
      id: 'T-006',
      category: 'Availability',
      description: 'Payload size unbounded — memory pressure on large posts',
      mitigation: 'Reject payloads larger than 1 MB before verification.',
      severity: 'HIGH',
    },
    {
      id: 'T-007',
      category: 'Secrets',
      description: 'WEBHOOK_SECRET leaked in logs or source',
      mitigation: 'Store only in env vars; never log or expose in error responses.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-008',
      category: 'Integrity',
      description: 'Missing replay protection when provider supplies timestamp',
      mitigation: 'Reject payloads older than 5 minutes when timestamp header is present.',
      severity: 'MEDIUM',
    },
  ],
  'workers-saas': [
    {
      id: 'T-001',
      category: 'Authorization',
      description: 'Tenant boundary bypass',
      mitigation: 'Enforce tenant scope in middleware before any handler logic.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-002',
      category: 'Authentication',
      description: 'Authentication bypass on protected routes',
      mitigation: 'Apply auth middleware before tenant middleware before handlers.',
      severity: 'HIGH',
    },
    {
      id: 'T-003',
      category: 'Data',
      description: 'Cross-tenant data leakage',
      mitigation: 'Include tenant_id in every D1 query; enforce via helper, not convention.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-004',
      category: 'Authorization',
      description: 'Tenant ID forged via header injection past trim/validation',
      mitigation: 'Trim and validate tenant ID before pinning to request context.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-005',
      category: 'Data',
      description: 'D1 query construction without tenant_id WHERE clause',
      mitigation: 'Use a thin query helper that enforces the tenant_id parameter.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-006',
      category: 'Authorization',
      description: 'Org admin escalation via missing role check on /users mutations',
      mitigation: 'Require explicit role check before any user management mutations.',
      severity: 'HIGH',
    },
    {
      id: 'T-007',
      category: 'Authentication',
      description: 'JWT secret rotation without grace window (mass logout)',
      mitigation: 'Support dual-key rotation with a grace window before invalidating old tokens.',
      severity: 'MEDIUM',
    },
    {
      id: 'T-008',
      category: 'Audit',
      description: 'Audit trail missing tenant_id, blocks per-tenant forensics',
      mitigation: 'Include tenant_id in all audit log entries.',
      severity: 'HIGH',
    },
  ],
  'ai-chat': [
    {
      id: 'T-001',
      category: 'Integrity',
      description: 'Prompt injection and data exfiltration',
      mitigation: 'Strip control characters; include a system prompt that forbids config disclosure.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-002',
      category: 'Availability',
      description: 'Per-user token budget unbounded — runaway cost',
      mitigation: 'Enforce per-user token budget via KV-backed rate limiting.',
      severity: 'HIGH',
    },
    {
      id: 'T-003',
      category: 'Data',
      description: 'Excessive data exposure from unscoped responses',
      mitigation: 'Never include system prompt or configuration in streamed responses.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-004',
      category: 'Integrity',
      description: 'System-prompt leak via direct-quote prompt-injection',
      mitigation: 'Assert system prompt integrity with test; instruct model not to reveal instructions.',
      severity: 'HIGH',
    },
    {
      id: 'T-005',
      category: 'Availability',
      description: 'Per-user token budget unbounded — runaway cost',
      mitigation: 'Add KV-backed per-session token counter; return 429 when exceeded.',
      severity: 'HIGH',
    },
    {
      id: 'T-006',
      category: 'Data',
      description: 'Streaming response cancellation leaks partial sensitive data',
      mitigation: 'Validate that partial stream flushes do not include system state.',
      severity: 'MEDIUM',
    },
    {
      id: 'T-007',
      category: 'Secrets',
      description: 'Provider API key exposed in client-bundled config',
      mitigation: 'Use native AI binding (no key required at edge) or server-side env only.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-008',
      category: 'Data',
      description: 'Conversation history persisted without PII redaction',
      mitigation: 'Apply PII redaction before storing conversation history.',
      severity: 'HIGH',
    },
  ],
  'durable-objects': [
    {
      id: 'T-001',
      category: 'Data',
      description: 'Cross-room state leakage via DO routing or shared in-memory sessions',
      mitigation: 'Derive DO IDs deterministically from tenant-scoped strings.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-002',
      category: 'Authentication',
      description: 'Authentication bypass on protected routes',
      mitigation: 'Authenticate on the parent worker before forwarding to the DO.',
      severity: 'HIGH',
    },
    {
      id: 'T-003',
      category: 'Data',
      description: 'Excessive data exposure from unscoped responses',
      mitigation: 'Scope all DO storage reads to the authenticated session.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-004',
      category: 'Data',
      description: 'DO ID derivation collision routes two tenants to the same instance',
      mitigation: 'Include tenant ID in the DO name input; use idFromName with full scope.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-005',
      category: 'Authentication',
      description: 'WebSocket upgrade accepted without auth on the parent fetch',
      mitigation: 'Verify auth on the parent worker before issuing DO stub fetch.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-006',
      category: 'Availability',
      description: 'Per-room broadcast lacks message-size and rate caps',
      mitigation: 'Enforce 16 KB message-size cap and 10 messages/sec rate cap inside the DO.',
      severity: 'HIGH',
    },
    {
      id: 'T-007',
      category: 'Data',
      description: 'DO storage carries PII without expiry policy',
      mitigation: 'Apply TTL on DO storage entries that contain personal data.',
      severity: 'HIGH',
    },
    {
      id: 'T-008',
      category: 'Reliability',
      description: 'Missing migration block on class rename causes silent state loss',
      mitigation: 'Declare [[migrations]] block with new_classes on every DO class addition or rename.',
      severity: 'HIGH',
    },
  ],
  'cron-worker': [
    {
      id: 'T-001',
      category: 'Reliability',
      description: 'Unbounded scheduled work consuming CPU/IO budget',
      mitigation: 'Wrap work in ctx.waitUntil with a row-limit constant.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-002',
      category: 'Authentication',
      description: 'Authentication bypass on protected routes',
      mitigation: 'Credentials come from env only; expose no caller-accessible auth surface.',
      severity: 'HIGH',
    },
    {
      id: 'T-003',
      category: 'Data',
      description: 'Excessive data exposure from unscoped responses',
      mitigation: 'Health route exposes only last-tick timestamp, not job state.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-004',
      category: 'Reliability',
      description: 'Scheduled handler is not idempotent — duplicate firing corrupts state',
      mitigation: 'Guard each operation with a processed-cursor or hash check.',
      severity: 'HIGH',
    },
    {
      id: 'T-005',
      category: 'Availability',
      description: 'Unbounded query scan exceeds CPU budget and silently truncates work',
      mitigation: 'Apply a row-limit constant to all scheduled queries.',
      severity: 'HIGH',
    },
    {
      id: 'T-006',
      category: 'Secrets',
      description: 'Cron-only credentials accidentally exposed via fetch handler',
      mitigation: 'Remove or block all fetch routes that could expose scheduled-job env vars.',
      severity: 'HIGH',
    },
    {
      id: 'T-007',
      category: 'Observability',
      description: 'Scheduled job failures not surfaced in user-visible telemetry',
      mitigation: 'Emit a structured cron_error log line on every handler failure.',
      severity: 'MEDIUM',
    },
    {
      id: 'T-008',
      category: 'Reliability',
      description: 'No backfill strategy when scheduler is paused/redeployed',
      mitigation: 'Use a processed-cursor; catch-up is automatic on next tick.',
      severity: 'MEDIUM',
    },
  ],
  'hardening-overlay': [
    {
      id: 'T-001',
      category: 'Secrets',
      description: 'Inherited AI-generated insecure defaults (exposed keys, missing auth, naive client-side fetch)',
      mitigation: 'Audit all generator-emitted env references; move secrets to Worker env vars.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-002',
      category: 'Authentication',
      description: 'Authentication bypass on protected routes',
      mitigation: 'Add auth middleware to all non-public routes the generator created.',
      severity: 'HIGH',
    },
    {
      id: 'T-003',
      category: 'Data',
      description: 'Excessive data exposure from unscoped responses',
      mitigation: 'Review all generator-created response shapes; remove internal fields.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-004',
      category: 'Secrets',
      description: 'Generator-leaked public anon key with row-level security disabled',
      mitigation: 'Enable RLS on all Supabase/generator tables; rotate the anon key.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-005',
      category: 'Architecture',
      description: 'Client-side fetch directly to database with no edge gateway',
      mitigation: 'Place a Worker in front of the database; client talks only to the Worker.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-006',
      category: 'Secrets',
      description: '.env committed to repo with provider secrets',
      mitigation: 'Rotate all committed secrets; add .env to .gitignore.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-007',
      category: 'Integrity',
      description: 'CSRF unprotected on generator-scaffolded form posts',
      mitigation: 'Add CSRF token or SameSite=Strict cookie on all form routes.',
      severity: 'HIGH',
    },
    {
      id: 'T-008',
      category: 'Availability',
      description: 'Missing rate-limit / abuse controls on public AI endpoints',
      mitigation: 'Add KV-backed rate limiting before all AI-facing routes.',
      severity: 'HIGH',
    },
  ],
  'rest-api': [
    {
      id: 'T-001',
      category: 'Authorization',
      description: 'Broken object level authorization',
      mitigation: 'Validate caller owns the resource before any read or mutation.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-002',
      category: 'Authentication',
      description: 'Authentication bypass on protected routes',
      mitigation: 'Apply auth middleware to every non-public route.',
      severity: 'HIGH',
    },
    {
      id: 'T-003',
      category: 'Data',
      description: 'Excessive data exposure from unscoped responses',
      mitigation: 'Return only the fields required by the client; never proxy raw DB rows.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-004',
      category: 'Data',
      description: 'Mass-assignment via unfiltered JSON body on update routes',
      mitigation: 'Validate and whitelist all accepted body fields with a schema.',
      severity: 'HIGH',
    },
    {
      id: 'T-005',
      category: 'Authorization',
      description: 'IDOR via predictable resource IDs in path parameters',
      mitigation: 'Verify caller owns the resource ID on every handler.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-006',
      category: 'Information',
      description: 'Verbose error responses leak stack traces or query shapes',
      mitigation: 'Centralized error handler maps all errors to stable JSON; never expose internals.',
      severity: 'HIGH',
    },
    {
      id: 'T-007',
      category: 'Secrets',
      description: 'Bearer-token rotation requires app redeploy',
      mitigation: 'Store token in env var; support rolling rotation without redeployment.',
      severity: 'MEDIUM',
    },
    {
      id: 'T-008',
      category: 'Availability',
      description: 'Missing 429 + Retry-After on rate-limit rejection',
      mitigation: 'Return 429 with Retry-After header on rate-limit rejection.',
      severity: 'MEDIUM',
    },
  ],
  'mcp-server': [
    {
      id: 'T-001',
      category: 'Authorization',
      description: 'Broken object level authorization',
      mitigation: 'Validate caller owns the resource before any tool invocation.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-002',
      category: 'Authentication',
      description: 'Authentication bypass on protected routes',
      mitigation: 'Apply bearer-auth middleware before all MCP tool routes.',
      severity: 'HIGH',
    },
    {
      id: 'T-003',
      category: 'Data',
      description: 'Excessive data exposure from unscoped responses',
      mitigation: 'Return only the fields required by the MCP client.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-004',
      category: 'Integrity',
      description: 'Tool invocation without input validation allows injection',
      mitigation: 'Validate all tool input parameters against declared JSON Schema.',
      severity: 'HIGH',
    },
    {
      id: 'T-005',
      category: 'Availability',
      description: 'Unbounded tool execution time exhausts Worker CPU budget',
      mitigation: 'Bound each tool handler with a timeout and return error on exceed.',
      severity: 'HIGH',
    },
    {
      id: 'T-006',
      category: 'Information',
      description: 'Verbose JSON-RPC errors leak internal implementation details',
      mitigation: 'Centralized error handler returns stable JSON-RPC error codes only.',
      severity: 'HIGH',
    },
    {
      id: 'T-007',
      category: 'Secrets',
      description: 'Bearer token leaked in SSE stream or error response',
      mitigation: 'Never include auth material in SSE event data or error bodies.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-008',
      category: 'Availability',
      description: 'SSE connection held open without keep-alive or timeout',
      mitigation: 'Apply SSE connection timeout; send periodic keep-alive comments.',
      severity: 'MEDIUM',
    },
  ],
};

/**
 * Retrieve pattern-specific threat entries for the given source pattern name.
 *
 * Falls back to the rest-api threat catalog when the pattern is not found.
 */
export function patternSpecificThreats(pattern: string): ThreatEntry[] {
  return PATTERN_THREATS[pattern] ?? PATTERN_THREATS['rest-api'] ?? [];
}

// ─── Domain threats ───────────────────────────────────────────────────────────

const DOMAIN_THREAT_MAP: Record<string, ThreatEntry[]> = {
  PHI: [
    {
      id: 'T-D1',
      category: 'Compliance',
      description: 'PHI stored or logged without encryption at rest',
      mitigation: 'Enable D1 encryption at rest; never log PHI fields.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-D2',
      category: 'Compliance',
      description: 'HIPAA minimum-necessary rule violated — full record returned when subset sufficient',
      mitigation: 'Return only the minimum fields required for each use case.',
      severity: 'HIGH',
    },
    {
      id: 'T-D3',
      category: 'Authorization',
      description: 'Patient data accessible without patient-scoped auth (missing row-level isolation)',
      mitigation: 'Enforce patient_id scoping on every data access; test cross-patient isolation.',
      severity: 'CRITICAL',
    },
  ],
  PCI: [
    {
      id: 'T-D1',
      category: 'Compliance',
      description: 'PAN stored or logged without tokenization — expands PCI-DSS scope',
      mitigation: 'Never store or log PANs; use Stripe/payment-provider tokenization.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-D2',
      category: 'Data',
      description: 'Cardholder data returned beyond the minimum necessary fields',
      mitigation: 'Return only the last-4 and expiry from the payment provider token.',
      severity: 'HIGH',
    },
    {
      id: 'T-D3',
      category: 'Compliance',
      description: 'Raw card data present in server-side logs or error responses',
      mitigation: 'Add log-scrubbing middleware that redacts card-like patterns.',
      severity: 'CRITICAL',
    },
  ],
  PII: [
    {
      id: 'T-D1',
      category: 'Data',
      description: 'Personal data returned in bulk without field-level access control',
      mitigation: 'Apply field-level access control; never return PII in list endpoints.',
      severity: 'HIGH',
    },
    {
      id: 'T-D2',
      category: 'Compliance',
      description: 'PII retained beyond stated retention period — deletion not enforced',
      mitigation: 'Implement TTL-based deletion for PII fields; test the purge path.',
      severity: 'HIGH',
    },
    {
      id: 'T-D3',
      category: 'Compliance',
      description: 'Data breach triggers notification obligation; no breach-detection pipeline present',
      mitigation: 'Instrument 4xx/5xx anomalies and unusual bulk-read patterns.',
      severity: 'HIGH',
    },
  ],
  telephony: [
    {
      id: 'T-T1',
      category: 'Authentication',
      description: 'Twilio webhook signature not verified — spoofed call/SMS events accepted',
      mitigation: 'Verify Twilio webhook signature using the Twilio Auth Token before processing.',
      severity: 'CRITICAL',
    },
    {
      id: 'T-T2',
      category: 'Data',
      description: 'Call recordings stored without access control or expiry',
      mitigation: 'Apply R2 signed URLs for recording access; enforce a retention TTL.',
      severity: 'HIGH',
    },
  ],
};

/**
 * Retrieve domain-level threat entries for the given compliance domains.
 */
export function domainThreats(
  domains: Array<'PHI' | 'PCI' | 'PII' | 'telephony'>
): ThreatEntry[] {
  const result: ThreatEntry[] = [];
  for (const domain of domains) {
    const entries = DOMAIN_THREAT_MAP[domain];
    if (entries) result.push(...entries);
  }
  return result;
}

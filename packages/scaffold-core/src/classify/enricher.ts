/**
 * classify/enricher — extractEnrichedPrd + injectPrdSections
 *
 * Expands a raw intention string into an enriched PRD fragment by detecting
 * stack technology tokens and domain entity nouns.
 */

// Stopwords filtered out during entity extraction — infra and generic terms
const INFRA_STOPWORDS = new Set([
  'build', 'create', 'make', 'write', 'generate', 'implement', 'add', 'develop', 'design',
  'a', 'an', 'the', 'that', 'this', 'with', 'for', 'and', 'or', 'but', 'to', 'in', 'on',
  'by', 'from', 'as', 'of', 'at', 'my', 'our', 'your', 'we', 'i', 'it', 'is', 'be', 'are',
  'api', 'rest', 'endpoint', 'route', 'service', 'server', 'app', 'application', 'system',
  'platform', 'worker', 'workers', 'cloudflare', 'hono', 'typescript', 'javascript',
  'd1', 'r2', 'kv', 'do', 'durable', 'wrangler', 'edge', 'deploy', 'production',
  'simple', 'basic', 'full', 'complete', 'using', 'based', 'powered', 'backed',
  'data', 'database', 'storage', 'backend', 'frontend', 'fullstack', 'web',
  'new', 'existing', 'modern', 'scalable', 'secure', 'fast', 'lightweight',
  'support', 'handle', 'manage', 'track', 'process', 'allow', 'enable', 'provide',
  'management', 'tracking', 'tool', 'solution', 'engine', 'module', 'component',
  'feature', 'functionality', 'integration', 'automation', 'workflow',
]);

/**
 * Stack technology tokens — each entry maps a pattern to a label.
 * Exported as an array of labels for consumers that only need the list of
 * detectable technologies (e.g., tests, documentation).
 */
export const STACK_TOKENS: string[] = [
  'D1', 'R2', 'KV', 'Workers AI', 'Queue', 'Stripe', 'Resend', 'Twilio', 'Astro', 'React',
];

/** Internal structured token definitions used by extractEnrichedPrd. */
const STACK_TOKEN_DEFS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bD1\b/, label: 'D1' },
  { pattern: /\bR2\b/, label: 'R2' },
  { pattern: /\bKV\b/, label: 'KV' },
  { pattern: /\bworkers?\s*ai\b|\bworkers-ai\b|\btxt2img\b|\btext[- ]to[- ]image\b|\bimage[\s-]gen(?:eration)?\b|\bstable[\s-]diffusion\b/i, label: 'Workers AI' },
  { pattern: /\bqueues?\b/i, label: 'Queue' },
  { pattern: /\bstripe\b/i, label: 'Stripe' },
  { pattern: /\bresend\b/i, label: 'Resend' },
  { pattern: /\btwilio\b/i, label: 'Twilio' },
  { pattern: /\bastro\b/i, label: 'Astro' },
  { pattern: /\breact\b/i, label: 'React' },
];

/**
 * Domain entity noun matchers — these become D1 tables and contract schemas.
 * Exported for tests and tooling that inspect detection coverage.
 */
export const DOMAIN_ENTITY_PATTERNS: RegExp[] = [
  /\b(podcast|episode|subscription|subscriber|feed|channel|playlist|show|series)\b/gi,
  /\b(invoice|payment|transaction|charge|refund|payout|receipt|billing|bill)\b/gi,
  /\b(product|item|sku|listing|catalog|inventory|variant|category)\b/gi,
  /\b(order|cart|checkout|shipment|delivery|fulfillment|return)\b/gi,
  /\b(booking|appointment|reservation|slot|schedule|availability)\b/gi,
  /\b(ticket|issue|bug|feature|request|comment|attachment)\b/gi,
  /\b(event|attendee|venue|session|speaker|registration)\b/gi,
  /\b(post|article|comment|thread|reply|reaction|like|vote)\b/gi,
  /\b(task|todo|project|milestone|sprint|board|column|card)\b/gi,
  /\b(lead|contact|deal|pipeline|opportunity|account|campaign)\b/gi,
  /\b(report|metric|dashboard|stat|chart|analytic)\b/gi,
  /\b(notification|alert|reminder|message|inbox|conversation)\b/gi,
  /\b(document|file|asset|attachment|upload|media|image|video)\b/gi,
  /\b(recipe|ingredient|meal|menu|nutrition|diet|food)\b/gi,
  /\b(property|listing|unit|tenant|lease|landlord|amenity)\b/gi,
  /\b(course|lesson|module|quiz|student|enrollment|certificate)\b/gi,
  /\b(review|rating|feedback|survey|response|submission)\b/gi,
  /\b(member|membership|plan|tier|credit|quota|usage)\b/gi,
  /\b(calls?|transcripts?|transcriptions?|voice|recordings?|voicemail|sms)\b/gi,
  /\b(patient|prescription|diagnosis|treatment|appointment|claim|provider)\b/gi,
  /\b(ad|impression|click|conversion|attribution|campaign|pixel|creative)\b/gi,
];

/** "X management", "manage X", etc. — implicit entity extraction */
const MANAGEMENT_PATTERNS: RegExp[] = [
  /\b(\w+)\s+management\b/gi,
  /\bmanage\s+(\w+)\b/gi,
  /\b(\w+)\s+tracking\b/gi,
  /\btrack(?:ing)?\s+(\w+)\b/gi,
  /\b(\w+)\s+system\b/gi,
  /\b(\w+)\s+platform\b/gi,
];

/**
 * Extract stack items and domain entities from a free-form intention string.
 *
 * Returns:
 * - `stack` — technology labels detected (D1, R2, Stripe, …)
 * - `entities` — up to 4 domain entity nouns (capitalized)
 */
export function extractEnrichedPrd(intention: string): { stack: string[]; entities: string[] } {
  const lower = intention.toLowerCase();

  // Stack: find tech tokens in free-form text
  const stack: string[] = [];
  for (const { pattern, label } of STACK_TOKEN_DEFS) {
    if (pattern.test(intention)) stack.push(label);
  }

  // Entities: domain noun patterns
  const entitySet = new Set<string>();

  for (const re of DOMAIN_ENTITY_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      const raw = m[1]!;
      const noun = raw.charAt(0).toUpperCase() + raw.slice(1);
      if (!INFRA_STOPWORDS.has(raw)) entitySet.add(noun);
    }
  }

  for (const re of MANAGEMENT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      const noun = m[1]!;
      if (!INFRA_STOPWORDS.has(noun) && noun.length > 3) {
        entitySet.add(noun.charAt(0).toUpperCase() + noun.slice(1));
      }
    }
  }

  const entities = [...entitySet].slice(0, 4);
  return { stack, entities };
}

/**
 * Inject extracted stack/entities as PRD sections into the intention so
 * downstream parsers can drive schema, contracts, and bindings.
 *
 * Sections are only appended if not already present in the intention string.
 */
export function injectPrdSections(intention: string, stack: string[], entities: string[]): string {
  let enriched = intention;
  if (stack.length > 0 && !/\bStack\s*:/i.test(intention)) {
    enriched += `\n\nStack: ${stack.join(', ')}`;
  }
  if (entities.length > 0 && !/\bEntities\s*:/i.test(intention)) {
    enriched += `\nEntities: ${entities.join(', ')}`;
  }
  return enriched;
}

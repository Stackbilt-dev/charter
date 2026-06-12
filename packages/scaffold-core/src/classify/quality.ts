/**
 * classify/quality — inferQualityProfile
 *
 * Derives a QualityProfile from the enriched intention and detected traits.
 * Signals compliance domains (PHI, PCI, PII, telephony) and feature flags
 * (observability, authentication, rate limiting, PII handling) from free-form
 * text and the chosen pattern name.
 */

import type { QualityProfile } from '../types';

export type { QualityProfile };

/**
 * Infer a QualityProfile from the enriched intention string, pattern source
 * name, and traits array.
 *
 * @param intention  The (optionally enriched) intention string
 * @param pattern    The source pattern name (e.g. 'workers-saas', 'ai-chat')
 * @param traits     The traits array from the matched PatternDef
 */
export function inferQualityProfile(
  intention: string,
  pattern: string = '',
  traits: string[] = [],
): QualityProfile {
  const text = intention.toLowerCase();
  const traitsStr = traits.join(' ').toLowerCase();

  // ── Compliance domain detection ──────────────────────────────────────────
  const isPhi = /\b(patient|health record|prescription|diagnosis|treatment|clinical|hipaa|phi|medical record|ehr|emr)\b/i.test(intention);
  const isPci = /\b(credit card|debit card|payment card|cardholder|pci[\s-]?dss|pan number|card number|tokeniz)\b/i.test(intention);
  const isPii = isPhi || isPci
    || /\b(pii|gdpr|ccpa|personally identifiable|social security|ssn)\b/i.test(intention)
    || (/\b(email|phone|address)\b/i.test(intention) && /stor|sav|persist|collect|process/i.test(intention));
  const isTelephony = /\b(twilio|phone[\s-]?call|voice[\s-]?call|inbound[\s-]?call|outbound[\s-]?call|sms|transcript|recording|voicemail|telephony)\b/i.test(intention);

  const complianceDomains: Array<'PHI' | 'PCI' | 'PII' | 'telephony'> = [];
  if (isPhi) complianceDomains.push('PHI');
  if (isPci) complianceDomains.push('PCI');
  if (isPii && !isPhi && !isPci) complianceDomains.push('PII');
  if (isTelephony) complianceDomains.push('telephony');

  // ── Feature flags ────────────────────────────────────────────────────────
  const needsPayments = pattern === 'stripe-webhook'
    || text.includes('stripe') || text.includes('billing') || text.includes('checkout');

  const needsTenancy = pattern === 'workers-saas'
    || text.includes('tenant') || text.includes('organization') || text.includes('workspace');

  const needsStreaming = pattern === 'ai-chat'
    || text.includes('stream') || text.includes('chat');

  const needsRateLimit = text.includes('rate limit') || text.includes('rate-limit') || text.includes('quota');
  const needsJwt = text.includes('jwt') || traitsStr.includes('jwt-auth');
  const needsOAuth = text.includes('oauth');

  const authentication = needsTenancy || needsPayments || needsJwt || needsOAuth
    || traitsStr.includes('bearer-auth') || traitsStr.includes('session-auth');

  const piiHandling = isPhi || isPci || isPii;

  // ── Testing level ────────────────────────────────────────────────────────
  // Thorough when compliance domains are present; standard for SaaS/payments;
  // basic for simple webhooks and cron workers.
  const testingLevel: 'basic' | 'standard' | 'thorough' =
    complianceDomains.length > 0 ? 'thorough'
    : (needsTenancy || needsPayments || needsStreaming) ? 'standard'
    : 'basic';

  return {
    testingLevel,
    observability: needsTenancy || needsPayments || needsStreaming || complianceDomains.length > 0,
    authentication,
    rateLimiting: needsRateLimit,
    piiHandling,
    complianceDomains,
  };
}

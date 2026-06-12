/**
 * governance/adr — Architecture Decision Record generator
 */

import type { ScaffoldFacts, PatternKnowledge } from '../types';

export function buildAdr001(facts: ScaffoldFacts, knowledge: PatternKnowledge): string {
  const context = knowledge.adrContext || `Building ${facts.intention} on Cloudflare Workers.`;
  const decision =
    knowledge.adrDecision ||
    `Use the \`${facts.pattern}\` scaffold pattern as the implementation baseline.`;

  const consequences: string[] = [
    `- Inherits standard ${facts.pattern} file layout and binding conventions`,
    facts.qualityProfile.authentication ? '- Authentication layer is required on all protected routes' : '',
    facts.qualityProfile.rateLimiting ? '- Rate limiting must be applied at the edge' : '',
    facts.qualityProfile.observability ? '- Structured logging and trace IDs are required' : '',
  ].filter(Boolean);

  return [
    `# ADR-001: Pattern Selection — ${facts.projectName}`,
    '',
    '**Status**: Accepted',
    '',
    '## Context',
    '',
    context,
    '',
    '## Decision',
    '',
    decision,
    '',
    '## Consequences',
    '',
    ...consequences,
    '',
    '## Traits',
    '',
    facts.traits.length > 0
      ? facts.traits.map((t) => `- \`${t}\``).join('\n')
      : '_No specific traits identified._',
    '',
  ].join('\n');
}

export function buildAdr002(facts: ScaffoldFacts): string | undefined {
  const domains = facts.qualityProfile.complianceDomains;
  if (domains.length === 0) return undefined;

  const domainNotes: Record<string, string> = {
    PHI: 'PHI data must be encrypted at rest and in transit. Access logs are required. BAA agreements must be in place.',
    PCI: 'PCI scope must be minimized. No card data may be logged. SAQ-A or SAQ-D compliance required.',
    PII: 'PII data requires explicit consent, deletion workflows, and access auditing.',
    telephony: 'Telephony integrations require CPNI protections and call recording disclosures.',
  };

  const notes = domains.map((d) => `### ${d}\n\n${domainNotes[d] ?? ''}`).join('\n\n');

  return [
    `# ADR-002: Compliance Domains — ${facts.projectName}`,
    '',
    '**Status**: Accepted',
    '',
    '## Context',
    '',
    `This project operates under the following compliance domains: **${domains.join(', ')}**.`,
    '',
    '## Domain Requirements',
    '',
    notes,
    '',
    '## Decision',
    '',
    'Implement the data handling controls described above as first-class engineering requirements, not post-hoc audits.',
    '',
  ].join('\n');
}

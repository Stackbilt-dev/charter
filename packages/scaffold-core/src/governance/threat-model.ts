/**
 * governance/threat-model — threat model document generator
 */

import type { ScaffoldFacts, PatternKnowledge, ThreatEntry } from '../types';

function severityEmoji(severity: ThreatEntry['severity']): string {
  switch (severity) {
    case 'CRITICAL': return '🔴';
    case 'HIGH':     return '🟠';
    case 'MEDIUM':   return '🟡';
    case 'LOW':      return '🟢';
  }
}

function renderThreatTable(threats: ThreatEntry[]): string {
  if (threats.length === 0) return '_No specific threats identified for this pattern._\n';
  const rows = threats.map(
    (t) =>
      `| ${t.id} | ${severityEmoji(t.severity)} ${t.severity} | ${t.category} | ${t.description} | ${t.mitigation} |`,
  );
  return [
    '| ID | Severity | Category | Description | Mitigation |',
    '|----|----------|----------|-------------|------------|',
    ...rows,
  ].join('\n') + '\n';
}

export function buildThreatModel(facts: ScaffoldFacts, knowledge: PatternKnowledge): string {
  const allThreats = [...knowledge.threats, ...knowledge.domainThreats];
  const highCritical = allThreats.filter((t) => t.severity === 'CRITICAL' || t.severity === 'HIGH');
  const complianceDomains = facts.qualityProfile.complianceDomains;

  const sections: string[] = [
    `# Threat Model — ${facts.projectName}`,
    '',
    '## Overview',
    '',
    `**Pattern**: \`${facts.pattern}\`  `,
    `**Intent**: ${facts.intention}  `,
    complianceDomains.length > 0
      ? `**Compliance domains**: ${complianceDomains.join(', ')}`
      : '**Compliance domains**: none',
    '',
    '## Security Properties',
    '',
    `- Authentication required: ${facts.qualityProfile.authentication ? '✅ Yes' : '❌ No'}`,
    `- Rate limiting: ${facts.qualityProfile.rateLimiting ? '✅ Yes' : '❌ No'}`,
    `- PII handling: ${facts.qualityProfile.piiHandling ? '✅ Yes' : '❌ No'}`,
    `- Observability: ${facts.qualityProfile.observability ? '✅ Yes' : '❌ No'}`,
    '',
    '## Pattern Threats',
    '',
    renderThreatTable(knowledge.threats),
  ];

  if (knowledge.domainThreats.length > 0) {
    sections.push('## Domain-Specific Threats', '', renderThreatTable(knowledge.domainThreats));
  }

  if (highCritical.length > 0) {
    sections.push(
      '## Priority Mitigations',
      '',
      ...highCritical.map((t) => `- **${t.id}** (${t.severity}): ${t.mitigation}`),
      '',
    );
  }

  sections.push(
    '## Bindings Surface',
    '',
    facts.bindings.length > 0
      ? facts.bindings.map((b) => `- \`${b.binding}\` (${b.type}): ${b.name}`).join('\n')
      : '_No bindings defined._',
    '',
  );

  return sections.join('\n');
}

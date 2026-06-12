/**
 * governance/test-plan — test plan document generator
 */

import type { ScaffoldFacts } from '../types';

const LEVEL_LABELS: Record<string, string> = {
  basic: 'Basic (happy-path unit tests)',
  standard: 'Standard (unit + integration)',
  thorough: 'Thorough (unit + integration + edge cases + load)',
};

function traitSections(traits: string[]): string[] {
  const sections: string[] = [];

  if (traits.includes('rest')) {
    sections.push(
      '### REST Routes',
      '- [ ] 200 OK on valid request',
      '- [ ] 400 on malformed body',
      '- [ ] 401 on missing/invalid token',
      '- [ ] 404 on unknown resource',
      '- [ ] 429 on rate limit exceeded',
    );
  }
  if (traits.includes('jwt-auth') || traits.includes('auth')) {
    sections.push(
      '### Authentication',
      '- [ ] Valid JWT accepted',
      '- [ ] Expired JWT rejected',
      '- [ ] Missing Authorization header → 401',
    );
  }
  if (traits.includes('hmac-stripe') || traits.includes('hmac-sha256')) {
    sections.push(
      '### Webhook Signature',
      '- [ ] Valid HMAC signature accepted',
      '- [ ] Invalid signature rejected with 401',
      '- [ ] Replay outside tolerance window rejected',
    );
  }
  if (traits.includes('scheduled-handler') || traits.includes('cron')) {
    sections.push(
      '### Scheduled Handler',
      '- [ ] Cron fires without throwing',
      '- [ ] Idempotent on repeated invocation',
    );
  }
  if (traits.includes('ws-and-rest') || traits.includes('websocket')) {
    sections.push(
      '### WebSocket',
      '- [ ] Upgrade handshake succeeds',
      '- [ ] Client disconnect cleans up state',
    );
  }
  if (traits.includes('queue') || traits.includes('batch')) {
    sections.push(
      '### Queue Consumer',
      '- [ ] Successful batch processed without error',
      '- [ ] Partial failure triggers retry for failed messages only',
    );
  }

  return sections;
}

export function buildTestPlan(facts: ScaffoldFacts): string {
  const level = LEVEL_LABELS[facts.qualityProfile.testingLevel] ?? facts.qualityProfile.testingLevel;
  const sections = traitSections(facts.traits);

  const lines: string[] = [
    `# Test Plan — ${facts.projectName}`,
    '',
    `**Testing level**: ${level}  `,
    `**Pattern**: \`${facts.pattern}\``,
    '',
    '## Required Coverage',
    '',
    '- [ ] All exported functions have unit tests',
    '- [ ] Error paths return correct HTTP status codes',
    facts.qualityProfile.piiHandling ? '- [ ] PII fields are not logged in error messages' : '',
    facts.qualityProfile.observability ? '- [ ] Trace IDs present in all log lines' : '',
    facts.qualityProfile.rateLimiting ? '- [ ] Rate limit counter increments correctly' : '',
  ].filter((l) => l !== '');

  if (sections.length > 0) {
    lines.push('', '## Trait-Specific Tests', '', ...sections);
  }

  if (facts.qualityProfile.testingLevel === 'thorough') {
    lines.push(
      '',
      '## Load & Edge Cases',
      '',
      '- [ ] 1000 req/s sustained without memory leak',
      '- [ ] Empty body on all POST routes',
      '- [ ] Payload > 1MB rejected cleanly',
    );
  }

  lines.push(
    '',
    '## Bindings Under Test',
    '',
    facts.bindings.length > 0
      ? facts.bindings.map((b) => `- [ ] \`${b.binding}\` (${b.type}) integration verified`).join('\n')
      : '_No bindings to verify._',
    '',
  );

  return lines.join('\n');
}

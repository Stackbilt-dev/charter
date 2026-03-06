import { describe, it, expect } from 'vitest';
import { classifyElement, buildMigrationPlan } from '../content-classifier';
import type { TriggerMap } from '../content-classifier';
import type { MarkdownElement, MarkdownSection } from '../markdown-parser';

const triggerMap: TriggerMap = {
  'frontend.adf': ['react', 'css', 'ui'],
  'backend.adf': ['api', 'node', 'db'],
};

function rule(content: string, strength: 'imperative' | 'advisory' | 'neutral' = 'neutral'): MarkdownElement {
  return { type: 'rule', content, strength };
}

function prose(content: string): MarkdownElement {
  return { type: 'prose', content };
}

describe('classifyElement', () => {
  describe('heading-based routing (no triggerMap)', () => {
    it('routes to frontend.adf when heading mentions UI', () => {
      const result = classifyElement(rule('Use PascalCase'), 'UI Components');
      expect(result.targetModule).toBe('frontend.adf');
    });

    it('routes to backend.adf when heading mentions API', () => {
      const result = classifyElement(rule('Validate inputs'), 'API Endpoints');
      expect(result.targetModule).toBe('backend.adf');
    });

    it('routes verification headings to qa.adf', () => {
      const result = classifyElement(rule('Run contract tests before release'), 'Verification');
      expect(result.targetModule).toBe('qa.adf');
    });

    it('routes to core.adf for generic headings', () => {
      const result = classifyElement(rule('Use conventional commits'), 'Conventions');
      expect(result.targetModule).toBe('core.adf');
    });
  });

  describe('content-based fallback routing (with triggerMap)', () => {
    it('routes React content under generic heading to frontend.adf', () => {
      const result = classifyElement(rule('React components use PascalCase.tsx'), 'Conventions', triggerMap);
      expect(result.targetModule).toBe('frontend.adf');
    });

    it('routes API content under generic heading to backend.adf', () => {
      const result = classifyElement(rule('All API routes require auth middleware'), 'Stack', triggerMap);
      expect(result.targetModule).toBe('backend.adf');
    });

    it('routes DB content under generic heading to backend.adf', () => {
      const result = classifyElement(rule('Run DB migrations before deploy'), 'General', triggerMap);
      expect(result.targetModule).toBe('backend.adf');
    });

    it('routes CSS content to frontend.adf', () => {
      const result = classifyElement(rule('Use CSS modules for scoped styles'), 'Stack', triggerMap);
      expect(result.targetModule).toBe('frontend.adf');
    });

    it('chooses the module with the strongest trigger match instead of first match', () => {
      const qaTriggerMap: TriggerMap = {
        'infra.adf': ['ci', 'pipeline', 'artifact'],
        'qa.adf': ['test', 'playwright', 'evidence', 'auditability'],
      };
      const result = classifyElement(
        rule('Playwright test evidence is uploaded from the CI pipeline for auditability'),
        'Checklist',
        qaTriggerMap,
      );
      expect(result.targetModule).toBe('qa.adf');
    });

    it('stays on core.adf when no trigger keyword matches', () => {
      const result = classifyElement(rule('Use conventional commits'), 'Conventions', triggerMap);
      expect(result.targetModule).toBe('core.adf');
    });

    it('does not override heading-based routing when heading already matches', () => {
      const result = classifyElement(rule('Validate API inputs'), 'UI Components', triggerMap);
      expect(result.targetModule).toBe('frontend.adf');
    });
  });

  describe('STAY patterns', () => {
    it('marks WSL-specific content as STAY', () => {
      const result = classifyElement(rule('Configure credential.helper for WSL'), 'Environment');
      expect(result.decision).toBe('STAY');
    });
  });

  describe('classification decisions', () => {
    it('classifies imperative rules as load-bearing CONSTRAINTS', () => {
      const result = classifyElement(rule('NEVER commit secrets', 'imperative'), 'General', triggerMap);
      expect(result.decision).toBe('MIGRATE');
      expect(result.targetSection).toBe('CONSTRAINTS');
      expect(result.weight).toBe('load-bearing');
    });

    it('classifies advisory rules as ADVISORY', () => {
      const result = classifyElement(rule('Prefer TypeScript', 'advisory'), 'General', triggerMap);
      expect(result.decision).toBe('MIGRATE');
      expect(result.targetSection).toBe('ADVISORY');
      expect(result.weight).toBe('advisory');
    });

    it('classifies prose as CONTEXT', () => {
      const result = classifyElement(prose('The system architecture uses layers'), 'Overview');
      expect(result.decision).toBe('MIGRATE');
      expect(result.targetSection).toBe('CONTEXT');
    });
  });
});

describe('buildMigrationPlan', () => {
  it('routes items using triggerMap when provided', () => {
    const sections: MarkdownSection[] = [
      {
        heading: 'Conventions',
        elements: [
          rule('React components use PascalCase'),
          rule('API routes use kebab-case'),
          rule('Use conventional commits'),
        ],
      },
    ];

    const plan = buildMigrationPlan(sections, undefined, triggerMap);

    const frontendItems = plan.migrateItems.filter(i => i.classification.targetModule === 'frontend.adf');
    const backendItems = plan.migrateItems.filter(i => i.classification.targetModule === 'backend.adf');
    const coreItems = plan.migrateItems.filter(i => i.classification.targetModule === 'core.adf');

    expect(frontendItems).toHaveLength(1);
    expect(frontendItems[0].element.content).toContain('React');

    expect(backendItems).toHaveLength(1);
    expect(backendItems[0].element.content).toContain('API');

    expect(coreItems).toHaveLength(1);
    expect(coreItems[0].element.content).toContain('conventional commits');
  });

  it('works without triggerMap (backward compatible)', () => {
    const sections: MarkdownSection[] = [
      {
        heading: 'Conventions',
        elements: [rule('React components use PascalCase')],
      },
    ];

    const plan = buildMigrationPlan(sections);
    expect(plan.migrateItems[0].classification.targetModule).toBe('core.adf');
  });
});

// ============================================================================
// QA phrase override routing (#44, #45)
// ============================================================================

describe('QA phrase override routing', () => {
  const mixedTriggerMap: TriggerMap = {
    'infra.adf': ['ci', 'pipeline', 'artifact', 'deploy'],
    'backend.adf': ['api', 'database', 'migration'],
    'qa.adf': ['test', 'smoke', 'contract', 'evidence'],
  };

  it('routes "smoke test" bullet to qa.adf even when infra keywords dominate (#44)', () => {
    // "ci pipeline artifact" would win on raw keyword count vs single "smoke test"
    const result = classifyElement(
      rule('Run smoke tests against the CI pipeline artifact before promoting'),
      'Checklist',
      mixedTriggerMap,
    );
    expect(result.targetModule).toBe('qa.adf');
    expect(result.routingTrace?.phraseOverride).toBe('qa.adf');
  });

  it('routes "contract test" bullet to qa.adf even when backend keywords coexist (#45)', () => {
    // "api", "database", "migration" would score 3 for backend vs 1 "contract" for qa
    const result = classifyElement(
      rule('Run contract tests for all API and database migration endpoints'),
      'Release',
      mixedTriggerMap,
    );
    expect(result.targetModule).toBe('qa.adf');
    expect(result.routingTrace?.phraseOverride).toBe('qa.adf');
  });

  it('routes "schema compat" bullet to qa.adf', () => {
    const result = classifyElement(
      rule('Verify schema compat before every deploy'),
      'Checklist',
      mixedTriggerMap,
    );
    expect(result.targetModule).toBe('qa.adf');
  });

  it('routes "approval gate" bullet to qa.adf', () => {
    const result = classifyElement(
      rule('All deploys must pass the approval gate'),
      'Checklist',
      mixedTriggerMap,
    );
    expect(result.targetModule).toBe('qa.adf');
  });

  it('does NOT fire phrase override when qa.adf is absent from triggerMap', () => {
    // Without qa.adf in the map, phrase override cannot fire — falls through to keyword scoring
    const infraOnly: TriggerMap = {
      'infra.adf': ['ci', 'pipeline', 'artifact'],
    };
    const result = classifyElement(
      rule('Run smoke tests against the CI pipeline artifact'),
      'Checklist',
      infraOnly,
    );
    // Falls back to keyword scoring: ci+pipeline+artifact → infra.adf wins
    expect(result.targetModule).toBe('infra.adf');
    expect(result.routingTrace?.phraseOverride).toBeUndefined();
  });
});

// ============================================================================
// Routing trace observability (#46)
// ============================================================================

describe('routing trace (#46)', () => {
  const traceMap: TriggerMap = {
    'frontend.adf': ['react', 'css', 'ui'],
    'backend.adf': ['api', 'node', 'db'],
    'qa.adf': ['test', 'smoke', 'contract'],
  };

  it('attaches routingTrace when content-based routing fires', () => {
    const result = classifyElement(
      rule('React components use PascalCase'),
      'Conventions',
      traceMap,
    );
    expect(result.routingTrace).toBeDefined();
    expect(result.routingTrace?.headingModule).toBe('core.adf');
    expect(result.routingTrace?.candidateScores).toBeDefined();
    expect(result.routingTrace?.candidateScores['frontend.adf']).toBeGreaterThan(0);
  });

  it('populates phraseOverride when a QA phrase pattern matches', () => {
    const result = classifyElement(
      rule('Run smoke tests against staging before release'),
      'Checklist',
      traceMap,
    );
    expect(result.routingTrace?.phraseOverride).toBe('qa.adf');
    expect(result.routingTrace?.candidateScores['qa.adf']).toBe(Infinity);
  });

  it('candidateScores contains an entry for every module in the triggerMap', () => {
    const result = classifyElement(
      rule('Use React for all UI components'),
      'General',
      traceMap,
    );
    expect(result.routingTrace).toBeDefined();
    const scores = result.routingTrace!.candidateScores;
    expect('frontend.adf' in scores).toBe(true);
    expect('backend.adf' in scores).toBe(true);
    expect('qa.adf' in scores).toBe(true);
  });

  it('does not attach routingTrace when heading-based routing resolves without fallback', () => {
    // Heading "UI Components" resolves to frontend.adf directly — no content fallback runs
    const result = classifyElement(rule('Use PascalCase'), 'UI Components', traceMap);
    expect(result.routingTrace).toBeUndefined();
  });
});

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

import { describe, it, expect } from 'vitest';
import { classifyElement, buildMigrationPlan } from '../content-classifier';
import type { ClassifierConfig } from '../content-classifier';
import type { MarkdownElement, MarkdownSection } from '../markdown-parser';

function rule(content: string, strength: 'imperative' | 'advisory' | 'neutral' = 'imperative'): MarkdownElement {
  return { type: 'rule', content, strength };
}

describe('ClassifierConfig', () => {
  describe('stayPatterns', () => {
    it('uses default patterns when config omitted', () => {
      const result = classifyElement(rule('Use WSL credential.helper'), 'Setup');
      expect(result.decision).toBe('STAY');
    });

    it('overrides stay patterns with custom list', () => {
      const config: ClassifierConfig = { stayPatterns: [/\bcustom-env\b/i] };
      // WSL no longer triggers STAY with custom patterns
      const r1 = classifyElement(rule('Use WSL credential.helper'), 'Setup', undefined, config);
      expect(r1.decision).toBe('MIGRATE');
      // Custom pattern does trigger STAY
      const r2 = classifyElement(rule('Set custom-env variable'), 'Setup', undefined, config);
      expect(r2.decision).toBe('STAY');
    });
  });

  describe('headingRoutes', () => {
    it('uses default heading routes when config omitted', () => {
      const result = classifyElement(rule('Use React hooks'), 'Frontend Design');
      expect(result.targetModule).toBe('frontend.adf');
    });

    it('overrides heading routes with custom list', () => {
      const config: ClassifierConfig = {
        headingRoutes: [{ pattern: /\binfra\b/, module: 'infra.adf' }],
      };
      // "Frontend" no longer matches custom routes → core.adf
      const r1 = classifyElement(rule('Use React hooks'), 'Frontend Design', undefined, config);
      expect(r1.targetModule).toBe('core.adf');
      // "Infra" matches custom route
      const r2 = classifyElement(rule('Use Terraform'), 'Infra Setup', undefined, config);
      expect(r2.targetModule).toBe('infra.adf');
    });
  });

  describe('buildMigrationPlan threading', () => {
    it('threads config to classifyElement', () => {
      const sections: MarkdownSection[] = [
        { heading: 'Infra', elements: [rule('Provision servers')] },
      ];
      const config: ClassifierConfig = {
        headingRoutes: [{ pattern: /\binfra\b/, module: 'infra.adf' }],
      };
      const plan = buildMigrationPlan(sections, undefined, undefined, config);
      expect(plan.migrateItems[0].classification.targetModule).toBe('infra.adf');
    });
  });
});

/**
 * types.test.ts — structural type tests for @stackbilt/scaffold-core
 *
 * Verifies that the package exports the expected symbols and that the
 * TypeScript types compile correctly. Does not invoke any stub implementations.
 */

import { describe, it, expect } from 'vitest';
import {
  buildScaffold,
  classify,
  getKnowledge,
  buildGovernance,
  generateFiles,
  materializeScaffold,
} from '../index';
import type {
  PatternName,
  PatternDef,
  ClassifyResult,
  QualityProfile,
  ScaffoldBinding,
  ThreatEntry,
  PatternKnowledge,
  GovernanceDocs,
  FileRole,
  ScaffoldFile,
  ScaffoldFacts,
  MaterializerResult,
  LocalScaffoldResult,
  ScaffoldOptions,
} from '../index';

// ============================================================================
// Function exports
// ============================================================================

describe('scaffold-core function exports', () => {
  it('buildScaffold is exported and is a function', () => {
    expect(typeof buildScaffold).toBe('function');
  });

  it('classify is exported and is a function', () => {
    expect(typeof classify).toBe('function');
  });

  it('getKnowledge is exported and is a function', () => {
    expect(typeof getKnowledge).toBe('function');
  });

  it('buildGovernance is exported and is a function', () => {
    expect(typeof buildGovernance).toBe('function');
  });

  it('generateFiles is exported and is a function', () => {
    expect(typeof generateFiles).toBe('function');
  });

  it('materializeScaffold is exported and is a function', () => {
    expect(typeof materializeScaffold).toBe('function');
  });
});

// ============================================================================
// Real implementations (classify and buildScaffold are now real)
// ============================================================================

describe('classify and buildScaffold are implemented', () => {
  it('buildScaffold returns a LocalScaffoldResult without throwing', () => {
    const result = buildScaffold('build a KV-backed worker');
    expect(result).toBeDefined();
    expect(result.classification).toBeDefined();
    expect(result.files).toBeDefined();
  });

  it('classify returns a ClassifyResult without throwing', () => {
    const result = classify('build a KV-backed worker');
    expect(result).toBeDefined();
    expect(result.pattern).toBeDefined();
    expect(typeof result.confidence).toBe('number');
  });
});

// ============================================================================
// Type compile tests (satisfies)
// ============================================================================

describe('types compile', () => {
  it('PatternName union is assignable', () => {
    const p: PatternName = 'worker';
    expect(p).toBe('worker');
  });

  it('QualityProfile satisfies shape', () => {
    const q: QualityProfile = {
      testingLevel: 'standard',
      observability: false,
      authentication: false,
      rateLimiting: false,
      piiHandling: false,
      complianceDomains: [],
    };
    expect(q.testingLevel).toBe('standard');
  });

  it('ScaffoldBinding satisfies shape', () => {
    const b: ScaffoldBinding = { type: 'KV', name: 'MY_KV', binding: 'MY_KV' };
    expect(b.type).toBe('KV');
  });

  it('ThreatEntry satisfies shape', () => {
    const t: ThreatEntry = {
      id: 'T001',
      category: 'injection',
      description: 'SQL injection via untrusted input',
      mitigation: 'Parameterize all queries',
      severity: 'HIGH',
    };
    expect(t.severity).toBe('HIGH');
  });

  it('ScaffoldFile satisfies shape', () => {
    const f: ScaffoldFile = { path: 'src/index.ts', content: '// stub', role: 'entry' };
    expect(f.role).toBe('entry');
  });

  it('FileRole union covers expected values', () => {
    const roles: FileRole[] = ['entry', 'config', 'test', 'migration', 'contract', 'adf', 'readme'];
    expect(roles).toHaveLength(7);
  });

  it('PatternDef satisfies shape', () => {
    const def: PatternDef = {
      name: 'api',
      status: 'ACTIVE',
      category: 'COMPUTE',
      keywords: ['rest', 'http'],
      traits: ['auth'],
    };
    expect(def.status).toBe('ACTIVE');
  });

  it('ScaffoldOptions is optional-only', () => {
    const opts: ScaffoldOptions = {};
    expect(opts).toBeDefined();

    const opts2: ScaffoldOptions = { projectName: 'my-worker', oracle: false };
    expect(opts2.projectName).toBe('my-worker');
  });

  it('PatternKnowledge satisfies shape', () => {
    const k: PatternKnowledge = {
      threats: [],
      adrContext: '',
      adrDecision: '',
      domainThreats: [],
    };
    expect(Array.isArray(k.threats)).toBe(true);
  });

  it('GovernanceDocs satisfies shape (adr002 optional)', () => {
    const g: GovernanceDocs = { threatModel: '', adr001: '', testPlan: '' };
    expect(g.adr002).toBeUndefined();
  });

  it('MaterializerResult satisfies shape', () => {
    const facts: ScaffoldFacts = {
      pattern: 'worker',
      projectName: 'test',
      intention: 'build a worker',
      bindings: [],
      traits: [],
      qualityProfile: {
        testingLevel: 'basic',
        observability: false,
        authentication: false,
        rateLimiting: false,
        piiHandling: false,
        complianceDomains: [],
      },
    };
    const r: MaterializerResult = { files: [], facts };
    expect(r.files).toHaveLength(0);
  });
});

// ============================================================================
// getKnowledge returns empty-but-valid result (knowledge stubs return defaults)
// ============================================================================

describe('knowledge module stubs return valid empty results', () => {
  it('getKnowledge returns PatternKnowledge with empty arrays', () => {
    const k: PatternKnowledge = getKnowledge('worker');
    expect(Array.isArray(k.threats)).toBe(true);
    expect(Array.isArray(k.domainThreats)).toBe(true);
    expect(typeof k.adrContext).toBe('string');
    expect(typeof k.adrDecision).toBe('string');
  });
});

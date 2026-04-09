import { describe, it, expect } from 'vitest';
import {
  parseOntologyRegistry,
  parseInlineFlowSequence,
  extractIdentifiersFromLine,
  stripCommentsAndStrings,
  checkOntologyDiff,
  normalizeToken,
  type OntologyChangedLine,
} from '../ontology';

// ============================================================================
// Fixture
// ============================================================================

const FIXTURE_REGISTRY_YAML = `# Test registry — minimal subset of real data-registry.yaml shape
concepts:

  # ─── edge-auth ──────────────────────────

  tenant:
    owner: edge-auth
    table: tenants
    sensitivity: cross_service_rpc
    definition: User workspace or account boundary.
    aliases: [tenants, workspace, workspaces, organization]
    rpc_method: getTenant
    mcp_tool: edge-auth

  user:
    owner: edge-auth
    table: users
    sensitivity: pii_scoped
    definition: Authenticated user identity.
    aliases: [users, account, accounts]
    rpc_method: getUser

  quota:
    owner: edge-auth
    table: quotas
    sensitivity: cross_service_rpc
    definition: Resource usage limits and current balance per tenant.
    aliases: [credits, credit, stackbilt_credits, usage, limits]
    rpc_method: checkQuota

  subscription:
    owner: edge-auth
    table: tenants.tier
    sensitivity: billing_critical
    definition: Subscription level.
    aliases: [tier, tiers, plan]
`;

// ============================================================================
// Helpers
// ============================================================================

function buildFixtureRegistry() {
  return parseOntologyRegistry(FIXTURE_REGISTRY_YAML);
}

function line(text: string, file = 'src/handler.ts', lineNumber = 1): OntologyChangedLine {
  return { file, line: lineNumber, text };
}

// ============================================================================
// normalizeToken
// ============================================================================

describe('normalizeToken', () => {
  it('lowercases', () => {
    expect(normalizeToken('Tenant')).toBe('tenant');
    expect(normalizeToken('TENANT')).toBe('tenant');
  });

  it('strips underscores', () => {
    expect(normalizeToken('tenant_id')).toBe('tenantid');
    expect(normalizeToken('api_key_hash')).toBe('apikeyhash');
  });

  it('strips spaces', () => {
    expect(normalizeToken('api key')).toBe('apikey');
  });

  it('strips hyphens', () => {
    expect(normalizeToken('edge-auth')).toBe('edgeauth');
  });
});

// ============================================================================
// parseInlineFlowSequence
// ============================================================================

describe('parseInlineFlowSequence', () => {
  it('parses a simple flow sequence', () => {
    expect(parseInlineFlowSequence('[a, b, c]')).toEqual(['a', 'b', 'c']);
  });

  it('handles whitespace', () => {
    expect(parseInlineFlowSequence('[  tenant,  workspace ,organization  ]')).toEqual([
      'tenant',
      'workspace',
      'organization',
    ]);
  });

  it('handles items with underscores', () => {
    expect(parseInlineFlowSequence('[credits, stackbilt_credits, usage]')).toEqual([
      'credits',
      'stackbilt_credits',
      'usage',
    ]);
  });

  it('returns empty array for non-sequence input', () => {
    expect(parseInlineFlowSequence('not a sequence')).toEqual([]);
    expect(parseInlineFlowSequence('[]')).toEqual([]);
  });
});

// ============================================================================
// parseOntologyRegistry
// ============================================================================

describe('parseOntologyRegistry', () => {
  it('loads all 4 concepts from the fixture', () => {
    const registry = buildFixtureRegistry();
    expect(registry.concepts.size).toBe(4);
    expect(registry.concepts.has('tenant')).toBe(true);
    expect(registry.concepts.has('user')).toBe(true);
    expect(registry.concepts.has('quota')).toBe(true);
    expect(registry.concepts.has('subscription')).toBe(true);
  });

  it('populates concept fields correctly', () => {
    const registry = buildFixtureRegistry();
    const tenant = registry.concepts.get('tenant')!;
    expect(tenant.owner).toBe('edge-auth');
    expect(tenant.table).toBe('tenants');
    expect(tenant.sensitivity).toBe('cross_service_rpc');
    expect(tenant.definition).toContain('User workspace');
    expect(tenant.rpcMethod).toBe('getTenant');
    expect(tenant.mcpTool).toBe('edge-auth');
    expect(tenant.aliases).toContain('workspace');
  });

  it('handles concepts without optional fields', () => {
    const registry = buildFixtureRegistry();
    const user = registry.concepts.get('user')!;
    expect(user.rpcMethod).toBe('getUser');
    expect(user.mcpTool).toBeUndefined();
  });

  it('indexes aliases to canonical names', () => {
    const registry = buildFixtureRegistry();
    expect(registry.aliasIndex.get('workspace')).toBe('tenant');
    expect(registry.aliasIndex.get('credits')).toBe('quota');
    expect(registry.aliasIndex.get('credit')).toBe('quota');
    expect(registry.aliasIndex.get('tiers')).toBe('subscription');
  });

  it('populates canonical token index', () => {
    const registry = buildFixtureRegistry();
    expect(registry.canonicalTokens.has('tenant')).toBe(true);
    expect(registry.canonicalTokens.has('subscription')).toBe(true);
  });

  it('populates alias token set', () => {
    const registry = buildFixtureRegistry();
    expect(registry.aliasTokens.has('workspace')).toBe(true);
    expect(registry.aliasTokens.has('stackbiltcredits')).toBe(true);
  });

  it('skips comment lines and blank lines', () => {
    const withComments = `# top comment
concepts:
  # section header

  tenant:
    owner: edge-auth
    sensitivity: cross_service_rpc
    definition: test
    aliases: [workspace]
`;
    const registry = parseOntologyRegistry(withComments);
    expect(registry.concepts.size).toBe(1);
    expect(registry.concepts.get('tenant')!.owner).toBe('edge-auth');
  });

  it('throws on empty/malformed input', () => {
    expect(() => parseOntologyRegistry('')).toThrow(/no concepts found/);
    expect(() => parseOntologyRegistry('# just a comment')).toThrow(/no concepts found/);
  });

  it('handles table: null for derived concepts', () => {
    const withNullTable = `concepts:
  flow:
    owner: edgestack-v2
    table: null
    sensitivity: cross_service_rpc
    definition: Derived flow
    aliases: [flows]
`;
    const registry = parseOntologyRegistry(withNullTable);
    expect(registry.concepts.get('flow')!.table).toBeNull();
  });
});

// ============================================================================
// extractIdentifiersFromLine
// ============================================================================

describe('extractIdentifiersFromLine', () => {
  it('extracts simple identifiers', () => {
    const tokens = extractIdentifiersFromLine('const tenant = getTenant(id);');
    expect(tokens).toContain('tenant');
    expect(tokens).toContain('gettenant');
    expect(tokens).toContain('id');
  });

  it('extracts snake_case identifiers as normalized tokens', () => {
    const tokens = extractIdentifiersFromLine('const tenant_id = row.tenant_id;');
    // tenant_id splits into 'tenant' and 'id' because _ is a separator in \w
    // Actually \w includes _, so it stays together. Let me verify...
    // The regex [a-zA-Z_][a-zA-Z0-9_]* matches tenant_id as a single token.
    expect(tokens.some(t => t === 'tenantid')).toBe(true);
  });

  it('handles SQL-style statements', () => {
    const tokens = extractIdentifiersFromLine("SELECT * FROM tenants WHERE user_id = ?");
    expect(tokens).toContain('tenants');
    expect(tokens).toContain('userid');
  });

  it('ignores punctuation and numbers', () => {
    const tokens = extractIdentifiersFromLine('const PI = 3.14;');
    expect(tokens).toContain('pi');
    expect(tokens).not.toContain('3');
    expect(tokens).not.toContain('14');
  });

  it('strips line comments before tokenizing', () => {
    const tokens = extractIdentifiersFromLine('const quota = 1; // alias usage!');
    expect(tokens).toContain('quota');
    // 'usage' is in the comment — should not be extracted
    expect(tokens).not.toContain('usage');
  });

  it('strips # comments before tokenizing', () => {
    const tokens = extractIdentifiersFromLine('quota: 1  # credits and usage notes');
    expect(tokens).toContain('quota');
    expect(tokens).not.toContain('credits');
    expect(tokens).not.toContain('usage');
  });

  it('strips SQL -- comments before tokenizing', () => {
    const tokens = extractIdentifiersFromLine('SELECT quota FROM tenants -- credits table');
    expect(tokens).toContain('quota');
    expect(tokens).toContain('tenants');
    expect(tokens).not.toContain('credits');
  });

  it('strips string literals before tokenizing', () => {
    const tokens = extractIdentifiersFromLine('const label = "credit balance usage";');
    expect(tokens).toContain('label');
    // credits, usage inside string literal — should not be extracted
    expect(tokens).not.toContain('credit');
    expect(tokens).not.toContain('usage');
    expect(tokens).not.toContain('balance');
  });

  it('strips single-quoted strings', () => {
    const tokens = extractIdentifiersFromLine("throw new Error('tenant not found');");
    expect(tokens).toContain('error');
    expect(tokens).toContain('throw');
    // 'tenant' is inside the string literal
    expect(tokens).not.toContain('tenant');
  });

  it('strips template literals', () => {
    const tokens = extractIdentifiersFromLine('log(`tenant credits updated`);');
    expect(tokens).toContain('log');
    expect(tokens).not.toContain('tenant');
    expect(tokens).not.toContain('credits');
  });

  it('does not strip URLs starting with http://', () => {
    const tokens = extractIdentifiersFromLine('const url = http://api.example.com;');
    // http://api.example.com is not a // line comment because of the : prefix
    expect(tokens).toContain('url');
    expect(tokens).toContain('http');
  });

  it('preserves block comment stripping for /* inline */ spans', () => {
    const tokens = extractIdentifiersFromLine('const tenant = /* credits TODO */ null;');
    expect(tokens).toContain('tenant');
    expect(tokens).not.toContain('credits');
    expect(tokens).not.toContain('todo');
  });
});

describe('stripCommentsAndStrings', () => {
  it('leaves plain code unchanged', () => {
    const result = stripCommentsAndStrings('const tenant = getTenant(id);');
    expect(result).toContain('tenant');
    expect(result).toContain('getTenant');
  });

  it('strips trailing line comments', () => {
    const result = stripCommentsAndStrings('const x = 1; // comment with credits');
    expect(result).not.toContain('credits');
  });

  it('strips YAML-style # comments with space guard', () => {
    const result = stripCommentsAndStrings('key: value # comment');
    expect(result).not.toContain('comment');
    expect(result).toContain('key');
  });

  it('preserves # directives without space (guarded)', () => {
    const result = stripCommentsAndStrings('#include <header>');
    expect(result).toContain('#include');
  });
});

// ============================================================================
// checkOntologyDiff
// ============================================================================

describe('checkOntologyDiff', () => {
  it('flags alias usage as WARN violation', () => {
    const registry = buildFixtureRegistry();
    const result = checkOntologyDiff(
      [line('const credits = await checkCredits(tenantId);')],
      registry
    );

    // 'credits' is an alias for 'quota'
    const aliasViolations = result.violations.filter(v => v.type === 'NON_CANONICAL_ALIAS');
    expect(aliasViolations.length).toBeGreaterThan(0);
    expect(aliasViolations.some(v => v.identifier === 'credits' && v.canonical === 'quota')).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('does not flag canonical usage', () => {
    const registry = buildFixtureRegistry();
    const result = checkOntologyDiff(
      [line('const quota = await checkQuota(tenantId);')],
      registry
    );
    expect(result.violations.filter(v => v.severity === 'WARN').length).toBe(0);
    expect(result.passed).toBe(true);
    // quota is referenced canonically
    const references = result.references.filter(r => r.canonical === 'quota');
    expect(references.length).toBeGreaterThan(0);
    expect(references.every(r => !r.isAlias)).toBe(true);
  });

  it('reports informational references even on a clean diff', () => {
    const registry = buildFixtureRegistry();
    const result = checkOntologyDiff(
      [line('const t = await getTenant(tenantId);')],
      registry
    );
    // 'tenant' canonical is referenced via 'tenantid' normalized token
    // Actually: getTenant normalizes to 'gettenant', tenantId → 'tenantid'
    // Neither matches 'tenant' exactly. We only flag exact token matches.
    // So this diff should have no references if no exact 'tenant' token.
    // Add a line with bare 'tenant' to prove the reference flow:
    const result2 = checkOntologyDiff(
      [line('async function handleTenant(tenant: Tenant) {}')],
      registry
    );
    expect(result2.references.some(r => r.canonical === 'tenant' && !r.isAlias)).toBe(true);
    expect(result2.passed).toBe(true);
  });

  it('summarizes referenced concept counts', () => {
    const registry = buildFixtureRegistry();
    const result = checkOntologyDiff(
      [
        line('const tenant = await getTenant();', 'a.ts', 1),  // canonical
        line('const user = await getUser();', 'b.ts', 1),       // canonical
        line('const workspace = tenant;', 'c.ts', 1),            // alias AND canonical
      ],
      registry
    );
    // tenant: line 1 (canonical) + line 3 (alias via 'workspace') + line 3 (canonical via 'tenant') = 3
    expect(result.referencedConcepts.get('tenant')).toBe(3);
    expect(result.referencedConcepts.get('user')).toBe(1);
  });

  it('does not double-count the same token on the same line', () => {
    const registry = buildFixtureRegistry();
    const result = checkOntologyDiff(
      [line('const tenant = tenant.workspace;', 'a.ts', 1)],
      registry
    );
    const tenantRefs = result.references.filter(r => r.canonical === 'tenant' && !r.isAlias);
    expect(tenantRefs.length).toBe(1);
  });

  it('suppresses alias violations when ignoreAliasViolations is set', () => {
    const registry = buildFixtureRegistry();
    const result = checkOntologyDiff(
      [line('const credits = checkCredits();')],
      registry,
      { ignoreAliasViolations: true }
    );
    expect(result.violations.filter(v => v.type === 'NON_CANONICAL_ALIAS').length).toBe(0);
    expect(result.passed).toBe(true);
    // But still reports it as a reference
    expect(result.references.some(r => r.canonical === 'quota' && r.isAlias)).toBe(true);
  });

  it('flags each changed line independently', () => {
    const registry = buildFixtureRegistry();
    const result = checkOntologyDiff(
      [
        line('const credits = 1;', 'a.ts', 10),
        line('const credit = 2;', 'a.ts', 11),
      ],
      registry
    );
    const violations = result.violations.filter(v => v.type === 'NON_CANONICAL_ALIAS');
    expect(violations.length).toBe(2);
    expect(violations.every(v => v.canonical === 'quota')).toBe(true);
    expect(violations.map(v => v.line).sort()).toEqual([10, 11]);
  });

  it('includes canonical concept metadata in violation messages', () => {
    const registry = buildFixtureRegistry();
    const result = checkOntologyDiff(
      [line('const tier = plan.tier;')],  // 'tier' is alias for 'subscription', 'plan' too
      registry
    );
    const violation = result.violations.find(v => v.identifier === 'tier' || v.identifier === 'plan');
    expect(violation).toBeDefined();
    expect(violation!.owner).toBe('edge-auth');
    expect(violation!.sensitivity).toBe('billing_critical');
  });
});

import { describe, it, expect } from 'vitest';
import type { CharterPackageDescriptor, PackageDoctorCheck, SchemaValidator } from '../index';

// ---------------------------------------------------------------------------
// Structural type tests — verify the interface can be implemented
// ---------------------------------------------------------------------------

describe('CharterPackageDescriptor interface', () => {
  it('can be implemented with minimal required fields', () => {
    const mockSchema: SchemaValidator<{ primary: string }> = {
      parse(input: unknown) {
        if (typeof input !== 'object' || input === null || !('primary' in input)) {
          throw new Error('invalid');
        }
        return input as { primary: string };
      },
      safeParse(input: unknown) {
        try {
          return { success: true as const, data: this.parse(input) };
        } catch (error) {
          return { success: false as const, error };
        }
      },
    };

    const descriptor: CharterPackageDescriptor<{ primary: string }> = {
      name: '@stackbilt/llm-providers',
      description: 'Multi-LLM failover with circuit breakers',
      npmPackage: '@stackbilt/llm-providers',
      configSchema: mockSchema,
    };

    expect(descriptor.name).toBe('@stackbilt/llm-providers');
    expect(descriptor.description).toContain('LLM');
    expect(descriptor.npmPackage).toBe('@stackbilt/llm-providers');
    expect(descriptor.scaffoldTemplates).toBeUndefined();
    expect(descriptor.adfModule).toBeUndefined();
    expect(descriptor.wranglerBindings).toBeUndefined();
  });

  it('can be implemented with all optional fields', () => {
    const check: PackageDoctorCheck = {
      name: 'AI binding',
      run: async (_config, _repoPath) => null,
    };

    const mockSchema: SchemaValidator = {
      parse: (i: unknown) => i,
      safeParse: (i: unknown) => ({ success: true as const, data: i }),
    };

    const descriptor: CharterPackageDescriptor = {
      name: '@stackbilt/contracts',
      description: 'ODD contract ontology',
      npmPackage: '@stackbilt/contracts',
      configSchema: mockSchema,
      scaffoldTemplates: ['templates/worker.ts.tpl'],
      adfModule: 'adf/contracts.adf',
      doctorChecks: [check],
      wranglerBindings: ['AI', 'CONTRACTS_KV'],
    };

    expect(descriptor.scaffoldTemplates).toHaveLength(1);
    expect(descriptor.doctorChecks).toHaveLength(1);
    expect(descriptor.wranglerBindings).toContain('AI');
  });

  it('SchemaValidator.safeParse returns typed result', () => {
    const schema: SchemaValidator<number> = {
      parse(input: unknown) {
        if (typeof input !== 'number') throw new Error('not a number');
        return input;
      },
      safeParse(input: unknown) {
        try {
          return { success: true as const, data: this.parse(input) };
        } catch (error) {
          return { success: false as const, error };
        }
      },
    };

    const ok = schema.safeParse(42);
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toBe(42);

    const fail = schema.safeParse('not-a-number');
    expect(fail.success).toBe(false);
  });

  it('PackageDoctorCheck.run returns null on pass', async () => {
    const check: PackageDoctorCheck = {
      name: 'wrangler AI binding',
      run: async (_config, _repoPath) => {
        // pretend the binding exists
        return null;
      },
    };

    const result = await check.run({}, '/some/repo');
    expect(result).toBeNull();
  });

  it('PackageDoctorCheck.run returns a message on failure', async () => {
    const check: PackageDoctorCheck = {
      name: 'wrangler AI binding',
      run: async (_config, _repoPath) => {
        return 'AI binding not found in wrangler.toml';
      },
    };

    const result = await check.run({}, '/some/repo');
    expect(typeof result).toBe('string');
    expect(result).toContain('AI binding');
  });
});

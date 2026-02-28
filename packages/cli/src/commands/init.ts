/**
 * charter init
 *
 * Scaffolds the .charter/ directory with default config and example patterns.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { getDefaultConfigJSON } from '../config';

export type StackPreset = 'worker' | 'frontend' | 'backend' | 'fullstack';

const PATTERN_TEMPLATES: Record<StackPreset, unknown[]> = {
  worker: [
    {
      name: 'Edge Compute',
      category: 'COMPUTE',
      blessed_solution: 'Cloudflare Workers for edge compute',
      rationale: 'Low-latency runtime close to users',
      anti_patterns: 'Avoid express/fastify for new edge services',
      status: 'ACTIVE',
    },
    {
      name: 'Edge Data',
      category: 'DATA',
      blessed_solution: 'Cloudflare D1 for transactional edge data',
      rationale: 'Co-located data with worker runtime',
      anti_patterns: 'Avoid direct pg/mysql clients in edge handlers',
      status: 'ACTIVE',
    },
    {
      name: 'Queue Processing',
      category: 'ASYNC',
      blessed_solution: 'Cloudflare Queues for asynchronous workloads',
      rationale: 'Durable retries for non-request work',
      anti_patterns: 'Avoid long-running synchronous request chains',
      status: 'ACTIVE',
    },
    {
      name: 'Edge Security',
      category: 'SECURITY',
      blessed_solution: 'Token-based auth with scoped service bindings',
      rationale: 'Limits blast radius across edge services',
      anti_patterns: 'Avoid shared hardcoded secrets across handlers',
      status: 'ACTIVE',
    },
  ],
  frontend: [
    {
      name: 'Frontend Runtime',
      category: 'COMPUTE',
      blessed_solution: 'React/Vite or Next.js for UI runtime',
      rationale: 'Stable frontend delivery and ecosystem support',
      anti_patterns: 'Avoid ad-hoc SPA bootstraps without build pipeline',
      status: 'ACTIVE',
    },
    {
      name: 'State Management',
      category: 'INTEGRATION',
      blessed_solution: 'Centralized client state (Zustand/Redux)',
      rationale: 'Predictable UI state transitions',
      anti_patterns: 'Avoid deeply nested ad-hoc local state trees',
      status: 'ACTIVE',
    },
    {
      name: 'API Contract Layer',
      category: 'INTEGRATION',
      blessed_solution: 'Typed API client boundary module',
      rationale: 'Prevents request shape drift across pages',
      anti_patterns: 'Avoid raw fetch calls scattered across components',
      status: 'ACTIVE',
    },
    {
      name: 'Frontend Security',
      category: 'SECURITY',
      blessed_solution: 'HTTP-only session + CSRF-aware mutation flows',
      rationale: 'Mitigates token leakage and unsafe writes',
      anti_patterns: 'Avoid storing auth tokens in localStorage',
      status: 'ACTIVE',
    },
  ],
  backend: [
    {
      name: 'Service Runtime',
      category: 'COMPUTE',
      blessed_solution: 'Node service runtime with typed request boundaries',
      rationale: 'Operationally stable API execution model',
      anti_patterns: 'Avoid implicit any/unknown request payload parsing',
      status: 'ACTIVE',
    },
    {
      name: 'Data Access Layer',
      category: 'DATA',
      blessed_solution: 'Repository/service abstraction around DB operations',
      rationale: 'Centralizes schema and migration safety',
      anti_patterns: 'Avoid direct SQL calls spread across handlers',
      status: 'ACTIVE',
    },
    {
      name: 'Async Jobs',
      category: 'ASYNC',
      blessed_solution: 'Queue-backed workers for retries and background work',
      rationale: 'Improves resilience of non-critical tasks',
      anti_patterns: 'Avoid blocking API requests on batch/background tasks',
      status: 'ACTIVE',
    },
    {
      name: 'API Security',
      category: 'SECURITY',
      blessed_solution: 'Scoped auth middleware and service-level authorization',
      rationale: 'Consistent access control across endpoints',
      anti_patterns: 'Avoid route-specific ad-hoc authorization logic',
      status: 'ACTIVE',
    },
  ],
  fullstack: [
    {
      name: 'App Runtime Split',
      category: 'COMPUTE',
      blessed_solution: 'Frontend app plus API service/edge runtime split',
      rationale: 'Clear ownership between UI and backend concerns',
      anti_patterns: 'Avoid coupling frontend state logic directly to DB models',
      status: 'ACTIVE',
    },
    {
      name: 'Primary Data Store',
      category: 'DATA',
      blessed_solution: 'Single primary transactional data layer with migrations',
      rationale: 'Consistent source of truth for read/write paths',
      anti_patterns: 'Avoid duplicating write sources across multiple stores',
      status: 'ACTIVE',
    },
    {
      name: 'API Integration Boundary',
      category: 'INTEGRATION',
      blessed_solution: 'Typed API client/server contracts',
      rationale: 'Reduces interface drift between frontend and backend',
      anti_patterns: 'Avoid undocumented cross-layer payload assumptions',
      status: 'ACTIVE',
    },
    {
      name: 'Background Processing',
      category: 'ASYNC',
      blessed_solution: 'Queue/job model for notifications and batch workflows',
      rationale: 'Protects user-facing latency from long-running tasks',
      anti_patterns: 'Avoid synchronous execution of retry-prone integrations',
      status: 'ACTIVE',
    },
    {
      name: 'Security Baseline',
      category: 'SECURITY',
      blessed_solution: 'Centralized authn/authz and secret management policy',
      rationale: 'Consistent controls across frontend/backend surfaces',
      anti_patterns: 'Avoid mixed auth patterns across services and clients',
      status: 'ACTIVE',
    },
  ],
};

const DEFAULT_POLICY_CONTENT = `# Governance Policy

## Commit Trailers

High-risk commits (migrations, handlers, services) should include:

\`\`\`
Governed-By: <ADR-ID or ledger entry reference>
Resolves-Request: <governance request ID>
\`\`\`

Keep governance trailers in one contiguous block at the end of the commit message.
Do not insert a blank line between governance trailers and other trailers like Co-Authored-By.

## Change Classification

Changes are classified as:
- **SURFACE**: Docs, comments, naming - no code logic
- **LOCAL**: Single service, contained impact
- **CROSS_CUTTING**: Multiple services, data model, API contracts

## Exception Path

Use documented exception requests when policy cannot be applied directly.
Capture waiver reason, approver, and expiration.

## Escalation & Approval

Cross-cutting changes require architectural review before merge.
Escalate ambiguous or high-risk decisions for explicit approval.

## Agent Standards Compatibility

If repository-level agent standards exist (for example \`AGENTS.md\`, \`CLAUDE.md\`, \`GEMINI.md\`), Charter policy is complementary and does not override those files.
Keep governance workflows aligned across all active agent instruction standards.
`;

const GITIGNORE_CONTENT = `# Charter local state
.cache/
`;

interface InitResult {
  created: boolean;
  configPath: string;
  files: string[];
  writesPerformed: number;
}

interface InitializeOptions {
  projectName?: string;
  preset?: StackPreset;
  features?: {
    cloudflare?: boolean;
    hono?: boolean;
    react?: boolean;
    vite?: boolean;
  };
}

export async function initCommand(options: CLIOptions, args: string[] = []): Promise<number> {
  const force = options.yes || args.includes('--force');
  const presetFlag = getFlag(args, '--preset');
  const preset = isValidPreset(presetFlag) ? presetFlag : undefined;
  const result = initializeCharter(options.configPath, force, { preset });

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return EXIT_CODE.SUCCESS;
  }

  if (!result.created) {
    console.log(`  .charter/ already exists at ${result.configPath}`);
    console.log('  Use --config <path> for a different location, or --force to overwrite templates.');
    return EXIT_CODE.SUCCESS;
  }

  console.log(`  Initialized .charter/ at ${result.configPath}/`);
  console.log('');
  console.log('  Created:');
  for (const file of result.files) {
    console.log(`    ${file}`);
  }
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Edit config.json with your project name and thresholds');
  console.log('    2. Define your blessed stack in patterns/*.json');
  console.log('    3. Run: charter validate');

  return EXIT_CODE.SUCCESS;
}

export function initializeCharter(configDir: string, force: boolean, initOptions: InitializeOptions = {}): InitResult {
  const configFile = path.join(configDir, 'config.json');
  const exists = fs.existsSync(configFile);

  if (exists && !force) {
    return {
      created: false,
      configPath: configDir,
      files: [],
      writesPerformed: 0,
    };
  }

  const dirs = [configDir, path.join(configDir, 'patterns'), path.join(configDir, 'policies')];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const selectedPreset = initOptions.preset || 'fullstack';
  const patterns = buildPatternTemplate(selectedPreset, initOptions.features);
  let writesPerformed = 0;
  if (writeIfChanged(configFile, getDefaultConfigJSON(initOptions.projectName) + '\n')) writesPerformed++;
  if (writeIfChanged(path.join(configDir, 'patterns', 'blessed-stack.json'), JSON.stringify(patterns, null, 2) + '\n')) writesPerformed++;
  if (writeIfChanged(path.join(configDir, 'policies', 'governance.md'), DEFAULT_POLICY_CONTENT)) writesPerformed++;
  if (writeIfChanged(path.join(configDir, '.gitignore'), GITIGNORE_CONTENT)) writesPerformed++;

  return {
    created: !exists,
    configPath: configDir,
    files: [
      'config.json',
      'patterns/blessed-stack.json',
      'policies/governance.md',
      '.gitignore',
    ],
    writesPerformed,
  };
}

function writeIfChanged(targetPath: string, content: string): boolean {
  if (fs.existsSync(targetPath)) {
    const existing = fs.readFileSync(targetPath, 'utf-8');
    if (existing === content) {
      return false;
    }
  }
  fs.writeFileSync(targetPath, content);
  return true;
}

function isValidPreset(value: string | undefined): value is StackPreset {
  return value === 'worker' || value === 'frontend' || value === 'backend' || value === 'fullstack';
}

function buildPatternTemplate(
  preset: StackPreset,
  features: InitializeOptions['features']
): {
  customized: boolean;
  preset: StackPreset;
  generatedAt: string;
  patterns: unknown[];
} {
  const base = JSON.parse(JSON.stringify(PATTERN_TEMPLATES[preset])) as Array<Record<string, string>>;
  const finalize = (items: Array<Record<string, string>>) => ({
    customized: false,
    preset,
    generatedAt: new Date().toISOString(),
    patterns: items,
  });

  if (!features) {
    return finalize(base);
  }

  if (features.cloudflare) {
    base.unshift({
      name: 'Cloudflare Worker Runtime',
      category: 'COMPUTE',
      blessed_solution: 'Cloudflare Workers + Wrangler deployment workflow',
      rationale: 'Cloudflare-native edge execution for APIs and middleware',
      anti_patterns: 'Avoid mixing non-edge runtime assumptions into worker handlers',
      status: 'ACTIVE',
    });
  }

  if (features.hono) {
    base.unshift({
      name: 'Hono API Layer',
      category: 'INTEGRATION',
      blessed_solution: 'Hono route composition for worker/backend APIs',
      rationale: 'Typed lightweight router aligned to edge/server runtimes',
      anti_patterns: 'Avoid ad-hoc route registration patterns per handler file',
      status: 'ACTIVE',
    });
  }

  if (features.react || features.vite) {
    base.unshift({
      name: 'React/Vite Frontend Baseline',
      category: 'COMPUTE',
      blessed_solution: 'React + Vite build/runtime conventions',
      rationale: 'Fast dev feedback and predictable frontend artifact generation',
      anti_patterns: 'Avoid mixed frontend build toolchains in the same app',
      status: 'ACTIVE',
    });
  }

  const dedup = new Map<string, Record<string, string>>();
  for (const pattern of base) {
    dedup.set(pattern.name, pattern);
  }
  return finalize([...dedup.values()]);
}

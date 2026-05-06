/**
 * charter init
 *
 * Scaffolds the .charter/ directory with default config and example patterns.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { getDefaultConfigJSON } from '../config';

export type StackPreset = 'worker' | 'frontend' | 'backend' | 'fullstack' | 'docs';

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
  docs: [
    {
      name: 'Documentation Standards',
      category: 'GOVERNANCE',
      blessed_solution: 'Markdown-first authoring with ADR/RFC conventions',
      rationale: 'Consistent documentation structure across contributors',
      anti_patterns: 'Avoid undocumented decisions or ad-hoc wiki pages',
      status: 'ACTIVE',
    },
    {
      name: 'Decision Records',
      category: 'GOVERNANCE',
      blessed_solution: 'Lightweight ADR format in docs/ or decisions/',
      rationale: 'Preserves architectural rationale over time',
      anti_patterns: 'Avoid verbal-only decisions without written records',
      status: 'ACTIVE',
    },
    {
      name: 'Review Process',
      category: 'GOVERNANCE',
      blessed_solution: 'PR-based review for documentation changes',
      rationale: 'Tracks authorship and enables async review',
      anti_patterns: 'Avoid direct pushes to main for substantive doc changes',
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

const SECURITY_TEMPLATE = `# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| Current release | Yes |

## Reporting a Vulnerability

Please report suspected vulnerabilities privately to the project maintainers.
Do not open a public issue for security-sensitive findings.

Include:
- affected package or service
- reproduction steps or proof of concept
- expected impact
- any known mitigations

Maintainers should acknowledge reports within 3 business days and provide a remediation plan or status update when triage is complete.
`;

const SECURITY_DENY_PATTERNS = {
  customized: false,
  preset: 'security-sensitive',
  generatedAt: '1970-01-01T00:00:00.000Z',
  hardFail: true,
  patterns: [
    {
      id: 'security-deny-timing-compare',
      name: 'Security Deny: Timing-Sensitive Equality',
      category: 'SECURITY',
      blessed_solution: 'Use constant-time comparison helpers for signatures, digests, and tokens.',
      rationale: 'Plain equality on security digests can leak timing information.',
      anti_patterns: 'Avoid `/===\\s*(signature|expected|digest|token)/i` and `/(signature|expected|digest|token)\\s*===/i`.',
      status: 'ACTIVE',
    },
    {
      id: 'security-deny-optional-security-binding',
      name: 'Security Deny: Optional Security Binding Access',
      category: 'SECURITY',
      blessed_solution: 'Fail closed when security-critical bindings are missing.',
      rationale: 'Optional reads on auth/session/token bindings can silently bypass enforcement.',
      anti_patterns: 'Avoid `/\\b(auth|session|token|secret|key)\\w*\\?\\.(get|put)\\s*\\(/i`.',
      status: 'ACTIVE',
    },
    {
      id: 'security-deny-auth-todo',
      name: 'Security Deny: TODO in Security Path',
      category: 'SECURITY',
      blessed_solution: 'Resolve security TODOs before shipping auth, session, or token paths.',
      rationale: 'TODO markers in security-sensitive code tend to become persistent control gaps.',
      anti_patterns: 'Avoid `/TODO.*\\b(auth|session|token|secret|hmac|signature)\\b/i` and `/\\b(auth|session|token|secret|hmac|signature)\\b.*TODO/i`.',
      status: 'ACTIVE',
    },
    {
      id: 'security-deny-token-json-exposure',
      name: 'Security Deny: Token JSON Exposure',
      category: 'SECURITY',
      blessed_solution: 'Return opaque success responses or scoped public metadata instead of raw access tokens.',
      rationale: 'Raw token exposure in JSON responses increases credential leakage risk.',
      anti_patterns: 'Avoid `/c\\.json\\s*\\(\\s*\\{\\s*access_token/i`.',
      status: 'ACTIVE',
    },
  ],
};

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
  securitySensitive?: boolean;
}

export async function initCommand(options: CLIOptions, args: string[] = []): Promise<number> {
  const force = options.yes || args.includes('--force');
  const guided = args.includes('--guided');
  const presetFlag = getFlag(args, '--preset');
  const preset = isValidPreset(presetFlag) ? presetFlag : undefined;
  const securitySensitive = args.includes('--security-sensitive');

  // --guided: interactive mode that asks questions before scaffolding
  if (guided) {
    return guidedInit(options, force);
  }

  const result = initializeCharter(options.configPath, force, { preset, securitySensitive });

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return EXIT_CODE.SUCCESS;
  }

  if (!result.created) {
    console.log('');
    console.log('  .charter/ directory already exists. Run \'charter doctor\' to check for issues.');
    console.log('');
    console.log('  Use --config <path> for a different location, or --force to overwrite templates.');
    return EXIT_CODE.SUCCESS;
  }

  console.log('');
  console.log('  \u2713 Created .charter/ directory');
  console.log('');
  console.log('  Your governance config is ready. Here\'s what was created:');
  console.log('');
  console.log('    config.json              \u2014 Project settings and thresholds');
  console.log('    patterns/blessed-stack.json \u2014 Technology stack patterns (' + (preset || 'fullstack') + ' preset)');
  console.log('    policies/governance.md   \u2014 Commit governance and change classification');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Edit config.json with your project name and thresholds');
  console.log('    2. Customize patterns/blessed-stack.json for your stack');
  console.log('    3. Run \'charter doctor\' to validate your setup');
  console.log('    4. Run \'charter validate\' to check commit governance');
  console.log('');
  console.log('  Tip: Run \'charter adf init\' to also scaffold .ai/ context modules.');
  console.log('');
  console.log('  Docs: https://github.com/Stackbilt-dev/charter');

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
  if (initOptions.securitySensitive) {
    if (writeIfChanged(path.join(configDir, 'patterns', 'security-deny.json'), JSON.stringify(SECURITY_DENY_PATTERNS, null, 2) + '\n')) writesPerformed++;
    if (writeIfChanged('SECURITY.md', SECURITY_TEMPLATE)) writesPerformed++;
  }

  return {
    created: !exists,
    configPath: configDir,
    files: [
      'config.json',
      'patterns/blessed-stack.json',
      'policies/governance.md',
      '.gitignore',
      ...(initOptions.securitySensitive ? ['patterns/security-deny.json', '../SECURITY.md'] : []),
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
  return value === 'worker' || value === 'frontend' || value === 'backend' || value === 'fullstack' || value === 'docs';
}

// ============================================================================
// --guided interactive init
// ============================================================================

function askQuestion(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

const LANGUAGE_PRESET_MAP: Record<string, StackPreset> = {
  typescript: 'fullstack',
  python: 'backend',
  go: 'backend',
  rust: 'backend',
  java: 'backend',
  react: 'frontend',
  vue: 'frontend',
  svelte: 'frontend',
};

async function guidedInit(options: CLIOptions, force: boolean): Promise<number> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('');
    console.log('  Charter guided setup');
    console.log('  --------------------');
    console.log('');

    // Q1: Primary language
    const langAnswer = await askQuestion(
      rl,
      '  What\'s your primary language/framework? (TypeScript, Python, Go, React, etc.) '
    );
    const langKey = langAnswer.toLowerCase().replace(/\s+/g, '');
    const detectedPreset = LANGUAGE_PRESET_MAP[langKey];

    // Q2: Cloudflare Workers
    const cfAnswer = await askQuestion(
      rl,
      '  Do you use Cloudflare Workers? (y/N) '
    );
    const useCloudflare = cfAnswer.toLowerCase() === 'y' || cfAnswer.toLowerCase() === 'yes';

    // Q3: Auth governance
    const authAnswer = await askQuestion(
      rl,
      '  Do you want auth governance patterns? (y/N) '
    );
    const useAuth = authAnswer.toLowerCase() === 'y' || authAnswer.toLowerCase() === 'yes';

    rl.close();

    // Determine preset
    let preset: StackPreset;
    if (useCloudflare) {
      preset = 'worker';
    } else if (detectedPreset) {
      preset = detectedPreset;
    } else {
      preset = 'fullstack';
    }

    const initOpts: InitializeOptions = {
      preset,
      features: {
        cloudflare: useCloudflare,
      },
    };

    const result = initializeCharter(options.configPath, force, initOpts);

    if (options.format === 'json') {
      console.log(JSON.stringify({ ...result, guided: true, preset, useCloudflare, useAuth }, null, 2));
      return EXIT_CODE.SUCCESS;
    }

    if (!result.created) {
      console.log('');
      console.log('  .charter/ directory already exists. Run \'charter doctor\' to check for issues.');
      return EXIT_CODE.SUCCESS;
    }

    // If auth governance was requested, add auth-specific patterns to governance.md
    if (useAuth) {
      const policyPath = path.join(options.configPath, 'policies', 'governance.md');
      if (fs.existsSync(policyPath)) {
        const existing = fs.readFileSync(policyPath, 'utf-8');
        const authPolicy = `
## Auth Governance

Authentication and authorization changes are classified as CROSS_CUTTING.
All auth changes require:
- Explicit review from a security-aware reviewer
- Documented threat model consideration
- Session/token lifecycle validation
`;
        fs.writeFileSync(policyPath, existing + authPolicy);
      }
    }

    console.log('');
    console.log('  \u2713 Created .charter/ directory');
    console.log('');
    console.log('  Configuration:');
    console.log(`    Preset: ${preset}${useCloudflare ? ' (with Cloudflare Workers)' : ''}`);
    if (useAuth) {
      console.log('    Auth governance: enabled');
    }
    console.log('');
    console.log('  Next steps:');
    console.log('    1. Review config.json and patterns/blessed-stack.json');
    console.log('    2. Run \'charter doctor\' to validate your setup');
    console.log('    3. Run \'charter validate\' to check commit governance');
    console.log('');
    console.log('  Docs: https://github.com/Stackbilt-dev/charter');

    return EXIT_CODE.SUCCESS;
  } finally {
    rl.close();
  }
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

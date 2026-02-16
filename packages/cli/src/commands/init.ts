/**
 * charter init
 *
 * Scaffolds the .charter/ directory with default config and example patterns.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { getDefaultConfigJSON } from '../config';

const EXAMPLE_PATTERNS = [
  {
    name: 'Cloudflare Workers',
    category: 'COMPUTE',
    blessed_solution: 'Cloudflare Workers for serverless compute',
    rationale: 'Edge-first architecture for global low-latency',
    anti_patterns: 'Avoid express/fastify for new services - use Workers native fetch handler',
    status: 'ACTIVE',
  },
  {
    name: 'D1 Database',
    category: 'DATA',
    blessed_solution: 'Cloudflare D1 (SQLite at the edge)',
    rationale: 'Co-located with Workers, zero network hop for reads',
    anti_patterns: 'Avoid pg/mysql2/mongoose - use D1 bindings',
    status: 'ACTIVE',
  },
];

const GITIGNORE_CONTENT = `# Charter local state
.cache/
`;

interface InitResult {
  created: boolean;
  configPath: string;
  files: string[];
}

export async function initCommand(options: CLIOptions, args: string[] = []): Promise<number> {
  const force = options.yes || args.includes('--force');
  const result = initializeCharter(options.configPath, force);

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

export function initializeCharter(configDir: string, force: boolean): InitResult {
  const configFile = path.join(configDir, 'config.json');
  const exists = fs.existsSync(configFile);

  if (exists && !force) {
    return {
      created: false,
      configPath: configDir,
      files: [],
    };
  }

  const dirs = [configDir, path.join(configDir, 'patterns'), path.join(configDir, 'policies')];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configFile, getDefaultConfigJSON() + '\n');

  fs.writeFileSync(
    path.join(configDir, 'patterns', 'blessed-stack.json'),
    JSON.stringify(EXAMPLE_PATTERNS, null, 2) + '\n'
  );

  fs.writeFileSync(
    path.join(configDir, 'policies', 'governance.md'),
    `# Governance Policy

## Commit Trailers

High-risk commits (migrations, handlers, services) should include:

\`\`\`
Governed-By: <ADR-ID or ledger entry reference>
Resolves-Request: <governance request ID>
\`\`\`

## Change Classification

Changes are classified as:
- **SURFACE**: Docs, comments, naming - no code logic
- **LOCAL**: Single service, contained impact
- **CROSS_CUTTING**: Multiple services, data model, API contracts

Cross-cutting changes require architectural review before merge.
`
  );

  fs.writeFileSync(path.join(configDir, '.gitignore'), GITIGNORE_CONTENT);

  return {
    created: true,
    configPath: configDir,
    files: [
      'config.json',
      'patterns/blessed-stack.json',
      'policies/governance.md',
      '.gitignore',
    ],
  };
}

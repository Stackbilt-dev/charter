/**
 * charter init
 *
 * Scaffolds the .charter/ directory with default config and example patterns.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { getDefaultConfigJSON } from '../config';

const EXAMPLE_PATTERNS = [
  {
    name: "Cloudflare Workers",
    category: "COMPUTE",
    blessed_solution: "Cloudflare Workers for serverless compute",
    rationale: "Edge-first architecture for global low-latency",
    anti_patterns: "Avoid `express`, `fastify` for new services — use Workers native fetch handler",
    status: "ACTIVE"
  },
  {
    name: "D1 Database",
    category: "DATA",
    blessed_solution: "Cloudflare D1 (SQLite at the edge)",
    rationale: "Co-located with Workers, zero network hop for reads",
    anti_patterns: "Avoid `pg`, `mysql2`, `mongoose` — use D1 bindings",
    status: "ACTIVE"
  }
];

const GITIGNORE_CONTENT = `# Charter local state
.cache/
`;

export async function initCommand(options: CLIOptions): Promise<void> {
  const configDir = options.configPath;

  if (fs.existsSync(path.join(configDir, 'config.json'))) {
    console.log(`  .charter/ already exists at ${configDir}`);
    console.log('  Use --config <path> to specify a different location.');
    return;
  }

  // Create directory structure
  const dirs = [configDir, path.join(configDir, 'patterns'), path.join(configDir, 'policies')];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write config.json
  fs.writeFileSync(path.join(configDir, 'config.json'), getDefaultConfigJSON() + '\n');

  // Write example patterns
  fs.writeFileSync(
    path.join(configDir, 'patterns', 'blessed-stack.json'),
    JSON.stringify(EXAMPLE_PATTERNS, null, 2) + '\n'
  );

  // Write example policy
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
- **SURFACE**: Docs, comments, naming — no code logic
- **LOCAL**: Single service, contained impact
- **CROSS_CUTTING**: Multiple services, data model, API contracts

Cross-cutting changes require architectural review before merge.
`
  );

  // Write .gitignore for the config dir
  fs.writeFileSync(path.join(configDir, '.gitignore'), GITIGNORE_CONTENT);

  console.log(`  Initialized .charter/ at ${configDir}/`);
  console.log('');
  console.log('  Created:');
  console.log('    config.json              Project governance config');
  console.log('    patterns/blessed-stack.json  Example blessed stack patterns');
  console.log('    policies/governance.md   Example governance policy');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Edit config.json with your project name and thresholds');
  console.log('    2. Define your blessed stack in patterns/*.json');
  console.log('    3. Run: charter validate');
}

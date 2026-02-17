/**
 * charter setup
 *
 * One-command bootstrap for local governance checks.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { CLIError } from '../index';
import { EXIT_CODE } from '../index';
import { initializeCharter } from './init';

const GITHUB_WORKFLOW = `name: Governance Check

on:
  pull_request:
    branches: [main, master]

permissions:
  contents: read
  pull-requests: write

jobs:
  governance:
    name: Charter
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Charter CLI
        run: npm install -g @stackbilt/cli

      - name: Validate Commits
        run: charter validate --ci --format text

      - name: Drift Scan
        run: charter drift --ci --format text

      - name: Audit Report
        run: charter audit --format json > /tmp/audit.json
        if: always()
`;

interface SetupResult {
  configPath: string;
  initialized: boolean;
  workflow: {
    mode: 'none' | 'github';
    path?: string;
    created?: boolean;
  };
}

export async function setupCommand(options: CLIOptions, args: string[]): Promise<number> {
  const ciMode = getFlag(args, '--ci');

  if (ciMode && ciMode !== 'github') {
    throw new CLIError(`Unsupported CI target: ${ciMode}. Supported: github`);
  }

  const initResult = initializeCharter(options.configPath, options.yes || args.includes('--force'));
  const result: SetupResult = {
    configPath: options.configPath,
    initialized: initResult.created,
    workflow: {
      mode: ciMode === 'github' ? 'github' : 'none',
    },
  };

  if (ciMode === 'github') {
    const workflowPath = path.join('.github', 'workflows', 'charter-governance.yml');
    const created = writeFileIfMissing(workflowPath, GITHUB_WORKFLOW, options.yes || args.includes('--force'));

    result.workflow = {
      mode: 'github',
      path: workflowPath,
      created,
    };
  }

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return EXIT_CODE.SUCCESS;
  }

  console.log('  Charter setup complete.');
  console.log(`  Config path: ${result.configPath}`);
  console.log(`  .charter initialized: ${result.initialized ? 'yes' : 'already present'}`);

  if (result.workflow.mode === 'github') {
    console.log(`  GitHub workflow: ${result.workflow.created ? 'created' : 'already present'} (${result.workflow.path})`);
  }

  console.log('');
  console.log('  Next steps:');
  console.log('    1. Run: charter validate --format text');
  console.log('    2. Run: charter drift --format text');
  console.log('    3. Tune .charter/config.json and patterns/*.json');

  return EXIT_CODE.SUCCESS;
}

function writeFileIfMissing(targetPath: string, content: string, force: boolean): boolean {
  const absolute = path.resolve(targetPath);
  const exists = fs.existsSync(absolute);

  if (exists && !force) {
    return false;
  }

  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return true;
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

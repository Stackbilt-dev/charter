/**
 * Charter CLI
 *
 * Config-driven governance checks that run locally and in CI.
 * Zero cloud dependency — works fully offline.
 */

import { initCommand } from './commands/init';
import { validateCommand } from './commands/validate';
import { auditCommand } from './commands/audit';
import { driftCommand } from './commands/drift';
import { classifyCommand } from './commands/classify';

const HELP = `
charter — repo-level governance toolkit

Usage:
  charter init                  Scaffold .charter/ config directory
  charter validate              Validate git commits for governance trailers
  charter audit                 Generate governance audit report
  charter drift [--path <dir>]  Scan files for pattern drift
  charter classify <subject>    Classify a change (SURFACE/LOCAL/CROSS_CUTTING)
  charter --help                Show this help
  charter --version             Show version

Options:
  --config <path>    Path to .charter/ directory (default: .charter/)
  --format <type>    Output format: text, json (default: text)
  --ci               CI mode: exit non-zero on WARN or FAIL
`;

export interface CLIOptions {
  configPath: string;
  format: 'text' | 'json';
  ciMode: boolean;
}

export async function run(args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log('charter v0.1.0');
    return;
  }

  const command = args[0];
  const restArgs = args.slice(1);

  // Parse global options
  const options: CLIOptions = {
    configPath: getFlag(restArgs, '--config') || '.charter',
    format: (getFlag(restArgs, '--format') || 'text') as 'text' | 'json',
    ciMode: restArgs.includes('--ci'),
  };

  switch (command) {
    case 'init':
      await initCommand(options);
      break;
    case 'validate':
      await validateCommand(options, restArgs);
      break;
    case 'audit':
      await auditCommand(options);
      break;
    case 'drift':
      await driftCommand(options, restArgs);
      break;
    case 'classify':
      await classifyCommand(options, restArgs);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

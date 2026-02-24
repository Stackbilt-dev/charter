/**
 * Charter CLI
 *
 * Config-driven governance checks that run locally and in CI.
 * Zero cloud dependency - works fully offline.
 */

import { initCommand } from './commands/init';
import { setupCommand } from './commands/setup';
import { doctorCommand } from './commands/doctor';
import { validateCommand } from './commands/validate';
import { auditCommand } from './commands/audit';
import { driftCommand } from './commands/drift';
import { classifyCommand } from './commands/classify';
import { quickstartCommand, whyCommand } from './commands/why';
import { hookCommand } from './commands/hook';
import { adfCommand } from './commands/adf';
import packageJson from '../package.json';

const CLI_VERSION = packageJson.version;

const HELP = `
charter - repo-level governance toolkit

Usage:
  charter                          Show immediate governance value + risk snapshot
  charter setup [--ci github] [--preset <worker|frontend|backend|fullstack>] [--detect-only] [--no-dependency-sync]
                                   Bootstrap .charter/ and optional CI workflow
  charter init [--preset <worker|frontend|backend|fullstack>]
                                   Scaffold .charter/ config directory
  charter validate [--range <revset>]
                                   Validate git commits for governance trailers
  charter audit [--range <revset>]
                                   Generate governance audit report
  charter drift [--path <dir>]     Scan files for pattern drift
  charter classify <subject>       Classify a change (SURFACE/LOCAL/CROSS_CUTTING)
  charter hook install --commit-msg
                                   Install git commit-msg hook for trailer normalization
  charter adf <subcommand>         ADF context format tools (init, fmt, patch, bundle)
  charter why                      Explain why teams adopt Charter and expected ROI
  charter doctor                   Check CLI + config health
  charter --help                   Show this help
  charter --version                Show version

Options:
  --config <path>    Path to .charter/ directory (default: .charter/)
  --format <type>    Output format: text, json (default: text)
  --ci               CI mode: exit non-zero on WARN or FAIL
  --yes              Auto-accept safe setup overwrites
  --preset <name>    Stack preset: worker, frontend, backend, fullstack
  --detect-only      Setup only: print detected stack/preset and exit
  --no-dependency-sync
                     Setup only: do not rewrite devDependencies["@stackbilt/cli"]
`;

export const EXIT_CODE = {
  SUCCESS: 0,
  POLICY_VIOLATION: 1,
  RUNTIME_ERROR: 2,
} as const;

export class CLIError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = EXIT_CODE.RUNTIME_ERROR
  ) {
    super(message);
    this.name = 'CLIError';
  }
}

export interface CLIOptions {
  configPath: string;
  format: 'text' | 'json';
  ciMode: boolean;
  yes: boolean;
}

export async function run(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return EXIT_CODE.SUCCESS;
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`charter v${CLI_VERSION}`);
    return EXIT_CODE.SUCCESS;
  }

  const format = getFlag(args, '--format') || 'text';
  if (format !== 'text' && format !== 'json') {
    throw new CLIError(`Invalid --format value: ${format}. Use text or json.`);
  }

  const options: CLIOptions = {
    configPath: getFlag(args, '--config') || '.charter',
    format,
    ciMode: args.includes('--ci'),
    yes: args.includes('--yes'),
  };

  if (args.length === 0 || args[0].startsWith('-')) {
    return quickstartCommand(options);
  }

  const command = args[0];
  const restArgs = args.slice(1);

  switch (command) {
    case 'setup':
      return setupCommand(options, restArgs);
    case 'init':
      return initCommand(options, restArgs);
    case 'validate':
      return validateCommand(options, restArgs);
    case 'audit':
      return auditCommand(options, restArgs);
    case 'drift':
      return driftCommand(options, restArgs);
    case 'classify':
      return classifyCommand(options, restArgs);
    case 'why':
      return whyCommand(options);
    case 'doctor':
      return doctorCommand(options);
    case 'hook':
      return hookCommand(options, restArgs);
    case 'adf':
      return adfCommand(options, restArgs);
    default:
      throw new CLIError(`Unknown command: ${command}\n${HELP}`);
  }
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

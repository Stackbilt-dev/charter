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
import { bootstrapCommand } from './commands/bootstrap';
import { telemetryCommand } from './commands/telemetry';
import { recordTelemetryEvent } from './telemetry';
import { getFlag } from './flags';
import packageJson from '../package.json';

const CLI_VERSION = packageJson.version;

const HELP = `
charter - repo-level governance toolkit

Usage:
  charter                          Show immediate governance value + risk snapshot
  charter bootstrap [--ci github] [--preset <name>] [--yes] [--skip-install] [--skip-doctor]
                                   One-command repo onboarding (detect + setup + ADF + install + doctor)
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
  charter hook install --commit-msg [--force]
                                   Install git commit-msg hook for trailer normalization
  charter hook install --pre-commit [--force]
                                   Install git pre-commit hook for ADF evidence gate
  charter adf <subcommand>         ADF context format tools (init, fmt, patch, create, bundle, sync, evidence, migrate, metrics)
  charter telemetry report         Local telemetry summary (passive CLI observability)
  charter why                      Explain why teams adopt Charter and expected ROI
  charter doctor [--adf-only]      Check CLI + config health (or ADF-only wiring checks)
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
  const start = Date.now();
  const configPath = getFlag(args, '--config') || '.charter';
  const rawFormat = getFlag(args, '--format') || 'text';
  const ciMode = args.includes('--ci');
  const yes = args.includes('--yes');

  const writeTelemetry = (exitCode: number, errorName?: string): void => {
    recordTelemetryEvent(configPath, {
      args,
      format: rawFormat,
      ciMode,
      durationMs: Date.now() - start,
      exitCode,
      errorName,
    });
  };

  try {
    if (args.includes('--help') || args.includes('-h')) {
      console.log(HELP);
      writeTelemetry(EXIT_CODE.SUCCESS);
      return EXIT_CODE.SUCCESS;
    }

    if (args.includes('--version') || args.includes('-v')) {
      console.log(`charter v${CLI_VERSION}`);
      writeTelemetry(EXIT_CODE.SUCCESS);
      return EXIT_CODE.SUCCESS;
    }

    if (rawFormat !== 'text' && rawFormat !== 'json') {
      throw new CLIError(`Invalid --format value: ${rawFormat}. Use text or json.`);
    }

    const options: CLIOptions = {
      configPath,
      format: rawFormat,
      ciMode,
      yes,
    };

    let exitCode: number;
    if (args.length === 0 || args[0].startsWith('-')) {
      exitCode = await quickstartCommand(options);
      writeTelemetry(exitCode);
      return exitCode;
    }

    const command = args[0];
    const restArgs = args.slice(1);

    switch (command) {
      case 'bootstrap':
        exitCode = await bootstrapCommand(options, restArgs);
        break;
      case 'setup':
        exitCode = await setupCommand(options, restArgs);
        break;
      case 'init':
        exitCode = await initCommand(options, restArgs);
        break;
      case 'validate':
        exitCode = await validateCommand(options, restArgs);
        break;
      case 'audit':
        exitCode = await auditCommand(options, restArgs);
        break;
      case 'drift':
        exitCode = await driftCommand(options, restArgs);
        break;
      case 'classify':
        exitCode = await classifyCommand(options, restArgs);
        break;
      case 'why':
        exitCode = await whyCommand(options);
        break;
      case 'doctor':
        exitCode = await doctorCommand(options, restArgs);
        break;
      case 'hook':
        exitCode = await hookCommand(options, restArgs);
        break;
      case 'adf':
        exitCode = await adfCommand(options, restArgs);
        break;
      case 'telemetry':
        exitCode = await telemetryCommand(options, restArgs);
        break;
      default:
        throw new CLIError(`Unknown command: ${command}\n${HELP}`);
    }

    writeTelemetry(exitCode);
    return exitCode;
  } catch (err: unknown) {
    const exitCode = err instanceof CLIError ? err.exitCode : EXIT_CODE.RUNTIME_ERROR;
    const errorName = err instanceof Error ? err.name : 'UnknownError';
    writeTelemetry(exitCode, errorName);
    throw err;
  }
}


/**
 * Shared CLI flag helpers.
 *
 * Centralized utilities for parsing positional flags and reading
 * flag-referenced files from CLI argument arrays.
 */

import * as fs from 'node:fs';
import { CLIError } from './index';

/**
 * Extract a named flag's value from an argument array.
 * Returns the string following `flag`, or undefined if not present.
 */
export function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

/**
 * Every value of a repeatable flag, in argument order. An occurrence with no
 * value (the last argument, or followed by another `--flag`) throws CLIError
 * (exit 2) with `missingMessage`, rather than being silently dropped.
 */
export function getFlagValues(args: string[], flag: string, missingMessage: string): string[] {
  const values: string[] = [];
  args.forEach((arg, i) => {
    if (arg !== flag) return;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new CLIError(missingMessage);
    values.push(value);
  });
  return values;
}

/**
 * Read a file referenced by a flag value, throwing CLIError if missing.
 */
export function readFlagFile(filePath: string, flagName: string): string {
  if (!fs.existsSync(filePath)) {
    throw new CLIError(`File not found for ${flagName}: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Tokenize a task prompt into keywords for ADF module resolution.
 * Deduplicated — a repeated word in the prompt (or a caller passing the
 * same task twice) shouldn't count as multiple independent keyword
 * occurrences downstream (e.g. in adf suggest's telemetry analysis).
 */
export function tokenizeTask(task: string): string[] {
  const tokens = task
    .split(/[\s,;:()[\]{}]+/)
    .filter(w => w.length > 1)
    .map(w => w.replace(/[^a-zA-Z0-9]/g, ''));
  return [...new Set(tokens)];
}

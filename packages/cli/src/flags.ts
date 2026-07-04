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

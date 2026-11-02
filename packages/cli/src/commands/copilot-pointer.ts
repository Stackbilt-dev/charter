import * as fs from 'node:fs';
import * as path from 'node:path';

export const COPILOT_INSTRUCTIONS_FILE = '.github/copilot-instructions.md';

/** Resolve at call time: CLI commands and tests may change their working directory. */
export function copilotPointer(aiDir = '.ai'): string {
  const relative = path.relative(path.dirname(path.resolve(COPILOT_INSTRUCTIONS_FILE)), path.resolve(aiDir))
    .split(path.sep).join('/') || '.';
  return `DO NOT add instructions to this file. All project rules are managed in ${relative}/ by Charter (paths are relative to this file).\n` +
    `See ${relative}/manifest.adf for the module routing manifest.\n`;
}

/** Accept an alternate case only when the filesystem resolves it to the canonical file. */
export function isGithubCopilotFile(file: string): boolean {
  const relative = path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/');
  if (relative === COPILOT_INSTRUCTIONS_FILE) return true;
  if (relative.toLowerCase() !== COPILOT_INSTRUCTIONS_FILE) return false;
  try {
    const actual = fs.statSync(path.resolve(file), { bigint: true });
    const canonical = fs.statSync(path.resolve(COPILOT_INSTRUCTIONS_FILE), { bigint: true });
    return actual.ino !== 0n && actual.ino === canonical.ino && actual.dev === canonical.dev;
  } catch {
    return false;
  }
}

/** Shared CLI write guard: a module-index refresh must not mutate unmanaged Copilot through an alias. */
export function isProtectedCopilotAlias(file: string, recordedUnmanaged: boolean, isUnmanaged: (content: string) => boolean): boolean {
  try {
    const target = fs.statSync(path.resolve(file), { bigint: true });
    const canonical = fs.statSync(path.resolve(COPILOT_INSTRUCTIONS_FILE), { bigint: true });
    const same = target.ino && canonical.ino
      ? target.ino === canonical.ino && target.dev === canonical.dev
      : fs.realpathSync.native(path.resolve(file)) === fs.realpathSync.native(path.resolve(COPILOT_INSTRUCTIONS_FILE));
    if (!same) return false;
    if (recordedUnmanaged) return true;
    return isUnmanaged(fs.readFileSync(path.resolve(COPILOT_INSTRUCTIONS_FILE), 'utf-8'));
  } catch {
    return false;
  }
}

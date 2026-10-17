/**
 * Shared by the generated pre-commit hook (hook.ts) and doctor. Kept free of
 * imports so doctor can read it without loading hook.ts and its import graph.
 *
 * HOOK_SCOPED_DOCTOR_ENV is set only by the generated hook while it runs
 * verify:adf. Its value is a token; the hook also writes it to the file
 * hookScopeFileName(token) in the git dir, one file per hook run, and removes
 * that file on exit. Doctor skips the vendor bloat check (reported as INFO) only
 * when the file for the token exists and holds it, so the variable alone, as a
 * CI misconfiguration might set it, does nothing. See hookAlreadyCheckedBloat in doctor.ts.
 */
export const HOOK_SCOPED_DOCTOR_ENV = 'CHARTER_HOOK_SCOPED_DOCTOR';
/** File name prefix passed to `git rev-parse --git-path`; the token follows a dash. */
export const HOOK_SCOPED_DOCTOR_FILE = 'charter-hook-scoped-doctor';

/** The hook's tokens are `<pid>-<epoch seconds>`; anything else is rejected, never used as a path. */
const TOKEN_PATTERN = /^[0-9]{1,10}-[0-9]{1,12}$/;

/** The per-run file name for a token, or undefined when the token is not one the hook makes. */
export function hookScopeFileName(token: string): string | undefined {
  return TOKEN_PATTERN.test(token) ? `${HOOK_SCOPED_DOCTOR_FILE}-${token}` : undefined;
}

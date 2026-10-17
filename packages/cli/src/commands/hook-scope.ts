/**
 * Shared by the generated pre-commit hook (hook.ts) and doctor. Kept free of
 * imports so doctor can read it without loading hook.ts and its import graph.
 *
 * HOOK_SCOPED_DOCTOR_ENV is set only by the generated hook while it runs
 * verify:adf. Its value is a token the hook also writes to HOOK_SCOPED_DOCTOR_FILE
 * in the git dir and removes on exit; doctor skips the vendor bloat check
 * (reported as INFO) only when the two match, so the variable alone, as a CI
 * misconfiguration might set it, does nothing. See hookAlreadyCheckedBloat in doctor.ts.
 */
export const HOOK_SCOPED_DOCTOR_ENV = 'CHARTER_HOOK_SCOPED_DOCTOR';
/** File name passed to `git rev-parse --git-path`. */
export const HOOK_SCOPED_DOCTOR_FILE = 'charter-hook-scoped-doctor';

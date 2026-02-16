/**
 * Error sanitization utilities.
 * Prevents leaking internal details in error messages.
 */

/**
 * Safe error messages for known error patterns.
 * Maps internal error indicators to user-friendly messages.
 */
const SAFE_ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/SQLITE_CONSTRAINT/i, 'Database constraint violated'],
  [/SQLITE_BUSY/i, 'Database temporarily unavailable'],
  [/SQLITE_FULL/i, 'Storage limit exceeded'],
  [/SQLITE_ERROR/i, 'Database error'],
  [/network|fetch failed|connection/i, 'Network error - please retry'],
  [/timeout|timed out/i, 'Request timed out'],
  [/rate limit/i, 'Rate limit exceeded'],
  [/invalid.*json|json.*parse/i, 'Invalid request format'],
  [/not found/i, 'Resource not found'],
  [/unauthorized|authentication/i, 'Authentication required'],
  [/forbidden|permission/i, 'Permission denied'],
];

/**
 * Sanitize error messages for external display.
 * Logs full error internally, returns safe message externally.
 */
export function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  // Check for known safe patterns
  for (const [pattern, safeMessage] of SAFE_ERROR_PATTERNS) {
    if (pattern.test(raw)) {
      return safeMessage;
    }
  }

  // Log full error for debugging (internal only)
  console.error('[Internal Error]', raw);

  // Return generic message for unknown errors
  return 'An internal error occurred. Please try again.';
}

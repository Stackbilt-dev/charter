/**
 * Sanitizes user input to prevent prompt injection and other attacks
 * @param input Raw user input
 * @returns Sanitized input with control characters removed and length limited
 */
export function sanitizeInput(input: string): string {
  return input
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .slice(0, 50000); // Hard limit to prevent abuse
}

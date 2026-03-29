/**
 * Charter Sentinel Detection — prevents charter from re-ingesting its own output.
 *
 * Charter-managed blocks are delimited by HTML comment sentinels:
 *   <!-- charter:<name>:start --> ... <!-- charter:<name>:end -->
 *
 * These blocks must be excluded from classification, keyword scanning, and
 * bloat detection so that migrate/tidy/doctor don't treat charter's own
 * rendered output as user-authored content.
 */

/** Regex matching a charter sentinel start tag. */
const SENTINEL_START = /^<!--\s*charter:[a-z0-9_-]+:start\s*-->$/;

/** Regex matching a charter sentinel end tag. */
const SENTINEL_END = /^<!--\s*charter:[a-z0-9_-]+:end\s*-->$/;

/**
 * Strip all charter-managed sentinel blocks from content.
 *
 * Removes everything between matching `<!-- charter:*:start -->` and
 * `<!-- charter:*:end -->` comment pairs, inclusive of the sentinel lines.
 * Unmatched start sentinels strip to EOF. Handles multiple blocks.
 */
export function stripCharterSentinels(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inSentinel = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inSentinel && SENTINEL_START.test(trimmed)) {
      inSentinel = true;
      continue;
    }

    if (inSentinel && SENTINEL_END.test(trimmed)) {
      inSentinel = false;
      continue;
    }

    if (!inSentinel) {
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * Test whether a line is a charter sentinel marker (start or end).
 */
export function isCharterSentinel(line: string): boolean {
  const trimmed = line.trim();
  return SENTINEL_START.test(trimmed) || SENTINEL_END.test(trimmed);
}

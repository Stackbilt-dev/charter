/**
 * Git Trailer Parsing
 *
 * Parses governance trailers from commit messages.
 * Supports: Governed-By, Resolves-Request
 *
 * Extracted from Charter Cloud (RFC-2025-004).
 */

import type { GitCommit } from '@stackbilt/types';

interface ParsedTrailers {
  governedBy: Array<{ commitSha: string; reference: string }>;
  resolvesRequest: Array<{ commitSha: string; reference: string }>;
}

/**
 * Parse governance trailers from a single commit message.
 */
export function parseTrailersFromMessage(commitSha: string, message: string): ParsedTrailers {
  const result: ParsedTrailers = {
    governedBy: [],
    resolvesRequest: []
  };

  const lines = extractTerminalTrailerBlockLines(message);

  for (const line of lines) {
    const governedByMatch = line.match(/^Governed-By:\s*(.+)$/i);
    if (governedByMatch) {
      result.governedBy.push({
        commitSha,
        reference: governedByMatch[1].trim()
      });
    }

    const resolvesMatch = line.match(/^Resolves-Request:\s*(.+)$/i);
    if (resolvesMatch) {
      result.resolvesRequest.push({
        commitSha,
        reference: resolvesMatch[1].trim()
      });
    }
  }

  return result;
}

function extractTerminalTrailerBlockLines(message: string): string[] {
  const normalized = message.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const trailerLines: string[] = [];

  let idx = lines.length - 1;
  while (idx >= 0 && lines[idx].trim() === '') {
    idx--;
  }

  for (; idx >= 0; idx--) {
    const line = lines[idx];
    if (line.trim() === '') {
      break;
    }
    if (!/^[A-Za-z][A-Za-z0-9-]*:\s*.+$/.test(line)) {
      break;
    }
    trailerLines.push(line);
  }

  return trailerLines.reverse();
}

/**
 * Parse trailers from all commits in a PR.
 */
export function parseAllTrailers(commits: GitCommit[]): ParsedTrailers {
  const combined: ParsedTrailers = {
    governedBy: [],
    resolvesRequest: []
  };

  for (const commit of commits) {
    const parsed = parseTrailersFromMessage(commit.sha, commit.message);
    combined.governedBy.push(...parsed.governedBy);
    combined.resolvesRequest.push(...parsed.resolvesRequest);
  }

  return combined;
}

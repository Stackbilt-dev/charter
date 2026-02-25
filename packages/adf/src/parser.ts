/**
 * ADF Parser — tolerant parsing of ADF documents to AST.
 *
 * Handles messy LLM-generated output gracefully: missing version lines,
 * inconsistent emoji decorations, mixed content types.
 */

import type { AdfDocument, AdfSection, AdfContent, AdfMapEntry, AdfMetricEntry } from './types';
import { AdfParseError } from './errors';

// Matches section headers: optional emoji + UPPERCASE_KEY: optional inline value
// Optional weight annotation: [load-bearing] or [advisory]
// Emoji is any Emoji_Presentation or Extended_Pictographic codepoint
const SECTION_HEADER_RE = /^(?:(\p{Emoji_Presentation}|\p{Extended_Pictographic})\uFE0F?\s+)?([A-Z][A-Z0-9_]*)\s*(?:\[(load-bearing|advisory)\]\s*)?:\s*(.*)$/u;
const VERSION_RE = /^ADF\s*:\s*(.+)$/i;
const LIST_ITEM_RE = /^\s*-\s+(.*)$/;
const MAP_ENTRY_RE = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*(.*)$/;
const METRIC_ENTRY_RE = /^\s*([a-z][a-z0-9_]*)\s*:\s*(-?[\d.]+)\s*\/\s*(-?[\d.]+)\s*\[([^\]]+)\]\s*$/;

export function parseAdf(input: string): AdfDocument {
  const lines = normalizeInput(input);

  let version: '0.1' = '0.1';
  let startIndex = 0;

  // Extract version line if present
  if (lines.length > 0) {
    const versionMatch = lines[0].match(VERSION_RE);
    if (versionMatch) {
      const rawVersion = versionMatch[1].trim();
      if (rawVersion !== '0.1') {
        throw new AdfParseError(`Unsupported ADF version: ${rawVersion}`, 1);
      }
      version = '0.1';
      startIndex = 1;
    }
  }

  const sections = parseSections(lines, startIndex);

  return { version, sections };
}

function normalizeInput(input: string): string[] {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trimEnd());
}

interface RawSection {
  key: string;
  decoration: string | null;
  weight: 'load-bearing' | 'advisory' | undefined;
  inlineValue: string;
  bodyLines: string[];
  lineNumber: number;
}

function parseSections(lines: string[], startIndex: number): AdfSection[] {
  const rawSections: RawSection[] = [];
  let current: RawSection | null = null;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];

    // Skip blank lines between sections (not inside body)
    if (line.trim() === '' && current === null) continue;

    const headerMatch = line.match(SECTION_HEADER_RE);
    if (headerMatch) {
      // Finalize previous section
      if (current) {
        rawSections.push(current);
      }
      current = {
        key: headerMatch[2],
        decoration: headerMatch[1] || null,
        weight: (headerMatch[3] as 'load-bearing' | 'advisory' | undefined) || undefined,
        inlineValue: headerMatch[4].trim(),
        bodyLines: [],
        lineNumber: i + 1,
      };
      continue;
    }

    // Indented body line or blank line within section
    if (current !== null) {
      if (line.trim() === '') {
        // Blank line: could be section separator. Peek ahead to decide.
        const nextNonBlank = lines.slice(i + 1).find(l => l.trim() !== '');
        if (nextNonBlank && SECTION_HEADER_RE.test(nextNonBlank)) {
          // Next non-blank is a header — this blank line ends the current section
          rawSections.push(current);
          current = null;
        } else if (nextNonBlank) {
          // Next non-blank is indented content — keep blank in body
          current.bodyLines.push('');
        } else {
          // Trailing blank — finalize
          rawSections.push(current);
          current = null;
        }
      } else {
        current.bodyLines.push(line);
      }
    }
  }

  // Finalize last section
  if (current) {
    rawSections.push(current);
  }

  return rawSections.map(raw => classifySection(raw));
}

function classifySection(raw: RawSection): AdfSection {
  const content = classifyContent(raw.inlineValue, raw.bodyLines);
  const section: AdfSection = {
    key: raw.key,
    decoration: raw.decoration,
    content,
  };
  if (raw.weight) {
    section.weight = raw.weight;
  }
  return section;
}

function classifyContent(inlineValue: string, bodyLines: string[]): AdfContent {
  // Strip leading/trailing empty lines from body
  const trimmedBody = trimBodyLines(bodyLines);

  // If only inline value and no body
  if (trimmedBody.length === 0 && inlineValue) {
    return { type: 'text', value: inlineValue };
  }

  // If no content at all
  if (trimmedBody.length === 0 && !inlineValue) {
    return { type: 'text', value: '' };
  }

  // Check if body lines are all list items (dash-prefixed)
  const dedented = trimmedBody.map(l => dedentLine(l));
  const allList = dedented.every(l => l.trim() === '' || LIST_ITEM_RE.test(l));
  if (allList && dedented.some(l => LIST_ITEM_RE.test(l))) {
    const items: string[] = [];
    for (const line of dedented) {
      const m = line.match(LIST_ITEM_RE);
      if (m) {
        items.push(m[1].trim());
      }
    }
    return { type: 'list', items };
  }

  // Check if body lines are all metric entries (lowercase_key: value / ceiling [unit])
  const allMetric = dedented.every(l => l.trim() === '' || METRIC_ENTRY_RE.test(l));
  if (allMetric && dedented.some(l => METRIC_ENTRY_RE.test(l))) {
    const entries: AdfMetricEntry[] = [];
    for (const line of dedented) {
      const m = line.match(METRIC_ENTRY_RE);
      if (m) {
        entries.push({
          key: m[1],
          value: parseFloat(m[2]),
          ceiling: parseFloat(m[3]),
          unit: m[4].trim(),
        });
      }
    }
    return { type: 'metric', entries };
  }

  // Check if body lines are all KEY: value pairs (map)
  const allMap = dedented.every(l => l.trim() === '' || MAP_ENTRY_RE.test(l));
  if (allMap && dedented.some(l => MAP_ENTRY_RE.test(l))) {
    const entries: AdfMapEntry[] = [];
    for (const line of dedented) {
      const m = line.match(MAP_ENTRY_RE);
      if (m) {
        entries.push({ key: m[1], value: m[2].trim() });
      }
    }
    return { type: 'map', entries };
  }

  // Fallback: text (inline value + body joined)
  const parts: string[] = [];
  if (inlineValue) parts.push(inlineValue);
  if (trimmedBody.length > 0) {
    parts.push(trimmedBody.map(l => dedentLine(l)).join('\n'));
  }
  return { type: 'text', value: parts.join('\n').trim() };
}

function dedentLine(line: string): string {
  // Remove up to 2 spaces of indentation
  if (line.startsWith('  ')) return line.slice(2);
  if (line.startsWith('\t')) return line.slice(1);
  return line;
}

function trimBodyLines(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  let end = lines.length;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

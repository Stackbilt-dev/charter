/**
 * Markdown Section Parser — extracts structured blocks from markdown files.
 *
 * Splits on H2 headings, classifies sub-elements (rules, code blocks, tables, prose),
 * and detects rule strength (imperative vs advisory).
 */

import { stripCharterSentinels } from './sentinels';

// ============================================================================
// Types
// ============================================================================

export type RuleStrength = 'imperative' | 'advisory' | 'neutral';

export type MarkdownElementType = 'rule' | 'code-block' | 'table-row' | 'table-block' | 'prose';

export interface MarkdownElement {
  type: MarkdownElementType;
  content: string;
  /** For rule elements: detected strength */
  strength?: RuleStrength;
  /** For code-block elements: language tag */
  language?: string;
  /** For code-block elements: full block content (multi-line) */
  block?: string;
}

export interface MarkdownSection {
  heading: string;
  elements: MarkdownElement[];
}

/** Optional overrides for rule-strength detection patterns. */
export interface StrengthConfig {
  imperativePatterns?: RegExp[];
  advisoryPatterns?: RegExp[];
}

// ============================================================================
// Strength Detection
// ============================================================================

const IMPERATIVE_PATTERNS: RegExp[] = [
  /\bNEVER\b/,
  /\bALWAYS\b/,
  /\bMUST\b/,
  /\bDO NOT\b/i,
  /\bIMPORTANT\b/,
  /\bCRITICAL\b/,
  /\bREQUIRE[DS]?\b/,
];

const ADVISORY_PATTERNS: RegExp[] = [
  /\bprefer\b/i,
  /\bshould\b/i,
  /\bbias\b/i,
  /\brecommend/i,
  /\bavoid\b/i,
  /\bconsider\b/i,
  /\btry to\b/i,
];

function detectStrength(text: string, config?: StrengthConfig): RuleStrength {
  const imp = config?.imperativePatterns ?? IMPERATIVE_PATTERNS;
  const adv = config?.advisoryPatterns ?? ADVISORY_PATTERNS;
  for (const p of imp) {
    if (p.test(text)) return 'imperative';
  }
  for (const p of adv) {
    if (p.test(text)) return 'advisory';
  }
  return 'neutral';
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse a markdown string into structured sections.
 *
 * Splits on `## ` (H2) headings. Content before the first H2 becomes a
 * "preamble" section with heading "". Within each section, sub-elements
 * are classified as rules, code blocks, table rows, or prose.
 */
export function parseMarkdownSections(input: string, config?: StrengthConfig): MarkdownSection[] {
  // Strip charter-managed sentinel blocks (e.g., module index tables) before
  // parsing so migrate/tidy never classify charter's own rendered output.
  const lines = stripCharterSentinels(input).split('\n');
  const sections: MarkdownSection[] = [];

  let currentHeading = '';
  let currentElements: MarkdownElement[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockLines: string[] = [];
  let tableLines: string[] = [];

  function flushTable(): void {
    if (tableLines.length > 0) {
      const content = tableLines.join('\n');
      currentElements.push({
        type: 'table-block',
        content,
      });
      tableLines = [];
    }
  }

  function flushCodeBlock(): void {
    if (codeBlockLines.length > 0) {
      const block = codeBlockLines.join('\n');
      currentElements.push({
        type: 'code-block',
        content: block,
        language: codeBlockLang,
        block,
      });
      codeBlockLines = [];
      codeBlockLang = '';
    }
  }

  function flushSection(): void {
    flushTable();
    if (inCodeBlock) {
      flushCodeBlock();
      inCodeBlock = false;
    }
    // Only add section if it has content or is not preamble
    if (currentElements.length > 0 || currentHeading !== '') {
      sections.push({ heading: currentHeading, elements: currentElements });
    }
    currentElements = [];
  }

  for (const line of lines) {
    // Code block fence detection
    const fenceMatch = line.match(/^```(\w*)$/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = fenceMatch[1] || '';
        codeBlockLines = [];
      } else {
        flushCodeBlock();
        inCodeBlock = false;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // H2 heading detection
    if (line.startsWith('## ')) {
      flushSection();
      currentHeading = line.slice(3).trim();
      continue;
    }

    // H3+ sub-headings: strip markdown heading syntax, emit as prose
    const subHeadingMatch = line.match(/^(#{3,})\s+(.*)$/);
    if (subHeadingMatch) {
      flushTable();
      currentElements.push({
        type: 'prose',
        content: subHeadingMatch[2],
      });
      continue;
    }

    // Skip H1 headings (title line) — treat as prose if in a section
    if (line.startsWith('# ') && currentHeading === '' && currentElements.length === 0) {
      continue;
    }

    // Rule items: lines starting with `- ` (possibly indented)
    const ruleMatch = line.match(/^\s*-\s+(.*)$/);
    if (ruleMatch) {
      const ruleText = ruleMatch[1];
      currentElements.push({
        type: 'rule',
        content: ruleText,
        strength: detectStrength(ruleText, config),
      });
      continue;
    }

    // Table rows: buffer consecutive `| ... |` lines into a single table-block
    if (/^\s*\|.*\|/.test(line)) {
      tableLines.push(line.trim());
      continue;
    }

    // Non-table line: flush any buffered table lines
    if (tableLines.length > 0) {
      flushTable();
    }

    // Skip blank lines
    if (line.trim() === '') {
      continue;
    }

    // Everything else is prose
    // Accumulate consecutive prose lines
    const lastElement = currentElements[currentElements.length - 1];
    if (lastElement && lastElement.type === 'prose') {
      lastElement.content += '\n' + line;
    } else {
      currentElements.push({
        type: 'prose',
        content: line,
      });
    }
  }

  // Flush remaining
  flushSection();

  return sections;
}

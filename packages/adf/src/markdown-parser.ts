/**
 * Markdown Section Parser — extracts structured blocks from markdown files.
 *
 * Splits on H2 headings, classifies sub-elements (rules, code blocks, tables, prose),
 * and detects rule strength (imperative vs advisory).
 */

// ============================================================================
// Types
// ============================================================================

export type RuleStrength = 'imperative' | 'advisory' | 'neutral';

export type MarkdownElementType = 'rule' | 'code-block' | 'table-row' | 'prose';

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

// ============================================================================
// Strength Detection
// ============================================================================

const IMPERATIVE_PATTERNS = [
  /\bNEVER\b/,
  /\bALWAYS\b/,
  /\bMUST\b/,
  /\bDO NOT\b/i,
  /\bIMPORTANT\b/,
  /\bCRITICAL\b/,
  /\bREQUIRE[DS]?\b/,
];

const ADVISORY_PATTERNS = [
  /\bprefer\b/i,
  /\bshould\b/i,
  /\bbias\b/i,
  /\brecommend/i,
  /\bavoid\b/i,
  /\bconsider\b/i,
  /\btry to\b/i,
];

function detectStrength(text: string): RuleStrength {
  for (const p of IMPERATIVE_PATTERNS) {
    if (p.test(text)) return 'imperative';
  }
  for (const p of ADVISORY_PATTERNS) {
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
export function parseMarkdownSections(input: string): MarkdownSection[] {
  const lines = input.split('\n');
  const sections: MarkdownSection[] = [];

  let currentHeading = '';
  let currentElements: MarkdownElement[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockLines: string[] = [];

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
        strength: detectStrength(ruleText),
      });
      continue;
    }

    // Table rows: lines matching `| ... |`
    if (/^\s*\|.*\|/.test(line)) {
      // Skip separator rows (| --- | --- |)
      if (!/^\s*\|[\s-:|]+\|$/.test(line)) {
        currentElements.push({
          type: 'table-row',
          content: line.trim(),
        });
      }
      continue;
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

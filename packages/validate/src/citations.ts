/**
 * Citation Validator
 *
 * Extracts, validates, and enriches governance citations in text.
 * Supports: [Section X.Y], [ADR-XXX], [RFC-YYYY-XXX], [Pattern: Name], [POLICY-XXX]
 *
 * Pure logic — no database, no LLM, no external dependencies.
 * Extracted from Charter Cloud.
 */

// ============================================================================
// Types
// ============================================================================

export interface CitationViolation {
  citation: string;
  errorType: 'NOT_FOUND_IN_DATABASE' | 'MALFORMED' | 'DEPRECATED';
  suggestion?: string;
}

export interface CitationValidationResult {
  valid: boolean;
  violations: CitationViolation[];
  totalCitations: number;
  validCount: number;
}

export type ValidationStrictness = 'STRICT' | 'WARN' | 'PERMISSIVE';

/** Known-valid citation data for validation */
export interface CitationBundle {
  citationMap: Map<string, unknown>;
  sections: Array<{ sectionId: string; title: string; exhibitId: string }>;
  adrs: Array<{ id: string; title: string }>;
  patterns: Array<{ name: string }>;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate all citations in text against a known citation bundle.
 */
export function validateCitations(
  responseText: string,
  citationBundle: CitationBundle,
  _strictness: ValidationStrictness = 'WARN'
): CitationValidationResult {
  const extracted = extractCitations(responseText);
  const violations: CitationViolation[] = [];

  for (const citation of extracted) {
    if (!citationBundle.citationMap.has(citation)) {
      const suggestion = findClosestMatch(citation, citationBundle.citationMap);
      violations.push({
        citation,
        errorType: 'NOT_FOUND_IN_DATABASE',
        suggestion
      });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    totalCitations: extracted.length,
    validCount: extracted.length - violations.length
  };
}

// ============================================================================
// Extraction
// ============================================================================

/**
 * Extract all governance citations from text.
 *
 * Patterns recognized:
 * - [Section X.Y]
 * - [ADR-XXX]
 * - [RFC-YYYY-XXX]
 * - [Pattern: Name]
 * - [POLICY-XXX]
 */
export function extractCitations(text: string): string[] {
  const patterns = [
    /\[Section (\d+(?:\.\d+)?)\]/gi,
    /\[(ADR-\d{3})\]/gi,
    /\[(RFC-\d{4}-\d{3})\]/gi,
    /\[Pattern: ([^\]]+)\]/gi,
    /\[(POLICY-\d{3})\]/gi
  ];

  const citations = new Set<string>();

  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[0].includes('Section')) {
        citations.add(`Section ${match[1]}`);
      } else if (match[0].includes('Pattern:')) {
        citations.add(`Pattern: ${match[1]}`);
      } else {
        citations.add(match[1]);
      }
    }
  }

  return Array.from(citations);
}

// ============================================================================
// Enrichment
// ============================================================================

/**
 * Enrich citations in text with hyperlinks and metadata icons.
 */
export function enrichCitations(text: string, citationBundle: CitationBundle): string {
  let enriched = text;

  for (const section of citationBundle.sections) {
    const patterns = [
      `[Section ${section.sectionId}]`,
      `**[Section ${section.sectionId}]**`
    ];

    for (const pattern of patterns) {
      if (enriched.includes(pattern)) {
        const link = `/exhibit/${section.exhibitId}#section-${section.sectionId}`;
        const replacement = pattern.includes('**')
          ? `**[Section ${section.sectionId}: ${section.title}](${link})**`
          : `[Section ${section.sectionId}: ${section.title}](${link})`;
        enriched = enriched.replace(new RegExp(escapeRegex(pattern), 'g'), replacement);
      }
    }
  }

  for (const adr of citationBundle.adrs) {
    const match = adr.title.match(/^(ADR-\d{3}|RFC-\d{4}-\d{3})/);
    if (match) {
      const code = match[1];
      const pattern = `[${code}]`;
      if (enriched.includes(pattern)) {
        const link = `/ledger/${adr.id}`;
        const replacement = `[${adr.title}](${link})`;
        enriched = enriched.replace(new RegExp(`\\[${escapeRegex(code)}\\]`, 'g'), replacement);
      }
    }
  }

  for (const pattern of citationBundle.patterns) {
    const citationPattern = `[Pattern: ${pattern.name}]`;
    if (enriched.includes(citationPattern)) {
      const link = `/patterns/${encodeURIComponent(pattern.name)}`;
      const replacement = `[Pattern: ${pattern.name}](${link})`;
      enriched = enriched.replace(new RegExp(escapeRegex(citationPattern), 'g'), replacement);
    }
  }

  return enriched;
}

// ============================================================================
// Helpers
// ============================================================================

function findClosestMatch(citation: string, citationMap: Map<string, unknown>): string | undefined {
  const candidates = Array.from(citationMap.keys());
  let minDistance = Infinity;
  let closest: string | undefined;

  for (const candidate of candidates) {
    const distance = levenshteinDistance(citation.toLowerCase(), candidate.toLowerCase());
    if (distance < minDistance && distance <= 3) {
      minDistance = distance;
      closest = candidate;
    }
  }

  return closest;
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

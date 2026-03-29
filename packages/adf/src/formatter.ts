/**
 * ADF Formatter — emits canonical ADF text from an AST.
 *
 * Strict emission: auto-injects standard emoji decorations,
 * sorts sections by canonical key order, uses 2-space indent.
 * Normalizes structural artifacts from migrate/tidy (#75).
 */

import type { AdfDocument, AdfSection, AdfContent } from './types';
import { STANDARD_DECORATIONS, CANONICAL_KEY_ORDER } from './types';

export function formatAdf(doc: AdfDocument): string {
  const lines: string[] = [];

  lines.push(`ADF: ${doc.version}`);

  const sorted = sortSections(doc.sections).map(normalizeSection);

  for (let i = 0; i < sorted.length; i++) {
    lines.push('');
    const section = sorted[i];
    const decoration = section.decoration ?? STANDARD_DECORATIONS[section.key] ?? null;
    const header = formatHeader(section.key, decoration, section.content, section.weight);
    lines.push(header);

    const bodyLines = formatBody(section.content);
    for (const bodyLine of bodyLines) {
      lines.push(bodyLine);
    }
  }

  return lines.join('\n') + '\n';
}

function sortSections(sections: AdfSection[]): AdfSection[] {
  const orderMap = new Map<string, number>();
  CANONICAL_KEY_ORDER.forEach((key, idx) => orderMap.set(key, idx));

  const canonical: AdfSection[] = [];
  const nonCanonical: AdfSection[] = [];

  for (const section of sections) {
    if (orderMap.has(section.key)) {
      canonical.push(section);
    } else {
      nonCanonical.push(section);
    }
  }

  canonical.sort((a, b) => (orderMap.get(a.key) ?? 0) - (orderMap.get(b.key) ?? 0));

  return [...canonical, ...nonCanonical];
}

function formatHeader(
  key: string,
  decoration: string | null,
  content: AdfContent,
  weight?: 'load-bearing' | 'advisory'
): string {
  const decorPart = decoration ? `${decoration} ` : '';
  const weightPart = weight ? ` [${weight}]` : '';
  const prefix = `${decorPart}${key}${weightPart}:`;

  // For single-line text, put value on same line as header
  if (content.type === 'text' && !content.value.includes('\n') && content.value.length > 0) {
    return `${prefix} ${content.value}`;
  }

  return prefix;
}

function formatBody(content: AdfContent): string[] {
  switch (content.type) {
    case 'text': {
      if (content.value === '' || !content.value.includes('\n')) {
        return [];
      }
      return content.value.split('\n').map(line => `  ${line}`);
    }
    case 'list': {
      return content.items.map(item => `  - ${item}`);
    }
    case 'map': {
      return content.entries.map(entry => `  ${entry.key}: ${entry.value}`);
    }
    case 'metric': {
      return content.entries.map(entry =>
        `  ${entry.key}: ${entry.value} / ${entry.ceiling} [${entry.unit}]`
      );
    }
  }
}

// ============================================================================
// Structural Normalization (#75)
// ============================================================================

/** Collapse duplicate list markers (- - - X → X) in list items. */
function normalizeListItem(item: string): string {
  return item.replace(/^(?:-\s+)+/, '').trim();
}

/** Strip HTML comments from text content. */
function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim();
}

/** Strip markdown table syntax from text content (not valid ADF). */
function stripMarkdownTables(text: string): string {
  return text
    .split('\n')
    .filter(line => !/^\s*\|.*\|/.test(line))
    .join('\n')
    .trim();
}

/** Normalize a section's content to remove migration artifacts. */
function normalizeSection(section: AdfSection): AdfSection {
  const { content } = section;

  switch (content.type) {
    case 'list': {
      const normalized = content.items
        .map(normalizeListItem)
        .filter(item => item.length > 0);
      return { ...section, content: { type: 'list', items: normalized } };
    }
    case 'text': {
      let value = stripHtmlComments(content.value);
      value = stripMarkdownTables(value);
      // Collapse runs of blank lines left by stripping
      value = value.replace(/\n{3,}/g, '\n\n').trim();
      return { ...section, content: { type: 'text', value } };
    }
    default:
      return section;
  }
}

/**
 * ADF Formatter — emits canonical ADF text from an AST.
 *
 * Strict emission: auto-injects standard emoji decorations,
 * sorts sections by canonical key order, uses 2-space indent.
 */

import type { AdfDocument, AdfSection, AdfContent } from './types';
import { STANDARD_DECORATIONS, CANONICAL_KEY_ORDER } from './types';

export function formatAdf(doc: AdfDocument): string {
  const lines: string[] = [];

  lines.push(`ADF: ${doc.version}`);

  const sorted = sortSections(doc.sections);

  for (let i = 0; i < sorted.length; i++) {
    lines.push('');
    const section = sorted[i];
    const decoration = section.decoration ?? STANDARD_DECORATIONS[section.key] ?? null;
    const header = formatHeader(section.key, decoration, section.content);
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

function formatHeader(key: string, decoration: string | null, content: AdfContent): string {
  const prefix = decoration ? `${decoration} ${key}:` : `${key}:`;

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
        // Single-line text is inlined in header — no body
        if (content.value !== '') return [];
        return [];
      }
      // Multi-line text: indent each line
      return content.value.split('\n').map(line => `  ${line}`);
    }
    case 'list': {
      return content.items.map(item => `  - ${item}`);
    }
    case 'map': {
      return content.entries.map(entry => `  ${entry.key}: ${entry.value}`);
    }
  }
}

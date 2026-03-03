/**
 * ADF Merger — pure document merge logic and token estimation.
 *
 * Merges multiple ADF documents into one by combining sections with
 * matching keys. Provides rough token estimation for budget tracking.
 */

import type { AdfDocument, AdfSection } from './types';

// ============================================================================
// Document Merging
// ============================================================================

/**
 * Merge multiple ADF documents into one.
 * Duplicate section keys are merged: lists concatenated, texts joined,
 * maps concatenated, metrics concatenated.
 */
export function mergeDocuments(docs: AdfDocument[]): AdfDocument {
  const sectionMap = new Map<string, AdfSection>();

  for (const doc of docs) {
    for (const section of doc.sections) {
      const existing = sectionMap.get(section.key);
      if (!existing) {
        // Deep clone to avoid mutation
        sectionMap.set(section.key, JSON.parse(JSON.stringify(section)));
      } else {
        mergeSectionContent(existing, section);
      }
    }
  }

  return {
    version: '0.1',
    sections: [...sectionMap.values()],
  };
}

function mergeSectionContent(target: AdfSection, source: AdfSection): void {
  if (target.content.type === 'list' && source.content.type === 'list') {
    target.content.items.push(...source.content.items);
  } else if (target.content.type === 'map' && source.content.type === 'map') {
    target.content.entries.push(...source.content.entries);
  } else if (target.content.type === 'text' && source.content.type === 'text') {
    if (target.content.value && source.content.value) {
      target.content.value = target.content.value + '\n' + source.content.value;
    } else if (source.content.value) {
      target.content.value = source.content.value;
    }
  } else if (target.content.type === 'metric' && source.content.type === 'metric') {
    target.content.entries.push(...source.content.entries);
  }
  // Mismatched types: keep target content as-is (first-wins)

  // Promote weight: if either is load-bearing, result is load-bearing
  if (source.weight === 'load-bearing' || target.weight === 'load-bearing') {
    target.weight = 'load-bearing';
  } else if (source.weight === 'advisory' && !target.weight) {
    target.weight = 'advisory';
  }
}

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Rough token estimate: ~4 chars per token for English text.
 */
export function estimateTokens(doc: AdfDocument): number {
  let charCount = 0;
  for (const section of doc.sections) {
    charCount += section.key.length + 2; // key + colon + space
    switch (section.content.type) {
      case 'text':
        charCount += section.content.value.length;
        break;
      case 'list':
        for (const item of section.content.items) {
          charCount += item.length + 4; // dash + space + newline
        }
        break;
      case 'map':
        for (const entry of section.content.entries) {
          charCount += entry.key.length + entry.value.length + 4;
        }
        break;
      case 'metric':
        for (const entry of section.content.entries) {
          // key: value / ceiling [unit]
          charCount += entry.key.length + String(entry.value).length +
            String(entry.ceiling).length + entry.unit.length + 8;
        }
        break;
    }
  }
  return Math.ceil(charCount / 4);
}

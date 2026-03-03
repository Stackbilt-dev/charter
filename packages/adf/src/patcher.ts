/**
 * ADF Patcher — applies typed delta operations to an ADF document.
 *
 * Immutable: returns a new document; the original is never mutated.
 * Throws AdfPatchError with context on any invalid operation.
 *
 * Operation dispatch uses a keyed handler map instead of a switch so
 * adding a new op type requires only one map entry and one handler.
 */

import type { AdfContent, AdfDocument, AdfMapEntry, AdfSection, PatchOperation } from './types';
import { AdfPatchError } from './errors';

// ============================================================================
// Dispatch
// ============================================================================

export function applyPatches(doc: AdfDocument, ops: PatchOperation[]): AdfDocument {
  // Deep clone for immutability
  let result: AdfDocument = JSON.parse(JSON.stringify(doc));

  for (const op of ops) {
    result = applyOne(result, op);
  }

  return result;
}

const handlers: Record<PatchOperation['op'], (doc: AdfDocument, op: never) => AdfDocument> = {
  ADD_BULLET: (doc, op: { section: string; value: string }) => addBullet(doc, op.section, op.value),
  REPLACE_BULLET: (doc, op: { section: string; index: number; value: string }) => replaceBullet(doc, op.section, op.index, op.value),
  REMOVE_BULLET: (doc, op: { section: string; index: number }) => removeBullet(doc, op.section, op.index),
  ADD_SECTION: (doc, op: { key: string; decoration?: string | null; content: AdfContent; weight?: 'load-bearing' | 'advisory' }) => addSection(doc, op.key, op.decoration ?? null, op.content, op.weight),
  REPLACE_SECTION: (doc, op: { key: string; content: AdfContent }) => replaceSection(doc, op.key, op.content),
  REMOVE_SECTION: (doc, op: { key: string }) => removeSection(doc, op.key),
  UPDATE_METRIC: (doc, op: { section: string; key: string; value: number }) => updateMetric(doc, op.section, op.key, op.value),
};

function applyOne(doc: AdfDocument, op: PatchOperation): AdfDocument {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (handlers[op.op] as any)(doc, op);
}

// ============================================================================
// Shared Helpers
// ============================================================================

function findSection(doc: AdfDocument, key: string, opName: string): AdfSection {
  const section = doc.sections.find(s => s.key === key);
  if (!section) {
    throw new AdfPatchError(`Section "${key}" not found`, opName, key);
  }
  return section;
}

function checkBounds(length: number, index: number, opName: string, sectionKey: string, label: string): void {
  if (index < 0 || index >= length) {
    throw new AdfPatchError(
      `Index ${index} out of bounds (section "${sectionKey}" has ${length} ${label})`,
      opName,
      sectionKey,
      index
    );
  }
}

function parseColonEntry(value: string): AdfMapEntry {
  const colonIndex = value.indexOf(':');
  if (colonIndex > 0) {
    return {
      key: value.slice(0, colonIndex).trim(),
      value: value.slice(colonIndex + 1).trim(),
    };
  }
  return { key: value.trim(), value: '' };
}

// ============================================================================
// Operation Handlers
// ============================================================================

function addBullet(doc: AdfDocument, sectionKey: string, value: string): AdfDocument {
  const section = findSection(doc, sectionKey, 'ADD_BULLET');

  if (section.content.type === 'list') {
    section.content.items.push(value);
  } else if (section.content.type === 'map') {
    section.content.entries.push(parseColonEntry(value));
  } else if (section.content.type === 'text') {
    const existing = section.content.value.trim();
    const items = existing ? [existing, value] : [value];
    (section as { content: AdfContent }).content = { type: 'list', items };
  } else {
    throw new AdfPatchError(
      `Cannot ADD_BULLET to ${section.content.type} section "${sectionKey}". Section must be list, map, or text.`,
      'ADD_BULLET',
      sectionKey
    );
  }

  return doc;
}

function replaceBullet(doc: AdfDocument, sectionKey: string, index: number, value: string): AdfDocument {
  const section = findSection(doc, sectionKey, 'REPLACE_BULLET');

  if (section.content.type === 'list') {
    checkBounds(section.content.items.length, index, 'REPLACE_BULLET', sectionKey, 'items');
    section.content.items[index] = value;
  } else if (section.content.type === 'map') {
    checkBounds(section.content.entries.length, index, 'REPLACE_BULLET', sectionKey, 'entries');
    section.content.entries[index] = parseColonEntry(value);
  } else {
    throw new AdfPatchError(
      `Cannot REPLACE_BULLET in ${section.content.type} section "${sectionKey}". Section must be list or map.`,
      'REPLACE_BULLET',
      sectionKey
    );
  }

  return doc;
}

function removeBullet(doc: AdfDocument, sectionKey: string, index: number): AdfDocument {
  const section = findSection(doc, sectionKey, 'REMOVE_BULLET');

  if (section.content.type === 'list') {
    checkBounds(section.content.items.length, index, 'REMOVE_BULLET', sectionKey, 'items');
    section.content.items.splice(index, 1);
  } else if (section.content.type === 'map') {
    checkBounds(section.content.entries.length, index, 'REMOVE_BULLET', sectionKey, 'entries');
    section.content.entries.splice(index, 1);
  } else {
    throw new AdfPatchError(
      `Cannot REMOVE_BULLET from ${section.content.type} section "${sectionKey}". Section must be list or map.`,
      'REMOVE_BULLET',
      sectionKey
    );
  }

  return doc;
}

function addSection(
  doc: AdfDocument,
  key: string,
  decoration: string | null,
  content: AdfContent,
  weight?: 'load-bearing' | 'advisory'
): AdfDocument {
  const existing = doc.sections.find(s => s.key === key);
  if (existing) {
    throw new AdfPatchError(`Section "${key}" already exists`, 'ADD_SECTION', key);
  }

  const section: AdfSection = { key, decoration, content };
  if (weight) {
    section.weight = weight;
  }
  doc.sections.push(section);
  return doc;
}

function replaceSection(
  doc: AdfDocument,
  key: string,
  content: AdfContent
): AdfDocument {
  const section = findSection(doc, key, 'REPLACE_SECTION');
  section.content = content;
  return doc;
}

function removeSection(doc: AdfDocument, key: string): AdfDocument {
  const idx = doc.sections.findIndex(s => s.key === key);
  if (idx === -1) {
    throw new AdfPatchError(`Section "${key}" not found`, 'REMOVE_SECTION', key);
  }
  doc.sections.splice(idx, 1);
  return doc;
}

function updateMetric(doc: AdfDocument, sectionKey: string, metricKey: string, value: number): AdfDocument {
  const section = findSection(doc, sectionKey, 'UPDATE_METRIC');

  if (section.content.type !== 'metric') {
    throw new AdfPatchError(
      `Cannot UPDATE_METRIC in ${section.content.type} section "${sectionKey}". Section must be metric.`,
      'UPDATE_METRIC',
      sectionKey
    );
  }

  const entry = section.content.entries.find(e => e.key === metricKey);
  if (!entry) {
    throw new AdfPatchError(
      `Metric key "${metricKey}" not found in section "${sectionKey}"`,
      'UPDATE_METRIC',
      sectionKey
    );
  }

  entry.value = value;
  return doc;
}

/**
 * ADF Patcher — applies typed delta operations to an ADF document.
 *
 * Immutable: returns a new document; the original is never mutated.
 * Throws AdfPatchError with context on any invalid operation.
 */

import type { AdfDocument, AdfSection, PatchOperation } from './types';
import { AdfPatchError } from './errors';

export function applyPatches(doc: AdfDocument, ops: PatchOperation[]): AdfDocument {
  // Deep clone for immutability
  let result: AdfDocument = JSON.parse(JSON.stringify(doc));

  for (const op of ops) {
    result = applyOne(result, op);
  }

  return result;
}

function applyOne(doc: AdfDocument, op: PatchOperation): AdfDocument {
  switch (op.op) {
    case 'ADD_BULLET':
      return addBullet(doc, op.section, op.value);
    case 'REPLACE_BULLET':
      return replaceBullet(doc, op.section, op.index, op.value);
    case 'REMOVE_BULLET':
      return removeBullet(doc, op.section, op.index);
    case 'ADD_SECTION':
      return addSection(doc, op.key, op.decoration ?? null, op.content, op.weight);
    case 'REPLACE_SECTION':
      return replaceSection(doc, op.key, op.content);
    case 'REMOVE_SECTION':
      return removeSection(doc, op.key);
    case 'UPDATE_METRIC':
      return updateMetric(doc, op.section, op.key, op.value);
  }
}

function findSection(doc: AdfDocument, key: string, opName: string): AdfSection {
  const section = doc.sections.find(s => s.key === key);
  if (!section) {
    throw new AdfPatchError(`Section "${key}" not found`, opName, key);
  }
  return section;
}

function addBullet(doc: AdfDocument, sectionKey: string, value: string): AdfDocument {
  const section = findSection(doc, sectionKey, 'ADD_BULLET');

  if (section.content.type === 'list') {
    section.content.items.push(value);
  } else if (section.content.type === 'map') {
    // Parse "KEY: value" or treat as key with empty value
    const colonIndex = value.indexOf(':');
    if (colonIndex > 0) {
      section.content.entries.push({
        key: value.slice(0, colonIndex).trim(),
        value: value.slice(colonIndex + 1).trim(),
      });
    } else {
      section.content.entries.push({ key: value.trim(), value: '' });
    }
  } else {
    throw new AdfPatchError(
      `Cannot ADD_BULLET to ${section.content.type} section "${sectionKey}". Section must be list or map.`,
      'ADD_BULLET',
      sectionKey
    );
  }

  return doc;
}

function replaceBullet(doc: AdfDocument, sectionKey: string, index: number, value: string): AdfDocument {
  const section = findSection(doc, sectionKey, 'REPLACE_BULLET');

  if (section.content.type === 'list') {
    if (index < 0 || index >= section.content.items.length) {
      throw new AdfPatchError(
        `Index ${index} out of bounds (section "${sectionKey}" has ${section.content.items.length} items)`,
        'REPLACE_BULLET',
        sectionKey,
        index
      );
    }
    section.content.items[index] = value;
  } else if (section.content.type === 'map') {
    if (index < 0 || index >= section.content.entries.length) {
      throw new AdfPatchError(
        `Index ${index} out of bounds (section "${sectionKey}" has ${section.content.entries.length} entries)`,
        'REPLACE_BULLET',
        sectionKey,
        index
      );
    }
    const colonIndex = value.indexOf(':');
    if (colonIndex > 0) {
      section.content.entries[index] = {
        key: value.slice(0, colonIndex).trim(),
        value: value.slice(colonIndex + 1).trim(),
      };
    } else {
      section.content.entries[index] = { key: value.trim(), value: '' };
    }
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
    if (index < 0 || index >= section.content.items.length) {
      throw new AdfPatchError(
        `Index ${index} out of bounds (section "${sectionKey}" has ${section.content.items.length} items)`,
        'REMOVE_BULLET',
        sectionKey,
        index
      );
    }
    section.content.items.splice(index, 1);
  } else if (section.content.type === 'map') {
    if (index < 0 || index >= section.content.entries.length) {
      throw new AdfPatchError(
        `Index ${index} out of bounds (section "${sectionKey}" has ${section.content.entries.length} entries)`,
        'REMOVE_BULLET',
        sectionKey,
        index
      );
    }
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
  content: import('./types').AdfContent,
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
  content: import('./types').AdfContent
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

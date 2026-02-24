import { describe, it, expect } from 'vitest';
import { applyPatches } from '../patcher';
import type { AdfDocument, PatchOperation } from '../types';

function makeDoc(): AdfDocument {
  return {
    version: '0.1',
    sections: [
      {
        key: 'CONSTRAINTS',
        decoration: null,
        content: { type: 'list', items: ['No deps', 'Stay fast'] },
      },
      {
        key: 'STATE',
        decoration: null,
        content: {
          type: 'map',
          entries: [
            { key: 'CURRENT', value: 'Working' },
            { key: 'NEXT', value: 'Deploy' },
          ],
        },
      },
      {
        key: 'TASK',
        decoration: '\u{1F3AF}',
        content: { type: 'text', value: 'Build feature' },
      },
    ],
  };
}

describe('applyPatches', () => {
  it('ADD_BULLET: appends item to list section', () => {
    const result = applyPatches(makeDoc(), [
      { op: 'ADD_BULLET', section: 'CONSTRAINTS', value: 'No side effects' },
    ]);
    const sec = result.sections.find(s => s.key === 'CONSTRAINTS')!;
    expect(sec.content.type === 'list' && sec.content.items).toEqual([
      'No deps',
      'Stay fast',
      'No side effects',
    ]);
  });

  it('ADD_BULLET: appends entry to map section', () => {
    const result = applyPatches(makeDoc(), [
      { op: 'ADD_BULLET', section: 'STATE', value: 'BLOCKED: Waiting on review' },
    ]);
    const sec = result.sections.find(s => s.key === 'STATE')!;
    expect(sec.content.type === 'map' && sec.content.entries).toHaveLength(3);
  });

  it('REPLACE_BULLET: replaces item in list section', () => {
    const result = applyPatches(makeDoc(), [
      { op: 'REPLACE_BULLET', section: 'CONSTRAINTS', index: 0, value: 'Minimal deps' },
    ]);
    const sec = result.sections.find(s => s.key === 'CONSTRAINTS')!;
    expect(sec.content.type === 'list' && sec.content.items[0]).toBe('Minimal deps');
  });

  it('REPLACE_BULLET: replaces entry in map section', () => {
    const result = applyPatches(makeDoc(), [
      { op: 'REPLACE_BULLET', section: 'STATE', index: 1, value: 'NEXT: Ship it' },
    ]);
    const sec = result.sections.find(s => s.key === 'STATE')!;
    if (sec.content.type === 'map') {
      expect(sec.content.entries[1]).toEqual({ key: 'NEXT', value: 'Ship it' });
    }
  });

  it('REMOVE_BULLET: removes item from list section', () => {
    const result = applyPatches(makeDoc(), [
      { op: 'REMOVE_BULLET', section: 'CONSTRAINTS', index: 0 },
    ]);
    const sec = result.sections.find(s => s.key === 'CONSTRAINTS')!;
    expect(sec.content.type === 'list' && sec.content.items).toEqual(['Stay fast']);
  });

  it('REMOVE_BULLET: removes entry from map section', () => {
    const result = applyPatches(makeDoc(), [
      { op: 'REMOVE_BULLET', section: 'STATE', index: 0 },
    ]);
    const sec = result.sections.find(s => s.key === 'STATE')!;
    expect(sec.content.type === 'map' && sec.content.entries).toHaveLength(1);
  });

  it('ADD_SECTION: adds a new section', () => {
    const result = applyPatches(makeDoc(), [
      {
        op: 'ADD_SECTION',
        key: 'RISKS',
        content: { type: 'list', items: ['Data loss'] },
      },
    ]);
    expect(result.sections.find(s => s.key === 'RISKS')).toBeDefined();
  });

  it('ADD_SECTION: throws on duplicate section', () => {
    expect(() =>
      applyPatches(makeDoc(), [
        {
          op: 'ADD_SECTION',
          key: 'TASK',
          content: { type: 'text', value: 'Dup' },
        },
      ])
    ).toThrow('already exists');
  });

  it('REPLACE_SECTION: replaces section content', () => {
    const result = applyPatches(makeDoc(), [
      {
        op: 'REPLACE_SECTION',
        key: 'TASK',
        content: { type: 'text', value: 'New task' },
      },
    ]);
    const sec = result.sections.find(s => s.key === 'TASK')!;
    expect(sec.content).toEqual({ type: 'text', value: 'New task' });
  });

  it('REMOVE_SECTION: removes a section', () => {
    const result = applyPatches(makeDoc(), [
      { op: 'REMOVE_SECTION', key: 'TASK' },
    ]);
    expect(result.sections.find(s => s.key === 'TASK')).toBeUndefined();
  });

  it('throws when section not found', () => {
    expect(() =>
      applyPatches(makeDoc(), [
        { op: 'ADD_BULLET', section: 'NOPE', value: 'x' },
      ])
    ).toThrow('not found');
  });

  it('throws on index out of bounds', () => {
    expect(() =>
      applyPatches(makeDoc(), [
        { op: 'REPLACE_BULLET', section: 'CONSTRAINTS', index: 99, value: 'x' },
      ])
    ).toThrow('out of bounds');
  });

  it('does not mutate the original document', () => {
    const original = makeDoc();
    const origJson = JSON.stringify(original);
    applyPatches(original, [
      { op: 'ADD_BULLET', section: 'CONSTRAINTS', value: 'Mutate check' },
    ]);
    expect(JSON.stringify(original)).toBe(origJson);
  });

  it('applies multiple ops sequentially', () => {
    const ops: PatchOperation[] = [
      { op: 'ADD_BULLET', section: 'CONSTRAINTS', value: 'Third' },
      { op: 'REMOVE_BULLET', section: 'CONSTRAINTS', index: 0 },
    ];
    const result = applyPatches(makeDoc(), ops);
    const sec = result.sections.find(s => s.key === 'CONSTRAINTS')!;
    expect(sec.content.type === 'list' && sec.content.items).toEqual(['Stay fast', 'Third']);
  });
});

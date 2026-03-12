import { describe, it, expect } from 'vitest';
import { parseMarkdownSections } from '../markdown-parser';

describe('parseMarkdownSections', () => {
  describe('table-block preservation (#51a)', () => {
    it('merges consecutive table rows into a single table-block element', () => {
      const md = `## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/users | List users |
| POST | /api/users | Create user |

Some prose after the table.
`;
      const sections = parseMarkdownSections(md);
      const endpointSection = sections.find(s => s.heading === 'Endpoints');
      expect(endpointSection).toBeDefined();

      const tableBlocks = endpointSection!.elements.filter(e => e.type === 'table-block');
      expect(tableBlocks).toHaveLength(1);
      expect(tableBlocks[0].content).toContain('| Method | Path | Purpose |');
      expect(tableBlocks[0].content).toContain('|--------|------|---------|');
      expect(tableBlocks[0].content).toContain('| GET | /api/users | List users |');
      expect(tableBlocks[0].content).toContain('| POST | /api/users | Create user |');

      // Should NOT have individual table-row elements
      const tableRows = endpointSection!.elements.filter(e => e.type === 'table-row');
      expect(tableRows).toHaveLength(0);

      // Prose after table should still be present
      const proseElements = endpointSection!.elements.filter(e => e.type === 'prose');
      expect(proseElements.length).toBeGreaterThan(0);
      expect(proseElements[0].content).toContain('Some prose after the table.');
    });

    it('handles tables without separator rows', () => {
      const md = `## Data

| A | B |
| 1 | 2 |
`;
      const sections = parseMarkdownSections(md);
      const dataSection = sections.find(s => s.heading === 'Data');
      const tableBlocks = dataSection!.elements.filter(e => e.type === 'table-block');
      expect(tableBlocks).toHaveLength(1);
    });
  });

  describe('H3+ heading stripping (#51b)', () => {
    it('strips ### prefix and emits as prose', () => {
      const md = `## Design

### Extension Over Addition

Prefer extending an existing concept's domain over introducing a new concept.
`;
      const sections = parseMarkdownSections(md);
      const designSection = sections.find(s => s.heading === 'Design');
      expect(designSection).toBeDefined();

      // Should have prose elements, NOT contain "###"
      const allContent = designSection!.elements.map(e => e.content).join(' ');
      expect(allContent).toContain('Extension Over Addition');
      expect(allContent).not.toContain('###');
    });

    it('handles H4 headings as well', () => {
      const md = `## Stack

#### Database Layer

Uses SQLite for local persistence.
`;
      const sections = parseMarkdownSections(md);
      const stackSection = sections.find(s => s.heading === 'Stack');
      const allContent = stackSection!.elements.map(e => e.content).join(' ');
      expect(allContent).toContain('Database Layer');
      expect(allContent).not.toContain('####');
    });
  });

  describe('mixed content boundaries', () => {
    it('correctly transitions between table and non-table content', () => {
      const md = `## Reference

Some intro text.

| Key | Value |
|-----|-------|
| a   | 1     |

- Rule one
- Rule two
`;
      const sections = parseMarkdownSections(md);
      const refSection = sections.find(s => s.heading === 'Reference');
      expect(refSection).toBeDefined();

      const types = refSection!.elements.map(e => e.type);
      expect(types).toContain('prose');
      expect(types).toContain('table-block');
      expect(types).toContain('rule');
    });
  });
});

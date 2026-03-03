/**
 * ADF Decorations — standard emoji decorations and canonical section ordering.
 */

export const STANDARD_DECORATIONS: Record<string, string> = {
  TASK: '\u{1F3AF}',
  ROLE: '\u{1F9D1}',
  CONTEXT: '\u{1F4CB}',
  OUTPUT: '\u{2705}',
  CONSTRAINTS: '\u{26A0}\u{FE0F}',
  RULES: '\u{1F4D0}',
  DEFAULT_LOAD: '\u{1F4E6}',
  ON_DEMAND: '\u{1F4C2}',
  FILES: '\u{1F5C2}\u{FE0F}',
  TOOLS: '\u{1F6E0}\u{FE0F}',
  RISKS: '\u{1F6A8}',
  STATE: '\u{1F9E0}',
  BUDGET: '\u{1F4B0}',
  SYNC: '\u{1F504}',
  CADENCE: '\u{1F4CA}',
  GUIDE: '\u{1F4D6}',
};

export const CANONICAL_KEY_ORDER: string[] = [
  'TASK',
  'ROLE',
  'CONTEXT',
  'OUTPUT',
  'CONSTRAINTS',
  'RULES',
  'DEFAULT_LOAD',
  'ON_DEMAND',
  'BUDGET',
  'SYNC',
  'CADENCE',
  'FILES',
  'TOOLS',
  'RISKS',
  'STATE',
  'GUIDE',
];

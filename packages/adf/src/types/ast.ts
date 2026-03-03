/**
 * ADF AST Core — canonical document structure types.
 */

export interface AdfDocument {
  version: '0.1';
  sections: AdfSection[];
}

export interface AdfSection {
  key: string;
  decoration: string | null;
  content: AdfContent;
  weight?: 'load-bearing' | 'advisory';
}

export type AdfContent =
  | { type: 'text'; value: string }
  | { type: 'list'; items: string[] }
  | { type: 'map'; entries: AdfMapEntry[] }
  | { type: 'metric'; entries: AdfMetricEntry[] };

export interface AdfMapEntry {
  key: string;
  value: string;
}

export interface AdfMetricEntry {
  key: string;
  value: number;
  ceiling: number;
  unit: string;
}

/**
 * ADF Patch Operations — discriminated union of document delta operations.
 */

import type { AdfContent } from './ast';

export interface AddBulletOp {
  op: 'ADD_BULLET';
  section: string;
  value: string;
}

export interface ReplaceBulletOp {
  op: 'REPLACE_BULLET';
  section: string;
  index: number;
  value: string;
}

export interface RemoveBulletOp {
  op: 'REMOVE_BULLET';
  section: string;
  index: number;
}

export interface AddSectionOp {
  op: 'ADD_SECTION';
  key: string;
  decoration?: string | null;
  content: AdfContent;
  weight?: 'load-bearing' | 'advisory';
}

export interface ReplaceSectionOp {
  op: 'REPLACE_SECTION';
  key: string;
  content: AdfContent;
}

export interface RemoveSectionOp {
  op: 'REMOVE_SECTION';
  key: string;
}

export interface UpdateMetricOp {
  op: 'UPDATE_METRIC';
  section: string;
  key: string;
  value: number;
}

export type PatchOperation =
  | AddBulletOp
  | ReplaceBulletOp
  | RemoveBulletOp
  | AddSectionOp
  | ReplaceSectionOp
  | RemoveSectionOp
  | UpdateMetricOp;

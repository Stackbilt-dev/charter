/**
 * The populate record, `<aiDir>/.populate.json` (#371).
 *
 * What `charter adf populate` has added to, or offered for, each module's
 * CONSTRAINTS. Without it, a section holding the template plus the one bullet
 * populate added looks, once the user deletes that bullet, exactly like a fresh
 * scaffold. Committed with the rest of `.ai/`, so the memory travels with the repo.
 *
 * Shape: `{ "version": 1, "constraints": { "<module>.adf": { "added": [...], "offered": [...] } } }`.
 * Keys are bare module file names; lists hold normalized constraint text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { backupFile } from './adf-scaffold-merge';

export const POPULATE_RECORD_FILE = '.populate.json';

export interface RecordEntry { added: string[]; offered: string[] }

/** Entries live in a Map, so no key (`__proto__` included) can reach an object prototype. */
export interface PopulateRecord {
  version: 1;
  constraints: Map<string, RecordEntry>;
}

export type RecordRead =
  | { status: 'absent' | 'ok'; record: PopulateRecord }
  | { status: 'invalid'; record: PopulateRecord; detail: string };

export function emptyRecord(): PopulateRecord {
  return { version: 1, constraints: new Map() };
}

/**
 * Generated values (package.json description, README summary, ...) become ADF
 * list items or map values, which the parser reads as one trimmed line. Strip
 * control characters and collapse whitespace and newlines to single spaces, so
 * every value round-trips and the re-parse guard can accept it (#354).
 */
export function normalizeValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A record key as a bare module file name: `.ai/core.adf` and `.ai\core.adf` both mean `core.adf`. */
export function recordKey(key: string): string {
  return key.split(/[\\/]/).pop() ?? key;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`${where} is not a list of strings`);
  return (v as string[]).map(normalizeValue);
}

/**
 * Read the record. A UTF-8 BOM (as Windows PowerShell writes) is ignored. Anything
 * that is not a version 1 record of the documented shape is 'invalid', and the
 * caller must then act as if it knew nothing it may contradict: populate adds no
 * stack constraints at all while the record is invalid.
 */
export function readPopulateRecord(file: string): RecordRead {
  if (!fs.existsSync(file)) return { status: 'absent', record: emptyRecord() };
  try {
    let text = fs.readFileSync(file, 'utf-8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const raw: unknown = JSON.parse(text);
    if (!isPlainObject(raw)) throw new Error('not a JSON object');
    if (raw.version !== 1) throw new Error(`version is ${JSON.stringify(raw.version)}, not 1`);
    if (!isPlainObject(raw.constraints)) throw new Error('"constraints" is not an object');
    const constraints = new Map<string, RecordEntry>();
    for (const [rawKey, entry] of Object.entries(raw.constraints)) {
      if (!isPlainObject(entry)) throw new Error(`constraints[${JSON.stringify(rawKey)}] is not an object`);
      const key = recordKey(rawKey);
      const prev = constraints.get(key) ?? { added: [], offered: [] };
      prev.added.push(...parseList(entry.added, `constraints[${JSON.stringify(rawKey)}].added`));
      prev.offered.push(...parseList(entry.offered, `constraints[${JSON.stringify(rawKey)}].offered`));
      constraints.set(key, prev);
    }
    return { status: 'ok', record: { version: 1, constraints } };
  } catch (err) {
    return { status: 'invalid', record: emptyRecord(), detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Deterministic: keys and lists sorted, lists de-duplicated, two-space indent, trailing newline. */
export function serializePopulateRecord(record: PopulateRecord): string {
  const sorted = (xs: string[]): string[] => [...new Set(xs)].sort();
  const pairs = [...record.constraints.keys()].sort().map(key => {
    const e = record.constraints.get(key)!;
    return `${JSON.stringify(key)}: ${JSON.stringify({ added: sorted(e.added), offered: sorted(e.offered) }, null, 2).replace(/\n/g, '\n    ')}`;
  });
  const body = pairs.length === 0 ? '{}' : `{\n    ${pairs.join(',\n    ')}\n  }`;
  return `{\n  "version": 1,\n  "constraints": ${body}\n}\n`;
}

export function cloneRecord(record: PopulateRecord): PopulateRecord {
  const constraints = new Map<string, RecordEntry>();
  for (const [k, e] of record.constraints) constraints.set(k, { added: [...e.added], offered: [...e.offered] });
  return { version: 1, constraints };
}

/**
 * `--reset-adf` (#371): a module replaced with its template starts over, so
 * populate's entry for it is dropped and its stack constraints are offered again.
 * The record is backed up to `backupDir` first, like the files the reset replaced;
 * if that backup fails, or the record is invalid, it is left as is. Returns a line
 * for the run's warnings, or null when there was nothing to drop.
 */
export function dropRecordEntries(aiDir: string, modules: readonly string[], backupDir: string, stamp: string, prefix: string): string | null {
  const file = path.join(aiDir, POPULATE_RECORD_FILE);
  const read = readPopulateRecord(file);
  if (read.status !== 'ok') return null;
  const dropped = modules.map(recordKey).filter(m => read.record.constraints.has(m));
  if (dropped.length === 0) return null;
  let backupName: string;
  try {
    backupName = backupFile(file, backupDir, POPULATE_RECORD_FILE, stamp);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Could not back up ${prefix}${POPULATE_RECORD_FILE} (${msg}), so it still lists ${dropped.join(', ')}; delete those entries by hand to have populate offer their stack constraints again.`;
  }
  const next = cloneRecord(read.record);
  for (const m of dropped) next.constraints.delete(m);
  fs.writeFileSync(file, serializePopulateRecord(next));
  return `Dropped ${dropped.join(', ')} from ${prefix}${POPULATE_RECORD_FILE} (backup: ${prefix}.backup/${backupName}), so populate treats the reset ${dropped.length === 1 ? 'module' : 'modules'} as new.`;
}

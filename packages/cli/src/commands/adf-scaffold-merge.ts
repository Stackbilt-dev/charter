/**
 * Scaffold merge and reset for `charter bootstrap` phase 3 (#354).
 *
 * `bootstrap --force` merges the preset template into existing `.ai/*.adf`
 * files. It appends whole sections the file lacks and never edits a section
 * the file already has. `--reset-adf` replaces a file with the template, backs
 * the old copy up first, and reports what the replacement dropped.
 *
 * Every write is guarded the same way as the shared manifest writer (#239): the
 * edited text is re-parsed and must equal the old document plus exactly the
 * appended sections, or nothing is written.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAdf, parseManifest } from '@stackbilt/adf';
import type { AdfDocument, AdfSection } from '@stackbilt/adf';
import { sectionHeaders } from './adf-manifest-register';
import type { LoadPolicy } from './adf-manifest-register';
import { normalizeModulePath } from './adf-wiring';

// ============================================================================
// Types (contract: blueprint #354)
// ============================================================================

export type ScaffoldMode = 'skip' | 'merge' | 'reset';

export type ScaffoldSkipReason = 'custom-content' | 'unparseable' | 'guard' | 'not-a-list' | 'backup-failed';

export interface AddedModule {
  module: string;
  loadPolicy: LoadPolicy;
  triggers: string[];
  fileCreated: boolean;
}

export interface LossEntry {
  sectionsLost: string[];
  itemsLost: Array<{ section: string; item: string }>;
  metricsRows: Array<{ key: string; before: string; after: string | null }>;
  entries: Array<{ module: string; before: string; after: string | null }>;
  /** A section whose decoration or weight differs, e.g. `CONSTRAINTS [advisory]` -> `⚠️ CONSTRAINTS [load-bearing]`. */
  headerChanges: Array<{ section: string; before: string; after: string }>;
  /** manifest.adf: VENDORS entries (as written) that the final file no longer has, e.g. invalid ones not carried over. */
  vendorsDropped: string[];
  unparsed: boolean;
}

export type ScaffoldOutcome =
  | { kind: 'created'; file: string }
  | { kind: 'unchanged'; file: string }
  | { kind: 'merged'; file: string; addedSections: string[]; addedModules: AddedModule[] }
  | { kind: 'skipped'; file: string; reason: ScaffoldSkipReason; detail: string }
  | { kind: 'replaced'; file: string; backupPath: string; lost: LossEntry };

export type AppendMissingSectionsResult =
  | { status: 'appended'; next: string; added: string[] }
  | { status: 'none' }
  | { status: 'refused'; reason: 'unparseable' | 'guard' };

/** Manifest sections that are never appended as text (module entries and VENDORS have their own writers). */
export const MANIFEST_EXCLUDED_KEYS: readonly string[] = ['DEFAULT_LOAD', 'ON_DEMAND', 'VENDORS'];

export const LOSS_TEXT_MAX_LINES_PER_FILE = 10;

// ============================================================================
// Append missing sections
// ============================================================================

/**
 * Append, at end of file and in template order, every template section whose
 * key the file has no section for. Each block is copied from the template text
 * and separated by one blank line. The file's line endings and trailing-newline
 * state are kept. No section the file already has gains or loses a line.
 */
export function appendMissingSections(text: string, templateText: string, excludeKeys: readonly string[]): AppendMissingSectionsResult {
  let old: AdfDocument;
  let template: AdfDocument;
  try {
    old = parseAdf(text);
    template = parseAdf(templateText);
  } catch {
    return { status: 'refused', reason: 'unparseable' };
  }

  const have = new Set(old.sections.map(s => s.key));
  const tLines = templateText.split('\n').map(l => l.replace(/\r$/, ''));
  const { headers } = sectionHeaders(tLines, '');
  if (headers.length !== template.sections.length) return { status: 'refused', reason: 'guard' };

  const blocks: string[][] = [];
  const appended: AdfSection[] = [];
  template.sections.forEach((section, i) => {
    if (have.has(section.key) || excludeKeys.includes(section.key)) return;
    const block = tLines.slice(headers[i], headers[i + 1] ?? tLines.length);
    while (block.length > 0 && block[block.length - 1].trim() === '') block.pop();
    blocks.push(block);
    appended.push(section);
  });
  if (blocks.length === 0) return { status: 'none' };

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = blocks.map(b => b.join(eol)).join(eol + eol);
  let next: string;
  if (text.length === 0) next = body + eol;
  else if (text.endsWith('\n')) next = `${text}${eol}${body}${eol}`;
  else next = `${text}${eol}${eol}${body}`;

  // Guard: the result must parse as the old document plus exactly the appended sections.
  const expected: AdfDocument = { ...old, sections: [...old.sections, ...appended] };
  try {
    if (JSON.stringify(parseAdf(next)) !== JSON.stringify(expected)) return { status: 'refused', reason: 'guard' };
  } catch {
    return { status: 'refused', reason: 'guard' };
  }
  return { status: 'appended', next, added: appended.map(s => s.key) };
}

// ============================================================================
// Template modules
// ============================================================================

export interface TemplateModule {
  module: string;
  loadPolicy: LoadPolicy;
  triggers: string[];
}

/** The template manifest's entries for `modules` (the preset's scaffold files), with their placement and triggers. */
export function templateModules(manifestTemplate: string, modules: readonly string[]): TemplateModule[] {
  const manifest = parseManifest(parseAdf(manifestTemplate));
  const out: TemplateModule[] = [];
  for (const mod of manifest.defaultLoad) {
    if (modules.includes(mod)) out.push({ module: mod, loadPolicy: 'DEFAULT_LOAD', triggers: [] });
  }
  for (const mod of manifest.onDemand) {
    if (modules.includes(mod.path)) out.push({ module: mod.path, loadPolicy: 'ON_DEMAND', triggers: [...mod.triggers] });
  }
  return out;
}

// ============================================================================
// Backups
// ============================================================================

/**
 * Copy `source` to `<backupDir>/<name>.<stamp>`, never overwriting an earlier
 * backup: a name that is taken gets a `-1`, `-2`, ... suffix. Returns the
 * backup file name. Throws when the copy fails.
 */
export function backupFile(source: string, backupDir: string, name: string, stamp: string): string {
  fs.mkdirSync(backupDir, { recursive: true });
  for (let n = 0; ; n++) {
    const backupName = n === 0 ? `${name}.${stamp}` : `${name}.${stamp}-${n}`;
    try {
      fs.copyFileSync(source, path.join(backupDir, backupName), fs.constants.COPYFILE_EXCL);
      return backupName;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/** Keep `.ai/.backup/` out of git: a `.gitignore` inside it ignoring everything. */
export function ensureBackupGitignore(aiDir: string): 'created' | 'present' | 'not-needed' {
  const dir = path.join(aiDir, '.backup');
  try {
    if (!fs.statSync(dir).isDirectory()) return 'not-needed';
  } catch {
    return 'not-needed';
  }
  const file = path.join(dir, '.gitignore');
  if (fs.existsSync(file)) return 'present';
  fs.writeFileSync(file, '*\n');
  return 'created';
}

// ============================================================================
// Loss report (--reset-adf)
// ============================================================================

function rowText(section: AdfSection): Array<{ key: string; text: string }> {
  const c = section.content;
  if (c.type === 'map') return c.entries.map(e => ({ key: e.key, text: e.value }));
  if (c.type === 'metric') return c.entries.map(e => ({ key: e.key, text: `${e.value} / ${e.ceiling} [${e.unit}]` }));
  return [];
}

function itemsOf(section: AdfSection): string[] {
  const c = section.content;
  if (c.type === 'list') return c.items;
  if (c.type === 'text') return c.value === '' ? [] : [c.value];
  return rowText(section).map(r => `${r.key}: ${r.text}`);
}

interface EntryBullet { module: string; policy: LoadPolicy; bullet: string }

/** Every DEFAULT_LOAD/ON_DEMAND entry in every section with those keys, in file order. */
function entryBullets(doc: AdfDocument): EntryBullet[] {
  const out: EntryBullet[] = [];
  for (const section of doc.sections) {
    if (section.key !== 'ON_DEMAND' && section.key !== 'DEFAULT_LOAD') continue;
    if (section.content.type !== 'list') continue;
    const policy = section.key;
    const parsed = parseManifest({ version: doc.version, sections: [section] });
    section.content.items.forEach((item, i) => {
      const mod = policy === 'DEFAULT_LOAD' ? item : parsed.onDemand[i]?.path ?? item;
      out.push({ module: normalizeModulePath(mod), policy, bullet: item.trim() });
    });
  }
  return out;
}

const headerOf = (s: AdfSection): string => `${s.decoration ? `${s.decoration} ` : ''}${s.key}${s.weight ? ` [${s.weight}]` : ''}`;

function byKey(doc: AdfDocument): Map<string, AdfSection[]> {
  const out = new Map<string, AdfSection[]>();
  for (const s of doc.sections) out.set(s.key, [...(out.get(s.key) ?? []), s]);
  return out;
}

/**
 * What `oldText` holds that `newText` does not, compared at parse level over
 * every section of each key (duplicates included). Bootstrap passes the file as
 * it stands after the whole run, so content a later phase put back (populate,
 * orphan registration, the VENDORS carry-over) is not reported as lost.
 */
export function computeLoss(oldText: string, newText: string, isManifest: boolean): LossEntry {
  const lost: LossEntry = { sectionsLost: [], itemsLost: [], metricsRows: [], entries: [], headerChanges: [], vendorsDropped: [], unparsed: false };
  let old: AdfDocument;
  try {
    old = parseAdf(oldText);
  } catch {
    return { ...lost, unparsed: true };
  }
  let now: AdfDocument;
  try {
    now = parseAdf(newText);
  } catch {
    now = { version: '0.1', sections: [] };
  }
  const skip = new Set(isManifest ? MANIFEST_EXCLUDED_KEYS : []);
  const nowByKey = byKey(now);

  for (const [key, sections] of byKey(old)) {
    if (skip.has(key)) continue;
    const after = nowByKey.get(key) ?? [];
    const oldRows = sections.flatMap(rowText);
    if (key === 'METRICS') {
      const nowRows = new Map(after.flatMap(rowText).map(r => [r.key, r.text] as const));
      for (const row of oldRows) {
        const a = nowRows.get(row.key) ?? null;
        if (a !== row.text) lost.metricsRows.push({ key: row.key, before: row.text, after: a });
      }
    }
    if (after.length === 0) {
      lost.sectionsLost.push(key);
      continue;
    }
    const nowHeaders = new Set(after.map(headerOf));
    for (const section of sections) {
      const h = headerOf(section);
      if (!nowHeaders.has(h) && !lost.headerChanges.some(c => c.section === key && c.before === h)) {
        lost.headerChanges.push({ section: key, before: h, after: headerOf(after[0]) });
      }
    }
    if (key === 'METRICS' && oldRows.length > 0) continue;
    const nowItems = new Set(after.flatMap(itemsOf));
    const seen = new Set<string>();
    for (const item of sections.flatMap(itemsOf)) {
      if (nowItems.has(item) || seen.has(item)) continue;
      seen.add(item);
      lost.itemsLost.push({ section: key, item });
    }
  }

  if (isManifest) {
    const nowEntries = entryBullets(now);
    const exact = new Set(nowEntries.map(e => `${e.policy}|${e.bullet}`));
    const byModule = new Map(nowEntries.map(e => [e.module, e] as const));
    const seen = new Set<string>();
    for (const before of entryBullets(old)) {
      const id = `${before.policy}|${before.bullet}`;
      if (exact.has(id) || seen.has(id)) continue;
      seen.add(id);
      const a = byModule.get(before.module);
      if (!a) lost.entries.push({ module: before.module, before: before.bullet, after: null });
      else if (a.policy !== before.policy) lost.entries.push({ module: before.module, before: `${before.bullet} [${before.policy}]`, after: `${a.bullet} [${a.policy}]` });
      else lost.entries.push({ module: before.module, before: before.bullet, after: a.bullet });
    }
    const vendors = (doc: AdfDocument): string[] => (byKey(doc).get('VENDORS') ?? []).flatMap(itemsOf).map(i => i.trim());
    const kept = new Set(vendors(now));
    lost.vendorsDropped = [...new Set(vendors(old).filter(v => !kept.has(v)))];
  }
  return lost;
}

function sectionSize(oldText: string, key: string): string {
  try {
    const sections = parseAdf(oldText).sections.filter(s => s.key === key);
    const section = sections[0];
    const n = sections.flatMap(itemsOf).length;
    const noun = section && (section.content.type === 'map' || section.content.type === 'metric') ? 'row' : 'item';
    return ` (${n} ${noun}${n === 1 ? '' : 's'})`;
  } catch {
    return '';
  }
}

/** One text line per lost item, capped at LOSS_TEXT_MAX_LINES_PER_FILE (JSON carries the full list). */
export function formatLossLines(lost: LossEntry, oldText: string): string[] {
  const lines: string[] = [];
  if (lost.unparsed) lines.push('could not parse the old file; its content is only in the backup');
  for (const key of lost.sectionsLost) lines.push(`lost section ${key}${sectionSize(oldText, key)}`);
  for (const row of lost.metricsRows) {
    if (lost.sectionsLost.includes('METRICS')) continue;
    lines.push(row.after === null
      ? `lost METRICS row ${row.key}: ${row.before}`
      : `changed METRICS ${row.key}: ${row.before} -> ${row.after}`);
  }
  for (const c of lost.headerChanges) lines.push(`changed header: ${c.before} -> ${c.after}`);
  for (const { section, item } of lost.itemsLost) lines.push(`lost ${section} item: ${item}`);
  for (const e of lost.entries) {
    lines.push(e.after === null
      ? `dropped entry: ${e.before}`
      : `reset entry: ${e.before} -> ${e.after.startsWith(`${e.module} `) ? e.after.slice(e.module.length + 1) : e.after}`);
  }
  for (const v of lost.vendorsDropped) lines.push(`dropped VENDORS entry: ${v}`);
  if (lines.length <= LOSS_TEXT_MAX_LINES_PER_FILE) return lines;
  const more = lines.length - LOSS_TEXT_MAX_LINES_PER_FILE;
  return [...lines.slice(0, LOSS_TEXT_MAX_LINES_PER_FILE), `... and ${more} more (see backup)`];
}

// ============================================================================
// Text rendering of a phase-3 outcome
// ============================================================================

export function describeMerge(outcome: Extract<ScaffoldOutcome, { kind: 'merged' }>): string {
  const parts: string[] = [];
  if (outcome.addedSections.length > 0) {
    parts.push(`section${outcome.addedSections.length === 1 ? '' : 's'} ${outcome.addedSections.join(', ')}`);
  }
  if (outcome.addedModules.length > 0) {
    const mods = outcome.addedModules.map(m => `${m.module} (${m.loadPolicy})`).join(', ');
    parts.push(`module${outcome.addedModules.length === 1 ? '' : 's'} ${mods}`);
  }
  return `Merged ${outcome.file}: added ${parts.join('; ')}`;
}

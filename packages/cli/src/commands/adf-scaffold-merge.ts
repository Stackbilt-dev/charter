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
import { lastSectionIndex, sectionHeaders } from './adf-manifest-register';
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

function entryBullets(doc: AdfDocument): Map<string, { policy: LoadPolicy; bullet: string }> {
  const out = new Map<string, { policy: LoadPolicy; bullet: string }>();
  for (const key of ['ON_DEMAND', 'DEFAULT_LOAD'] as const) {
    const idx = lastSectionIndex(doc, key);
    const content = idx === -1 ? undefined : doc.sections[idx].content;
    if (content?.type !== 'list') continue;
    const parsed = parseManifest({ version: doc.version, sections: [doc.sections[idx]] });
    content.items.forEach((item, i) => {
      const mod = key === 'DEFAULT_LOAD' ? item : parsed.onDemand[i]?.path ?? item;
      out.set(normalizeModulePath(mod), { policy: key, bullet: item.trim() });
    });
  }
  return out;
}

/** What replacing `oldText` with `templateText` drops, compared at parse level. */
export function computeLoss(oldText: string, templateText: string, isManifest: boolean): LossEntry {
  const lost: LossEntry = { sectionsLost: [], itemsLost: [], metricsRows: [], entries: [], unparsed: false };
  let old: AdfDocument;
  try {
    old = parseAdf(oldText);
  } catch {
    return { ...lost, unparsed: true };
  }
  const template = parseAdf(templateText);
  const skip = new Set(isManifest ? MANIFEST_EXCLUDED_KEYS : []);
  const tByKey = new Map(template.sections.map(s => [s.key, s] as const));

  for (const section of old.sections) {
    if (skip.has(section.key)) continue;
    const t = tByKey.get(section.key);
    if (section.key === 'METRICS') {
      const tRows = new Map((t ? rowText(t) : []).map(r => [r.key, r.text] as const));
      for (const row of rowText(section)) {
        const after = tRows.get(row.key) ?? null;
        if (after !== row.text) lost.metricsRows.push({ key: row.key, before: row.text, after });
      }
    }
    if (!t) {
      lost.sectionsLost.push(section.key);
      continue;
    }
    if (section.key === 'METRICS' && rowText(section).length > 0) continue;
    const tItems = new Set(itemsOf(t));
    for (const item of itemsOf(section)) {
      if (!tItems.has(item)) lost.itemsLost.push({ section: section.key, item });
    }
  }

  if (isManifest) {
    const tEntries = entryBullets(template);
    for (const [module, before] of entryBullets(old)) {
      const after = tEntries.get(module);
      if (!after) {
        lost.entries.push({ module, before: before.bullet, after: null });
      } else if (after.policy !== before.policy) {
        lost.entries.push({ module, before: `${before.bullet} [${before.policy}]`, after: `${after.bullet} [${after.policy}]` });
      } else if (after.bullet !== before.bullet) {
        lost.entries.push({ module, before: before.bullet, after: after.bullet });
      }
    }
  }
  return lost;
}

function sectionSize(oldText: string, key: string): string {
  try {
    const section = parseAdf(oldText).sections.find(s => s.key === key);
    const n = section ? itemsOf(section).length : 0;
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
  for (const { section, item } of lost.itemsLost) lines.push(`lost ${section} item: ${item}`);
  for (const e of lost.entries) {
    lines.push(e.after === null
      ? `dropped entry: ${e.before} (an existing module file is re-registered with its stem as trigger)`
      : `reset entry: ${e.before} -> ${e.after.startsWith(`${e.module} `) ? e.after.slice(e.module.length + 1) : e.after}`);
  }
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

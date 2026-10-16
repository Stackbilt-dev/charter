/**
 * Shared manifest.adf module registration (#239).
 *
 * One writer for every command that adds modules to `.ai/manifest.adf` on the
 * user's behalf: `charter adf migrate` registers the modules it routes content
 * into, and `charter bootstrap` registers orphaned modules. The writer is
 * append-only: an entry whose parsed path is already in DEFAULT_LOAD or
 * ON_DEMAND is never rewritten, moved, or merged with new triggers.
 *
 * ON_DEMAND triggers are inferred from the headings of the items routed to the
 * module (see inferTriggers). `charter adf create` keeps its own upsert writer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAdf, parseManifest, formatTriggerEntry } from '@stackbilt/adf';
import type { AdfDocument, MigrationItem } from '@stackbilt/adf';
import { classifyModuleLoad, normalizeModulePath } from './adf-wiring';
import { NAMED_MODULE_DEFAULT_TRIGGERS } from './adf-named-scaffolds';

// ============================================================================
// Trigger inference constants
// ============================================================================

/** Hard cap on seeded + inferred triggers per ON_DEMAND module. */
export const MAX_TRIGGERS = 6;

/** Tokens shorter than this are dropped unless listed in ALLOWED_SHORT_TOKENS. */
export const MIN_TOKEN_LEN = 3;

/** Score multiplier for RoutingTrace.headingKeyword over plain heading tokens. */
export const HEADING_KEYWORD_WEIGHT = 2;

/** The 2-letter terms in the classifier's heading-route vocabulary. */
export const ALLOWED_SHORT_TOKENS: readonly string[] = ['ui', 'ci', 'cd', 'db', 'kv', 'd1', 'r2'];

/** Generic heading words that carry no routing signal. */
export const GENERIC_HEADING_WORDS: readonly string[] = [
  'rules', 'guidelines', 'notes', 'overview', 'section', 'project',
];

/**
 * Generic English function words. Shared with `adf suggest`'s near-miss
 * keyword detector so both filter the same list.
 */
export const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'this', 'that', 'these', 'those',
  'it', 'its', 'as', 'at', 'by', 'from', 'into', 'about', 'my', 'our', 'your',
]);

const ALLOWED_SHORT = new Set(ALLOWED_SHORT_TOKENS);
const GENERIC = new Set(GENERIC_HEADING_WORDS);

// ============================================================================
// Types
// ============================================================================

export type LoadPolicy = 'DEFAULT_LOAD' | 'ON_DEMAND';

/**
 * planned            computed, not written (only appears under --dry-run).
 * added              appended to manifest.adf in this run.
 * already-registered the parsed path was already in DEFAULT_LOAD or ON_DEMAND.
 * skipped            registration impossible; see skipReason.
 */
export type RegistrationStatus = 'planned' | 'added' | 'already-registered' | 'skipped';

export type SkipReason = 'manifest-missing' | 'manifest-unparseable' | 'section-not-list';

export type TriggerInferenceSource = 'named-seed' | 'heading-keyword' | 'heading-token' | 'stem-fallback';

export interface ModuleRegistration {
  /** Module path relative to the .ai directory, normalized. */
  module: string;
  loadPolicy: LoadPolicy;
  /** Triggers written (or that would be written) after "Triggers on:". Empty for DEFAULT_LOAD. */
  triggers: string[];
  /** classifyModuleLoad(module).reason; for ON_DEMAND, the inference summary is appended. */
  reason: string;
  status: RegistrationStatus;
  /** Present iff status is 'skipped'. */
  skipReason?: SkipReason;
  /** Where each trigger came from; same length and order as `triggers`. */
  triggerSources: TriggerInferenceSource[];
}

export interface RegisterManifestModulesResult {
  manifestPath: string;
  /** True iff manifest.adf was rewritten (never under dry-run). */
  written: boolean;
  registrations: ModuleRegistration[];
}

export interface RegisterOptions {
  dryRun?: boolean;
  onWarning?: (message: string) => void;
}

type ParsedManifest = ReturnType<typeof parseManifest>;

// ============================================================================
// Trigger inference
// ============================================================================

/**
 * Split text into trigger candidates: lowercase, split on anything but
 * alphanumerics, keeping `.`, `-` and `_` only inside a word (`next.js`,
 * `wasm-pack`, `auth_scoped`). Markdown punctuation and backticks are dropped.
 */
export function tokenizeTriggerText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[._-]{2,}/g, ' ')
    .split(/[^a-z0-9._-]+/)
    .map(t => t.replace(/^[._-]+|[._-]+$/g, ''))
    .filter(t => t.length > 0);
}

function isUsableToken(token: string): boolean {
  if (STOPWORDS.has(token) || GENERIC.has(token)) return false;
  return token.length >= MIN_TOKEN_LEN || ALLOWED_SHORT.has(token);
}

/** The stem fallback trigger: the module's file stem, lowercased and tokenized. */
function stemTrigger(module: string): string {
  const stem = path.posix.basename(module, '.adf');
  return tokenizeTriggerText(stem).join('-') || stem.toLowerCase();
}

/**
 * Infer ON_DEMAND triggers for `module` from the migrated items routed to it.
 *
 * Seeds from NAMED_MODULE_DEFAULT_TRIGGERS take the first slots. Then each
 * item contributes its routing trace's heading keyword (weight
 * HEADING_KEYWORD_WEIGHT, only when the heading route chose this module) and
 * the tokens of its source heading (weight 1). Tokens that already trigger
 * another ON_DEMAND module are dropped. Highest score first, ties by first
 * appearance, capped at MAX_TRIGGERS. Falls back to the module stem.
 */
export function inferTriggers(
  module: string,
  items: readonly MigrationItem[],
  manifest?: Pick<ParsedManifest, 'onDemand'>,
): { triggers: string[]; triggerSources: TriggerInferenceSource[] } {
  const target = normalizeModulePath(module);
  const taken = new Set<string>();
  for (const mod of manifest?.onDemand ?? []) {
    if (normalizeModulePath(mod.path) === target) continue;
    for (const t of mod.triggers) taken.add(t.trim().toLowerCase());
  }

  const triggers: string[] = [];
  const triggerSources: TriggerInferenceSource[] = [];
  const push = (t: string, source: TriggerInferenceSource): void => {
    if (triggers.length < MAX_TRIGGERS && !triggers.includes(t)) {
      triggers.push(t);
      triggerSources.push(source);
    }
  };

  const stem = path.posix.basename(target, '.adf');
  for (const seed of NAMED_MODULE_DEFAULT_TRIGGERS[stem] ?? []) push(seed.trim().toLowerCase(), 'named-seed');

  const scores = new Map<string, { score: number; source: TriggerInferenceSource; order: number }>();
  for (const item of items) {
    if (normalizeModulePath(item.classification.targetModule) !== target) continue;
    const perItem = new Map<string, TriggerInferenceSource>();
    const trace = item.classification.routingTrace;
    if (trace?.headingKeyword && normalizeModulePath(trace.headingModule) === target) {
      for (const t of tokenizeTriggerText(trace.headingKeyword)) perItem.set(t, 'heading-keyword');
    }
    for (const t of tokenizeTriggerText(item.sourceHeading)) {
      if (!perItem.has(t)) perItem.set(t, 'heading-token');
    }
    for (const [token, source] of perItem) {
      if (!isUsableToken(token) || taken.has(token)) continue;
      const weight = source === 'heading-keyword' ? HEADING_KEYWORD_WEIGHT : 1;
      const entry = scores.get(token);
      if (entry) {
        entry.score += weight;
        if (source === 'heading-keyword') entry.source = source;
      } else {
        scores.set(token, { score: weight, source, order: scores.size });
      }
    }
  }

  const ranked = [...scores.entries()].sort(([, a], [, b]) => b.score - a.score || a.order - b.order);
  for (const [token, { source }] of ranked) push(token, source);

  if (triggers.length === 0) push(stemTrigger(target), 'stem-fallback');
  return { triggers, triggerSources };
}

/** Plan one module's registration (status 'planned'); the writer resolves it. */
export function planModuleRegistration(
  module: string,
  items: readonly MigrationItem[],
  manifest?: Pick<ParsedManifest, 'onDemand'>,
): ModuleRegistration {
  const load = classifyModuleLoad(module);
  if (load.defaultLoad) {
    return { module: load.module, loadPolicy: 'DEFAULT_LOAD', triggers: [], reason: load.reason, status: 'planned', triggerSources: [] };
  }
  const { triggers, triggerSources } = inferTriggers(load.module, items, manifest);
  return {
    module: load.module,
    loadPolicy: 'ON_DEMAND',
    triggers,
    reason: `${load.reason}; ${summarizeSources(triggerSources)}`,
    status: 'planned',
    triggerSources,
  };
}

function summarizeSources(sources: readonly TriggerInferenceSource[]): string {
  if (sources.length === 1 && sources[0] === 'stem-fallback') return 'triggers fall back to the module stem';
  const counts: Array<[TriggerInferenceSource, string]> = [
    ['named-seed', 'named-module seed(s)'],
    ['heading-keyword', 'heading keyword(s)'],
    ['heading-token', 'heading token(s)'],
  ];
  const parts = counts
    .map(([src, label]) => [sources.filter(s => s === src).length, label] as const)
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`);
  return `triggers inferred from ${parts.join(', ')}`;
}

// ============================================================================
// Shared writer
// ============================================================================

const SECTION_DECORATION: Record<LoadPolicy, string> = { DEFAULT_LOAD: '\u{1F4E6}', ON_DEMAND: '\u{1F4C2}' };

// Same header/version grammar as @stackbilt/adf's parser, so the text edit finds
// exactly the sections parseAdf sees.
const SECTION_HEADER_RE = /^(?:(\p{Emoji_Presentation}|\p{Extended_Pictographic})️?\s+)?([A-Z][A-Z0-9_]*)\s*(?:\[(load-bearing|advisory)\]\s*)?:\s*(.*)$/u;
const VERSION_RE = /^ADF\s*:\s*(.+)$/i;
const LIST_ITEM_PREFIX_RE = /^(\s*-\s+)\S/;

const cleanLine = (line: string) => line.replace(/\r$/, '').trimEnd();

/** Line indexes of every section header, and of the `key` headers among them. */
export function sectionHeaders(lines: readonly string[], key: string): { headers: number[]; own: number[] } {
  const start = lines.length > 0 && VERSION_RE.test(cleanLine(lines[0])) ? 1 : 0;
  const headers: number[] = [];
  for (let i = start; i < lines.length; i++) {
    if (SECTION_HEADER_RE.test(cleanLine(lines[i]))) headers.push(i);
  }
  const own = headers.filter(i => cleanLine(lines[i]).match(SECTION_HEADER_RE)?.[2] === key);
  return { headers, own };
}

/**
 * Insert one bullet into the last `key` section of the manifest text (the one
 * parseManifest reads), after its last list item and with that item's
 * indentation and bullet style. A missing section is appended as a new block
 * at the end of the file, headed by `decoration` (the DEFAULT_LOAD and
 * ON_DEMAND decorations by default). Line endings (CRLF or LF) and the
 * trailing-newline state are kept; no other byte changes.
 */
export function insertManifestBullet(
  text: string,
  key: string,
  bullet: string,
  decoration: string | undefined = SECTION_DECORATION[key as LoadPolicy],
): string {
  const crlf = text.includes('\r\n');
  const eol = crlf ? '\r\n' : '\n';
  const lines = text.split('\n');
  const clean = cleanLine;
  const { headers, own } = sectionHeaders(lines, key);

  if (own.length === 0) {
    const block = `${decoration ? `${decoration} ` : ''}${key}:${eol}  - ${bullet}`;
    if (text.length === 0) return `${block}${eol}`;
    return text.endsWith('\n') ? `${text}${eol}${block}${eol}` : `${text}${eol}${eol}${block}`;
  }

  const header = own[own.length - 1];
  const next = headers.find(i => i > header) ?? lines.length;
  let after = header;
  let prefix = '  - ';
  for (let i = header + 1; i < next; i++) {
    const match = clean(lines[i]).match(LIST_ITEM_PREFIX_RE);
    if (match) {
      after = i;
      prefix = match[1];
    }
  }
  if (after === lines.length - 1) {
    // Inserting after the final line of a file with no trailing newline.
    lines[after] += crlf ? '\r' : '';
    lines.splice(after + 1, 0, prefix + bullet);
  } else {
    lines.splice(after + 1, 0, prefix + bullet + (crlf ? '\r' : ''));
  }
  return lines.join('\n');
}

/**
 * Replace the text of list item `itemIndex` (0-based, as parseAdf counts the
 * items) in the last `key` section, keeping that line's indentation, bullet
 * and line ending. Returns null when the section or item is not found. No
 * other byte changes.
 */
export function replaceManifestBullet(text: string, key: string, itemIndex: number, bullet: string): string | null {
  const lines = text.split('\n');
  const { headers, own } = sectionHeaders(lines, key);
  if (own.length === 0) return null;
  const header = own[own.length - 1];
  const next = headers.find(i => i > header) ?? lines.length;
  let seen = 0;
  for (let i = header + 1; i < next; i++) {
    const match = cleanLine(lines[i]).match(LIST_ITEM_PREFIX_RE);
    if (!match) continue;
    if (seen++ === itemIndex) {
      lines[i] = match[1] + bullet + (lines[i].endsWith('\r') ? '\r' : '');
      return lines.join('\n');
    }
  }
  return null;
}

function skipAll(manifestPath: string, entries: ModuleRegistration[], skipReason: SkipReason): RegisterManifestModulesResult {
  return { manifestPath, written: false, registrations: entries.map(e => ({ ...e, status: 'skipped', skipReason })) };
}

export function lastSectionIndex(doc: AdfDocument, key: string): number {
  for (let i = doc.sections.length - 1; i >= 0; i--) {
    if (doc.sections[i].key === key) return i;
  }
  return -1;
}

/** An existing entry, reported as the manifest has it: real section, triggers as spelled. */
function alreadyRegistered(entry: ModuleRegistration, policy: LoadPolicy, triggers: readonly string[]): ModuleRegistration {
  return {
    module: entry.module,
    loadPolicy: policy,
    triggers: [...triggers],
    reason: `already registered under ${policy}; existing entry kept, triggers not inferred`,
    status: 'already-registered',
    triggerSources: [],
  };
}

/**
 * Register planned modules in manifest.adf. Append-only and idempotent: an
 * entry already present (matched by normalized parsed path, in either section)
 * is left untouched and reported 'already-registered' with its real placement.
 *
 * The manifest is parsed only to decide; new bullets are inserted as text, so
 * every other byte (comments, ordering, line endings) survives. Before writing,
 * the edited text is re-parsed and must equal the old document plus exactly
 * the new entries; otherwise nothing is written. Under dryRun nothing is
 * written and would-be additions stay 'planned'.
 */
export function registerManifestModules(
  manifestPath: string,
  planned: readonly ModuleRegistration[],
  options: RegisterOptions = {},
): RegisterManifestModulesResult {
  const warn = options.onWarning ?? (() => undefined);
  // One registration per module: a repeated module keeps its first entry.
  const entries = planned.filter((e, i) => planned.findIndex(o => o.module === e.module) === i);

  if (!fs.existsSync(manifestPath)) {
    if (entries.length > 0) {
      const verb = options.dryRun ? 'would be' : 'were';
      warn(`${manifestPath} not found; ${entries.length} module(s) ${verb} written but not registered. Run: charter adf init`);
    }
    return skipAll(manifestPath, entries, 'manifest-missing');
  }

  let text: string;
  let doc: AdfDocument;
  let manifest: ParsedManifest;
  try {
    text = fs.readFileSync(manifestPath, 'utf-8');
    doc = parseAdf(text);
    manifest = parseManifest(doc);
  } catch {
    if (entries.length > 0) {
      warn(`${manifestPath} could not be parsed; ${entries.length} module(s) were not registered. Fix the manifest or run: charter doctor`);
    }
    return skipAll(manifestPath, entries, 'manifest-unparseable');
  }

  // DEFAULT_LOAD wins when a module is listed in both sections.
  const existing = new Map<string, { policy: LoadPolicy; triggers: readonly string[] }>();
  for (const mod of manifest.onDemand) existing.set(normalizeModulePath(mod.path), { policy: 'ON_DEMAND', triggers: mod.triggers });
  for (const mod of manifest.defaultLoad) existing.set(normalizeModulePath(mod), { policy: 'DEFAULT_LOAD', triggers: [] });

  const expected: AdfDocument = JSON.parse(JSON.stringify(doc));
  const registrations: ModuleRegistration[] = [];
  const pending: number[] = [];
  let next = text;

  for (const entry of entries) {
    const found = existing.get(entry.module);
    if (found) {
      if (entry.loadPolicy === 'DEFAULT_LOAD' && found.policy === 'ON_DEMAND') {
        warn(`${entry.module} is listed under ON_DEMAND in ${manifestPath}; not moved. Move ${entry.module} from ON_DEMAND to DEFAULT_LOAD in .ai/manifest.adf`);
      }
      registrations.push(alreadyRegistered(entry, found.policy, found.triggers));
      continue;
    }

    const key = entry.loadPolicy;
    const idx = lastSectionIndex(expected, key);
    const section = idx === -1 ? undefined : expected.sections[idx];
    // A header with no items parses as empty text; it is an empty list.
    const emptyText = section?.content.type === 'text' && section.content.value === '';
    if (section && section.content.type !== 'list' && !emptyText) {
      warn(`${key} in ${manifestPath} is not a list; ${entry.module} was not registered`);
      registrations.push({ ...entry, status: 'skipped', skipReason: 'section-not-list' });
      continue;
    }

    const bullet = key === 'DEFAULT_LOAD'
      ? entry.module
      : formatTriggerEntry({ path: entry.module, triggers: entry.triggers, loadPolicy: 'ON_DEMAND' });
    next = insertManifestBullet(next, key, bullet);
    if (!section) {
      expected.sections.push({ key, decoration: SECTION_DECORATION[key], content: { type: 'list', items: [bullet] } });
    } else if (section.content.type === 'list') {
      section.content.items.push(bullet);
    } else {
      section.content = { type: 'list', items: [bullet] };
    }
    existing.set(entry.module, { policy: key, triggers: entry.triggers });
    pending.push(registrations.length);
    registrations.push({ ...entry, status: options.dryRun ? 'planned' : 'added' });
  }

  if (pending.length === 0) return { manifestPath, written: false, registrations };

  // Guard: the edit must change nothing but the new entries.
  let safe = false;
  try {
    safe = JSON.stringify(parseAdf(next)) === JSON.stringify(expected);
  } catch {
    safe = false;
  }
  if (!safe) {
    warn(`${manifestPath} could not be updated without changing its other entries; ${pending.length} module(s) were not registered. Fix the manifest or run: charter doctor`);
    for (const i of pending) registrations[i] = { ...registrations[i], status: 'skipped', skipReason: 'manifest-unparseable' };
    return { manifestPath, written: false, registrations };
  }

  const written = !options.dryRun;
  if (written) fs.writeFileSync(manifestPath, next);
  return { manifestPath, written, registrations };
}

/**
 * Plan and register `modules`. `items` are the migrated items that routed to
 * them (empty for bootstrap orphans, which then get the stem fallback).
 */
export function registerModules(
  manifestPath: string,
  modules: readonly string[],
  items: readonly MigrationItem[],
  options: RegisterOptions = {},
): RegisterManifestModulesResult {
  let manifest: ParsedManifest | undefined;
  try {
    if (fs.existsSync(manifestPath)) manifest = parseManifest(parseAdf(fs.readFileSync(manifestPath, 'utf-8')));
  } catch {
    // The writer reports an unparseable manifest as skipped.
  }
  const planned = modules.map(m => planModuleRegistration(
    m,
    items.filter(i => i.classification.targetModule === m),
    manifest,
  ));
  return registerManifestModules(manifestPath, planned, options);
}

// ============================================================================
// Migrate output
// ============================================================================

export interface RegisterAction {
  type: 'REGISTER';
  target: string;
  detail: string;
  module: string;
  loadPolicy: LoadPolicy;
  status: RegistrationStatus;
}

/** `infra.adf → ON_DEMAND: deploy, ci [planned]` */
export function formatRegisterDetail(reg: ModuleRegistration): string {
  const suffix = reg.status === 'planned' ? ' [planned]'
    : reg.status === 'already-registered' ? ' [already registered]'
    : reg.status === 'skipped' ? ` [skipped: ${reg.skipReason}]`
    : '';
  return reg.loadPolicy === 'ON_DEMAND'
    ? `${reg.module} → ON_DEMAND: ${reg.triggers.join(', ')}${suffix}`
    : `${reg.module} → DEFAULT_LOAD${suffix}`;
}

export function toRegisterAction(reg: ModuleRegistration, manifestPath: string): RegisterAction {
  return {
    type: 'REGISTER',
    target: manifestPath,
    detail: formatRegisterDetail(reg),
    module: reg.module,
    loadPolicy: reg.loadPolicy,
    status: reg.status,
  };
}

/**
 * Dry-run only: report each planned module once across sources. A later
 * source's planned registration of an already-planned module becomes
 * 'already-registered'. Known gap: a later source's dry-run routing does not
 * see the triggers planned by earlier sources; a real run does.
 */
export function dedupePlannedRegistrations(
  result: { registrations: ModuleRegistration[]; actions: Array<{ type: string }> },
  plannedSoFar: Set<string>,
): void {
  for (const reg of result.registrations) {
    if (reg.status !== 'planned') continue;
    if (!plannedSoFar.has(reg.module)) {
      plannedSoFar.add(reg.module);
      continue;
    }
    reg.status = 'already-registered';
    reg.reason = 'planned by an earlier source in this run; reported once';
    const action = result.actions.find((a): a is RegisterAction => a.type === 'REGISTER' && (a as RegisterAction).module === reg.module);
    if (action) {
      action.status = reg.status;
      action.detail = formatRegisterDetail(reg);
    }
  }
}

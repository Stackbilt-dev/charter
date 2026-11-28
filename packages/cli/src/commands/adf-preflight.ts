/**
 * Preflight answer for `charter adf context --files` (#447, first slice).
 *
 * Assembles what is real today -- the load-bearing rules of the on-demand
 * modules a file resolves (with source locations) and its live ceiling
 * headroom (#443) -- into one answer an agent reads before editing. Contract
 * (#445), first test (#444) and freshness (#440) are not built yet, so the
 * text output says `unknown` for them and the JSON leaves them out.
 *
 * Shared by the CLI and MCP `getProjectContext` so both give the same answer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAdf, resolveModules } from '@stackbilt/adf';
import type { Manifest, AdfSection } from '@stackbilt/adf';
import { computeFileCeilings, displayFrom } from './adf-ceilings';
import type { FileCeiling } from './adf-ceilings';
import { fileRoutingKeywords, relativizeFilePath, resolvePathTokenRoot } from './adf-path-tokens';

export interface BindingRule {
  module: string;
  section: string;
  rule: string;
  file: string;
  line: number;
}

/** A resolved on-demand module the ADF parser rejected; its rules are unknown. */
export interface UnreadableModule {
  module: string;
  file: string;
  reason: string;
}

export interface Preflight {
  rules: BindingRule[];
  ceilings: FileCeiling[];
  unreadable: UnreadableModule[];
}

/** Split a comma-separated --files value. */
export function splitFiles(filesFlag: string): string[] {
  return filesFlag.split(',').map(f => f.trim()).filter(Boolean);
}

/**
 * Labels for the files in the text answer: repo-relative where possible, so
 * `C:\repo\.github\workflows\ci.yml` and `.github/workflows/ci.yml` read the same.
 */
export function fileLabels(
  aiDir: string,
  files: string[],
  cwd: string = process.cwd(),
  root: string = resolvePathTokenRoot(aiDir, cwd),
): string[] {
  return files.map(f => relativizeFilePath(f, root, cwd) ?? f);
}

function sectionItems(section: AdfSection): string[] {
  const c = section.content;
  if (c.type === 'list') return c.items;
  if (c.type === 'map') return c.entries.map(e => `${e.key}: ${e.value}`);
  if (c.type === 'text') return c.value ? [c.value] : [];
  // Metric entries are reported through `ceilings`, measured live.
  return [];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches the section header line for `key` the way the ADF parser reads one
 * (SECTION_HEADER_RE): optional emoji, the key, optional
 * `[load-bearing]`/`[advisory]`, then `:`. Other text that merely mentions
 * the key never matches.
 */
export function sectionHeaderRe(key: string): RegExp {
  return new RegExp(
    `^(?:(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic})\\uFE0F*\\s+)?${escapeRegExp(key)}\\s*(?:\\[(?:load-bearing|advisory)\\]\\s*)?:`,
    'u',
  );
}

/**
 * Any section header, as the ADF parser's SECTION_HEADER_RE reads one. A
 * section's body runs until the next such line, so column-0 list items
 * (`- item`, which the parser accepts) stay inside their section.
 */
const ANY_SECTION_HEADER_RE =
  /^(?:(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})️*\s+)?[A-Z][A-Z0-9_]*(?:[ \t]+[A-Z0-9_]+)*\s*(?:\[(?:load-bearing|advisory)\]\s*)?:/u;

/**
 * 1-based line of each item in the `occurrence`-th section headed `key`;
 * an item not found falls back to the header line.
 */
export function locate(lines: string[], key: string, items: string[], occurrence = 0): number[] {
  const headerRe = sectionHeaderRe(key);
  let header = -1;
  for (let i = 0, seen = 0; i < lines.length; i++) {
    if (!headerRe.test(lines[i])) continue;
    if (seen++ === occurrence) { header = i; break; }
  }
  let cursor = header + 1;
  return items.map((item) => {
    for (let i = cursor; i < lines.length; i++) {
      if (ANY_SECTION_HEADER_RE.test(lines[i])) break;
      if (lines[i].includes(item)) {
        cursor = i + 1;
        return i + 1;
      }
    }
    return header + 1;
  });
}

export interface ModuleRules {
  rules: BindingRule[];
  unreadable: UnreadableModule[];
}

/**
 * Load-bearing rules of the resolved ON_DEMAND modules. DEFAULT_LOAD modules
 * apply to every file, so they are not what binds a particular one.
 *
 * A module the parser rejects goes to `unreadable` with the parser's reason
 * instead of failing the command: `adf context` without `--bundle` did not
 * parse modules before #447, so a parse error must not change its exit code.
 *
 * `root` is the repo root that `file` is shown relative to.
 */
export function readBindingRules(
  aiDir: string,
  manifest: Manifest,
  resolvedModules: string[],
  root: string = resolvePathTokenRoot(aiDir),
): ModuleRules {
  const onDemand = new Set(manifest.onDemand.map(m => m.path));
  const out: ModuleRules = { rules: [], unreadable: [] };
  for (const mod of resolvedModules) {
    if (!onDemand.has(mod) || manifest.defaultLoad.includes(mod)) continue;
    const modPath = path.resolve(aiDir, mod);
    if (!fs.existsSync(modPath)) continue;
    const file = displayFrom(root, modPath);
    const raw = fs.readFileSync(modPath, 'utf-8');
    let sections: AdfSection[];
    try {
      sections = parseAdf(raw).sections;
    } catch (err) {
      out.unreadable.push({ module: mod, file, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const seen = new Map<string, number>();
    for (const section of sections) {
      const occurrence = seen.get(section.key) ?? 0;
      seen.set(section.key, occurrence + 1);
      if (section.weight !== 'load-bearing') continue;
      const items = sectionItems(section);
      const at = locate(lines, section.key, items, occurrence);
      items.forEach((rule, i) => out.rules.push({ module: mod, section: section.key, rule, file, line: at[i] }));
    }
  }
  return out;
}

/** Rules only (kept for existing callers); see `readBindingRules` for unreadable modules. */
export function collectBindingRules(
  aiDir: string,
  manifest: Manifest,
  resolvedModules: string[],
): BindingRule[] {
  return readBindingRules(aiDir, manifest, resolvedModules).rules;
}

export function buildPreflight(
  aiDir: string,
  manifest: Manifest,
  resolvedModules: string[],
  files: string[],
  cwd: string = process.cwd(),
  root: string = resolvePathTokenRoot(aiDir, cwd),
): Preflight {
  // Locations are repo-relative, not cwd-relative, so the answer is the same
  // from any subdirectory and from `charter serve` (absolute aiDir). Rules,
  // ceilings and labels all resolve files against this one root.
  const { rules, unreadable } = readBindingRules(path.resolve(cwd, aiDir), manifest, resolvedModules, root);
  return {
    rules,
    ceilings: computeFileCeilings(aiDir, manifest, files, { cwd, root }),
    unreadable,
  };
}

/**
 * For each resolved on-demand module, the labels of the files whose own path
 * keywords trigger it. A module no single file triggers came from the task
 * or `--keywords` and maps to an empty list. Text output only.
 */
export function moduleFileAttribution(
  manifest: Manifest,
  resolvedModules: string[],
  files: string[],
  labels: string[],
  aiDir: string,
  cwd: string = process.cwd(),
  root: string = resolvePathTokenRoot(aiDir, cwd),
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const mod of resolvedModules) out.set(mod, []);
  files.forEach((f, i) => {
    for (const mod of resolveModules(manifest, fileRoutingKeywords([f], aiDir, cwd, root))) {
      out.get(mod)?.push(labels[i]);
    }
  });
  return out;
}

/** True when an on-demand module resolved or a ceiling tracks one of the files. */
export function preflightBinds(manifest: Manifest, resolvedModules: string[], p: Preflight): boolean {
  const onDemand = new Set(manifest.onDemand.map(m => m.path));
  return p.ceilings.length > 0 || resolvedModules.some(m => onDemand.has(m) && !manifest.defaultLoad.includes(m));
}

/** Human-readable preflight block. One short line when nothing binds the files. */
export function formatPreflight(
  manifest: Manifest,
  resolvedModules: string[],
  p: Preflight,
  files: string[],
  attribution?: Map<string, string[]>,
): string[] {
  if (!preflightBinds(manifest, resolvedModules, p)) {
    return [`Nothing binds ${files.join(', ')}: no on-demand module or ceiling applies. Default modules only.`];
  }
  const pad = '           ';
  const out: string[] = [];
  // With several files, name the file(s) each module and ceiling applies to.
  const many = files.length > 1;
  const onDemand = resolvedModules.filter(m => manifest.onDemand.some(o => o.path === m) && !manifest.defaultLoad.includes(m));
  const binds: string[] = [];
  for (const mod of onDemand) {
    const owners = attribution?.get(mod);
    // No suffix when the module applies to every file: the list would be noise.
    const forWhom = !many || !owners || owners.length === files.length ? ''
      : owners.length > 0 ? ` for ${owners.join(', ')}` : ' for the task keywords';
    const bad = p.unreadable.find(u => u.module === mod);
    if (bad) {
      binds.push(`${mod} (unreadable: ${bad.reason})  (${bad.file})${forWhom}`);
      continue;
    }
    const modRules = p.rules.filter(r => r.module === mod);
    if (modRules.length === 0) binds.push(`${mod} (no load-bearing rules)${forWhom}`);
    for (const r of modRules) binds.push(`${mod} → "${r.rule}"  (${r.file}:${r.line})${forWhom}`);
  }
  if (binds.length === 0) binds.push('no on-demand module (default modules only)');
  binds.forEach((b, i) => out.push(`${i === 0 ? 'Binds:     ' : pad}${b}`));

  const head = p.ceilings.length === 0
    ? [many ? 'no ceiling tracks these files' : 'no ceiling tracks this file']
    : p.ceilings.map(c => `${c.metric} ${c.value}/${c.ceiling} → ${c.headroom} lines left [${c.status}] (${c.module})${many ? ` for ${c.file}` : ''}`);
  head.forEach((h, i) => out.push(`${i === 0 ? 'Headroom:  ' : pad}${h}`));

  out.push('Contract:  unknown');
  out.push('Run first: unknown');
  out.push('Fresh:     unknown');
  return out;
}

export interface PreflightAnswer {
  preflight: Preflight;
  binds: boolean;
  /** The human-readable block, one line per entry. */
  lines: string[];
}

/**
 * Everything `--files` (CLI) and `files` (MCP) answer, from one repo root
 * lookup: rules, ceilings, labels and per-file attribution all resolve the
 * files the same way, so the answer is the same from any cwd.
 */
export function preflightAnswer(
  aiDir: string,
  manifest: Manifest,
  resolvedModules: string[],
  files: string[],
  cwd: string = process.cwd(),
  root: string = resolvePathTokenRoot(aiDir, cwd),
): PreflightAnswer {
  const preflight = buildPreflight(aiDir, manifest, resolvedModules, files, cwd, root);
  const labels = fileLabels(aiDir, files, cwd, root);
  const attribution = files.length > 1
    ? moduleFileAttribution(manifest, resolvedModules, files, labels, aiDir, cwd, root)
    : undefined;
  return {
    preflight,
    binds: preflightBinds(manifest, resolvedModules, preflight),
    lines: formatPreflight(manifest, resolvedModules, preflight, labels, attribution),
  };
}

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
import { parseAdf } from '@stackbilt/adf';
import type { Manifest, AdfSection } from '@stackbilt/adf';
import { computeFileCeilings } from './adf-ceilings';
import type { FileCeiling } from './adf-ceilings';

export interface BindingRule {
  module: string;
  section: string;
  rule: string;
  file: string;
  line: number;
}

export interface Preflight {
  rules: BindingRule[];
  ceilings: FileCeiling[];
}

/** Split a comma-separated --files value. */
export function splitFiles(filesFlag: string): string[] {
  return filesFlag.split(',').map(f => f.trim()).filter(Boolean);
}

function sectionItems(section: AdfSection): string[] {
  const c = section.content;
  if (c.type === 'list') return c.items;
  if (c.type === 'map') return c.entries.map(e => `${e.key}: ${e.value}`);
  if (c.type === 'text') return c.value ? [c.value] : [];
  // Metric entries are reported through `ceilings`, measured live.
  return [];
}

/** 1-based line of `item` in the section starting at `key`; falls back to the header line. */
function locate(lines: string[], key: string, items: string[]): number[] {
  const keyRe = new RegExp(`(^|[^A-Z_])${key}([^A-Z_]|$)`);
  const header = lines.findIndex(l => /^\S/.test(l) && keyRe.test(l) && l.includes(':'));
  let cursor = header + 1;
  return items.map((item) => {
    for (let i = cursor; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break;
      if (lines[i].includes(item)) {
        cursor = i + 1;
        return i + 1;
      }
    }
    return header + 1;
  });
}

/**
 * Repo-relative POSIX path, so the CLI (relative --ai-dir) and MCP serve
 * (absolute aiDir) report the same location. Absolute only outside cwd.
 */
function displayPath(p: string): string {
  const abs = path.resolve(p);
  const rel = path.relative(process.cwd(), abs);
  const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
  return shown.split(path.sep).join('/');
}

/**
 * Load-bearing rules of the resolved ON_DEMAND modules. DEFAULT_LOAD modules
 * apply to every file, so they are not what binds a particular one.
 */
export function collectBindingRules(
  aiDir: string,
  manifest: Manifest,
  resolvedModules: string[],
): BindingRule[] {
  const onDemand = new Set(manifest.onDemand.map(m => m.path));
  const rules: BindingRule[] = [];
  for (const mod of resolvedModules) {
    if (!onDemand.has(mod) || manifest.defaultLoad.includes(mod)) continue;
    const modPath = path.join(aiDir, mod);
    if (!fs.existsSync(modPath)) continue;
    const raw = fs.readFileSync(modPath, 'utf-8');
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const file = displayPath(modPath);
    for (const section of parseAdf(raw).sections) {
      if (section.weight !== 'load-bearing') continue;
      const items = sectionItems(section);
      const at = locate(lines, section.key, items);
      items.forEach((rule, i) => rules.push({ module: mod, section: section.key, rule, file, line: at[i] }));
    }
  }
  return rules;
}

export function buildPreflight(
  aiDir: string,
  manifest: Manifest,
  resolvedModules: string[],
  files: string[],
): Preflight {
  return {
    rules: collectBindingRules(aiDir, manifest, resolvedModules),
    ceilings: computeFileCeilings(aiDir, manifest, files),
  };
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
): string[] {
  if (!preflightBinds(manifest, resolvedModules, p)) {
    return [`Nothing binds ${files.join(', ')}: no on-demand module or ceiling applies. Default modules only.`];
  }
  const pad = '           ';
  const out: string[] = [];
  const onDemand = resolvedModules.filter(m => manifest.onDemand.some(o => o.path === m) && !manifest.defaultLoad.includes(m));
  const binds: string[] = [];
  for (const mod of onDemand) {
    const modRules = p.rules.filter(r => r.module === mod);
    if (modRules.length === 0) binds.push(`${mod} (no load-bearing rules)`);
    for (const r of modRules) binds.push(`${mod} → "${r.rule}"  (${r.file}:${r.line})`);
  }
  if (binds.length === 0) binds.push('no on-demand module (default modules only)');
  binds.forEach((b, i) => out.push(`${i === 0 ? 'Binds:     ' : pad}${b}`));

  const head = p.ceilings.length === 0
    ? ['no ceiling tracks this file']
    : p.ceilings.map(c => `${c.metric} ${c.value}/${c.ceiling} → ${c.headroom} lines left [${c.status}] (${c.module})`);
  head.forEach((h, i) => out.push(`${i === 0 ? 'Headroom:  ' : pad}${h}`));

  out.push('Contract:  unknown');
  out.push('Run first: unknown');
  out.push('Fresh:     unknown');
  return out;
}

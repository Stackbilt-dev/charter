/**
 * ADF health inspector — reads ADF modules after tidy has been applied
 * and reports on accumulation, section sizes, and potential issues.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SectionHealth {
  key: string;
  itemCount: number;
  weight: 'load-bearing' | 'advisory' | 'unknown';
}

export interface ModuleHealth {
  module: string;
  exists: boolean;
  totalItems: number;
  sections: SectionHealth[];
  rawLines: number;
}

export interface AdfSnapshot {
  sessionLabel: string;
  modules: ModuleHealth[];
  totalItemsAcrossAllModules: number;
  /** Modules with more items than the previous snapshot — where content is going */
  grew: string[];
}

export function inspectAdfModules(aiDir: string, sessionLabel: string, previous?: AdfSnapshot): AdfSnapshot {
  const adfFiles = fs.readdirSync(aiDir).filter(f => f.endsWith('.adf') && f !== 'manifest.adf');
  const modules: ModuleHealth[] = [];

  for (const file of adfFiles) {
    const content = fs.readFileSync(path.join(aiDir, file), 'utf-8');
    const health = parseModuleHealth(file, content);
    modules.push(health);
  }

  const totalItems = modules.reduce((s, m) => s + m.totalItems, 0);

  const grew: string[] = [];
  if (previous) {
    for (const mod of modules) {
      const prev = previous.modules.find(m => m.module === mod.module);
      if (prev && mod.totalItems > prev.totalItems) {
        grew.push(mod.module);
      }
    }
  }

  return { sessionLabel, modules, totalItemsAcrossAllModules: totalItems, grew };
}

function parseModuleHealth(filename: string, content: string): ModuleHealth {
  const lines = content.split('\n');
  const sections: SectionHealth[] = [];
  let currentSection: string | null = null;
  let currentItems = 0;
  let currentWeight: SectionHealth['weight'] = 'unknown';

  for (const line of lines) {
    const trimmed = line.trim();

    // Section header: e.g. "📐 CONSTRAINTS [load-bearing]:" or "📋 CONTEXT [advisory]:"
    const sectionMatch = trimmed.match(/^[📐📋⚠📖📁🔧🧬📊📝🎯]\s+(\w+)(?:\s+\[([^\]]+)\])?:/);
    if (sectionMatch) {
      if (currentSection !== null) {
        sections.push({ key: currentSection, itemCount: currentItems, weight: currentWeight });
      }
      currentSection = sectionMatch[1];
      const w = sectionMatch[2];
      currentWeight = w === 'load-bearing' ? 'load-bearing' : w === 'advisory' ? 'advisory' : 'unknown';
      currentItems = 0;
      continue;
    }

    // Bullet item
    if (trimmed.startsWith('- ') && currentSection !== null) {
      currentItems++;
    }
  }

  if (currentSection !== null) {
    sections.push({ key: currentSection, itemCount: currentItems, weight: currentWeight });
  }

  const totalItems = sections.reduce((s, sec) => s + sec.itemCount, 0);

  return {
    module: filename,
    exists: true,
    totalItems,
    sections,
    rawLines: lines.length,
  };
}

export function printSnapshot(snapshot: AdfSnapshot, previous?: AdfSnapshot): void {
  console.log(`\n    ADF state after: ${snapshot.sessionLabel}`);

  for (const mod of snapshot.modules) {
    const prev = previous?.modules.find(m => m.module === mod.module);
    const delta = prev !== undefined ? mod.totalItems - prev.totalItems : 0;
    const deltaStr = delta > 0 ? ` +${delta}` : delta < 0 ? ` ${delta}` : '';
    const grew = delta > 0 ? ' ←' : '';
    console.log(`    ${mod.module.padEnd(16)} ${mod.totalItems} items${deltaStr}${grew}`);

    for (const sec of mod.sections) {
      if (sec.itemCount === 0) continue;
      const prevSec = prev?.sections.find(s => s.key === sec.key);
      const secDelta = prevSec !== undefined ? sec.itemCount - prevSec.itemCount : 0;
      const secDeltaStr = secDelta > 0 ? ` +${secDelta}` : '';
      console.log(`      ${sec.key.padEnd(14)} ${sec.itemCount}${secDeltaStr} [${sec.weight}]`);
    }
  }
}

export function detectAccumulationIssues(snapshots: AdfSnapshot[]): string[] {
  const issues: string[] = [];
  if (snapshots.length < 2) return issues;

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];

  for (const mod of last.modules) {
    const start = first.modules.find(m => m.module === mod.module);
    if (!start) continue;

    const growth = mod.totalItems - start.totalItems;
    const growthRate = start.totalItems > 0 ? growth / start.totalItems : growth;

    if (growthRate > 2) {
      issues.push(`${mod.module}: grew ${growth} items (${(growthRate * 100).toFixed(0)}% increase) — possible accumulation`);
    }

    // Check any single section that got very large
    for (const sec of mod.sections) {
      if (sec.itemCount > 15) {
        issues.push(`${mod.module} > ${sec.key}: ${sec.itemCount} items — section may need pruning`);
      }
    }
  }

  // Check if core.adf is absorbing everything
  const coreStart = first.modules.find(m => m.module === 'core.adf')?.totalItems ?? 0;
  const coreLast = last.modules.find(m => m.module === 'core.adf')?.totalItems ?? 0;
  const otherStart = first.totalItemsAcrossAllModules - coreStart;
  const otherLast = last.totalItemsAcrossAllModules - coreLast;

  if (otherStart > 0 && coreLast > otherLast) {
    issues.push(`core.adf absorbing more than all domain modules combined — trigger keywords may need expansion`);
  }

  return issues;
}

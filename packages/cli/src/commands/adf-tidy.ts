/**
 * charter adf tidy
 *
 * Scans vendor config files for content beyond the thin pointer, classifies
 * and routes it to the appropriate ADF modules, and restores the thin pointer.
 * Designed as a composable primitive for the pre-commit hook (#24).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseAdf,
  formatAdf,
  applyPatches,
  parseManifest,
  parseMarkdownSections,
  isDuplicateItem,
  buildMigrationPlan,
} from '@stackbilt/adf';
import type { AdfDocument, PatchOperation, MigrationItem, TriggerMap } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { POINTER_MARKERS, POINTER_CLAUDE_MD, POINTER_CURSORRULES, POINTER_AGENTS_MD, POINTER_GEMINI_MD, POINTER_COPILOT_MD } from './adf';

// ============================================================================
// Constants
// ============================================================================

const VENDOR_FILES = [
  'CLAUDE.md',
  '.cursorrules',
  'agents.md',
  'AGENTS.md',
  'GEMINI.md',
  'copilot-instructions.md',
];

/** Lazy-init to avoid circular dependency with adf.ts at module load time. */
function getPointerTemplates(): Record<string, string> {
  return {
    'CLAUDE.md': POINTER_CLAUDE_MD,
    '.cursorrules': POINTER_CURSORRULES,
    'agents.md': POINTER_AGENTS_MD,
    'AGENTS.md': POINTER_AGENTS_MD,
    'GEMINI.md': POINTER_GEMINI_MD,
    'copilot-instructions.md': POINTER_COPILOT_MD,
  };
}

// ============================================================================
// Types
// ============================================================================

const SECTION_SIZE_WARN_THRESHOLD = 20;

interface TidyFileResult {
  file: string;
  status: 'clean' | 'tidied' | 'not-found';
  itemsExtracted: number;
  routing: Record<string, number>;
}

interface ModuleSizeWarning {
  module: string;
  section: string;
  itemCount: number;
}

interface TidyResult {
  dryRun: boolean;
  files: TidyFileResult[];
  totalExtracted: number;
  modulesModified: string[];
  moduleWarnings: ModuleSizeWarning[];
}

// ============================================================================
// Command Entry
// ============================================================================

export async function adfTidyCommand(options: CLIOptions, args: string[]): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const ciMode = args.includes('--ci');
  const sourceFile = getFlag(args, '--source');
  const aiDir = getFlag(args, '--ai-dir') || '.ai';

  // Determine which files to scan
  const targets = sourceFile
    ? [sourceFile]
    : VENDOR_FILES.filter(f => fs.existsSync(path.resolve(f)));

  if (targets.length === 0) {
    if (options.format === 'json') {
      console.log(JSON.stringify({ dryRun, files: [], totalExtracted: 0, modulesModified: [], moduleWarnings: [] }, null, 2));
    } else {
      console.log('  No vendor config files found.');
    }
    return EXIT_CODE.SUCCESS;
  }

  // Load trigger map from manifest
  const triggerMap = loadTriggerMap(aiDir);

  const fileResults: TidyFileResult[] = [];
  const allModuleGroups: Record<string, Record<string, MigrationItem[]>> = {};

  for (const file of targets) {
    const result = analyzeVendorFile(file, aiDir, triggerMap);

    if (!result) {
      fileResults.push({ file, status: 'not-found', itemsExtracted: 0, routing: {} });
      continue;
    }

    if (result.migrateItems.length === 0) {
      fileResults.push({ file, status: 'clean', itemsExtracted: 0, routing: {} });
      continue;
    }

    // Group items by module
    const moduleGroups = groupByModule(result.migrateItems);
    const routing: Record<string, number> = {};
    for (const [mod, sections] of Object.entries(moduleGroups)) {
      const count = Object.values(sections).reduce((sum, items) => sum + items.length, 0);
      routing[mod] = count;
      // Accumulate for batch write
      if (!allModuleGroups[mod]) allModuleGroups[mod] = {};
      for (const [sec, items] of Object.entries(sections)) {
        if (!allModuleGroups[mod][sec]) allModuleGroups[mod][sec] = [];
        allModuleGroups[mod][sec].push(...items);
      }
    }

    fileResults.push({
      file,
      status: 'tidied',
      itemsExtracted: result.migrateItems.length,
      routing,
    });

    // Restore thin pointer (if not dry-run)
    if (!dryRun) {
      restorePointer(file, result.stayItems);
    }
  }

  // Apply accumulated changes to ADF modules (if not dry-run)
  if (!dryRun) {
    for (const [module, sectionGroups] of Object.entries(allModuleGroups)) {
      const modulePath = path.join(aiDir, module);
      applyMigrationToModule(modulePath, sectionGroups);
    }
  }

  const totalExtracted = fileResults.reduce((sum, f) => sum + f.itemsExtracted, 0);
  const modulesModified = Object.keys(allModuleGroups);

  // Check module health — warn when sections grow past the threshold.
  // In dry-run mode project counts (current + incoming); otherwise read written files.
  const moduleWarnings: ModuleSizeWarning[] = dryRun
    ? projectModuleWarnings(aiDir, allModuleGroups)
    : scanModuleWarnings(aiDir, modulesModified);

  const result: TidyResult = { dryRun, files: fileResults, totalExtracted, modulesModified, moduleWarnings };

  // Output
  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTextResult(result);
  }

  // Exit codes: in --ci mode, exit 1 if bloat was found (for pre-commit gating)
  if (ciMode && totalExtracted > 0 && dryRun) {
    return EXIT_CODE.POLICY_VIOLATION;
  }

  return EXIT_CODE.SUCCESS;
}

// ============================================================================
// Analysis
// ============================================================================

interface AnalysisResult {
  migrateItems: MigrationItem[];
  stayItems: MigrationItem[];
}

function analyzeVendorFile(
  filePath: string,
  aiDir: string,
  triggerMap: TriggerMap | undefined,
): AnalysisResult | null {
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) return null;

  const content = fs.readFileSync(fullPath, 'utf-8');

  // If it's not a thin pointer at all, skip — use `adf migrate` instead
  if (!POINTER_MARKERS.some(marker => content.includes(marker))) {
    return null;
  }

  // Extract content beyond the thin pointer
  const beyondPointer = extractBeyondPointer(content, filePath);
  if (!beyondPointer.trim()) {
    return { migrateItems: [], stayItems: [] };
  }

  // Parse and classify the extracted content
  const sections = parseMarkdownSections(beyondPointer);

  // Load ALL existing ADF modules for dedup (not just core.adf — items may have
  // been routed to any domain module in a previous session).
  const existingAdf = loadAllAdfModules(aiDir);

  const plan = buildMigrationPlan(sections, existingAdf, triggerMap);
  return {
    migrateItems: plan.migrateItems,
    stayItems: plan.stayItems,
  };
}

/**
 * Extract content that was added beyond the thin pointer.
 *
 * Strategy: scan for H2 sections that aren't ## Environment — those are bloat.
 * Any content before the first H2 that isn't part of the pointer is also bloat.
 * The ## Environment section and its items are legitimate retained content.
 */
function extractBeyondPointer(content: string, fileName: string): string {
  const baseName = path.basename(fileName);
  const template = getPointerTemplates()[baseName];

  if (!template) return '';

  const lines = content.split('\n');
  const bloatLines: string[] = [];
  let inEnvironmentSection = false;
  let inPointerHeader = true; // Start true — skip the pointer preamble

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect pointer header lines — skip them
    if (inPointerHeader) {
      if (
        trimmed === '' ||
        trimmed.startsWith('#') && !trimmed.startsWith('## ') ||
        trimmed.startsWith('>') ||
        trimmed.startsWith('<!--') ||
        POINTER_MARKERS.some(m => trimmed.includes(m)) ||
        trimmed.includes('.ai/manifest.adf') ||
        trimmed.includes('auto-managed by Charter') ||
        trimmed.includes('module routing manifest') ||
        trimmed.includes('See `.ai/') ||
        trimmed.startsWith('See .ai/')
      ) {
        continue;
      }
      // Once we hit a non-pointer line, we're past the header
      if (trimmed.startsWith('## ')) {
        inPointerHeader = false;
        // Fall through to section detection below
      } else {
        inPointerHeader = false;
        // Non-header, non-section content — treat as bloat
        bloatLines.push(line);
        continue;
      }
    }

    // Section detection
    if (trimmed.startsWith('## ')) {
      if (trimmed === '## Environment') {
        inEnvironmentSection = true;
        continue;
      } else {
        inEnvironmentSection = false;
        // Non-Environment H2 section = bloat
        bloatLines.push(line);
        continue;
      }
    }

    if (inEnvironmentSection) {
      // Environment items are retained — not bloat
      continue;
    }

    // Everything else after the pointer that's not in ## Environment = bloat
    bloatLines.push(line);
  }

  return bloatLines.join('\n');
}

// ============================================================================
// Module Mutation (reused from adf-migrate pattern)
// ============================================================================

function groupByModule(
  items: MigrationItem[],
): Record<string, Record<string, MigrationItem[]>> {
  const result: Record<string, Record<string, MigrationItem[]>> = {};
  for (const item of items) {
    const mod = item.classification.targetModule;
    const sec = item.classification.targetSection;
    if (!result[mod]) result[mod] = {};
    if (!result[mod][sec]) result[mod][sec] = [];
    result[mod][sec].push(item);
  }
  return result;
}

function applyMigrationToModule(
  modulePath: string,
  sectionGroups: Record<string, MigrationItem[]>,
): void {
  let doc: AdfDocument;
  if (fs.existsSync(modulePath)) {
    doc = parseAdf(fs.readFileSync(modulePath, 'utf-8'));
  } else {
    doc = { version: '0.1', sections: [] };
  }

  const ops: PatchOperation[] = [];

  for (const [sectionKey, items] of Object.entries(sectionGroups)) {
    const existingSection = doc.sections.find(s => s.key === sectionKey);
    const weight = items.some(i => i.classification.weight === 'load-bearing')
      ? 'load-bearing' as const
      : 'advisory' as const;

    if (!existingSection) {
      const listItems = items.map(i => formatItemForAdf(i));
      ops.push({
        op: 'ADD_SECTION',
        key: sectionKey,
        content: { type: 'list', items: listItems },
        weight,
      });
    } else if (existingSection.content.type === 'text') {
      const existingText = existingSection.content.value.trim();
      const newItems = items.map(i => formatItemForAdf(i));
      ops.push({
        op: 'REPLACE_SECTION',
        key: sectionKey,
        content: { type: 'list', items: existingText ? [existingText, ...newItems] : newItems },
      });
    } else {
      for (const item of items) {
        const formatted = formatItemForAdf(item);
        // Dedup against existing content
        if (existingSection.content.type === 'list') {
          const isDup = existingSection.content.items.some(existing =>
            isDuplicateItem(existing, formatted)
          );
          if (isDup) continue;
        }
        ops.push({ op: 'ADD_BULLET', section: sectionKey, value: formatted });
      }
    }
  }

  if (ops.length > 0) {
    doc = applyPatches(doc, ops);
  }

  // Post-patch weight promotion
  for (const [sectionKey, items] of Object.entries(sectionGroups)) {
    if (items.some(i => i.classification.weight === 'load-bearing')) {
      const section = doc.sections.find(s => s.key === sectionKey);
      if (section && section.weight !== 'load-bearing') {
        section.weight = 'load-bearing';
      }
    }
  }

  fs.writeFileSync(modulePath, formatAdf(doc));
}

function formatItemForAdf(item: MigrationItem): string {
  const el = item.element;
  switch (el.type) {
    case 'rule':
      return el.content;
    case 'code-block':
      if (el.language === 'bash' || el.language === 'sh') {
        return `[Build commands] ${el.content.split('\n').filter(l => l.trim()).slice(0, 3).join('; ')}${el.content.split('\n').filter(l => l.trim()).length > 3 ? ' (...)' : ''}`;
      }
      return `[${el.language || 'code'}] ${el.content.split('\n')[0]}`;
    case 'table-row':
      return el.content;
    case 'prose':
      return el.content;
  }
}

// ============================================================================
// Pointer Restoration
// ============================================================================

/**
 * Format a STAY item for writing back into the vendor file's ## Environment section.
 * Headings (lines starting with #) are preserved as-is; everything else gets a - prefix.
 */
function formatStayItem(content: string): string {
  return content.trimStart().startsWith('#') ? content : `- ${content}`;
}

function restorePointer(filePath: string, stayItems: MigrationItem[]): void {
  const fullPath = path.resolve(filePath);
  const baseName = path.basename(filePath);
  let pointer = getPointerTemplates()[baseName];

  if (!pointer) {
    pointer = `# ${baseName}\n\n` +
      '> **DO NOT add rules, constraints, or context to this file.**\n' +
      '> All project rules are managed in `.ai/` by Charter.\n' +
      '> See `.ai/manifest.adf` for the module routing manifest.\n';
  }

  // Re-attach retained environment items
  const envItems = stayItems.filter(i =>
    i.classification.reason.includes('Environment') ||
    i.classification.reason.includes('runtime') ||
    i.classification.reason.includes('STAY')
  );

  if (envItems.length > 0) {
    const envSection = '\n## Environment\n' +
      envItems.map(i => formatStayItem(i.element.content)).join('\n') + '\n';

    if (pointer.includes('## Environment')) {
      pointer = pointer.replace(/## Environment[\s\S]*$/, envSection.trim() + '\n');
    } else {
      pointer += envSection;
    }
  }

  // Read current content to preserve any existing ## Environment items
  // that were already there (not extracted as bloat)
  const currentContent = fs.readFileSync(fullPath, 'utf-8');
  const currentLines = currentContent.split('\n');
  let inEnv = false;
  const existingEnvLines: string[] = [];
  for (const line of currentLines) {
    if (line.trim() === '## Environment') {
      inEnv = true;
      continue;
    }
    if (line.startsWith('## ') && line.trim() !== '## Environment') {
      inEnv = false;
    }
    if (inEnv && line.trim().startsWith('- ')) {
      existingEnvLines.push(line);
    }
  }

  // If we didn't extract any stay items but there are existing env lines, preserve them
  if (envItems.length === 0 && existingEnvLines.length > 0) {
    const envSection = '\n## Environment\n' + existingEnvLines.join('\n') + '\n';
    if (pointer.includes('## Environment')) {
      pointer = pointer.replace(/## Environment[\s\S]*$/, envSection.trim() + '\n');
    } else {
      pointer += envSection;
    }
  }

  fs.writeFileSync(fullPath, pointer);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Load and merge all .adf modules in aiDir into a single synthetic AdfDocument
 * for dedup checking. This ensures items previously routed to any domain module
 * (backend.adf, security.adf, etc.) are recognized as duplicates on re-injection.
 */
function loadAllAdfModules(aiDir: string): AdfDocument | undefined {
  if (!fs.existsSync(aiDir)) return undefined;

  const allSections: AdfDocument['sections'] = [];

  let files: string[];
  try {
    files = fs.readdirSync(aiDir).filter(f => f.endsWith('.adf') && f !== 'manifest.adf');
  } catch {
    return undefined;
  }

  for (const file of files) {
    try {
      const doc = parseAdf(fs.readFileSync(path.join(aiDir, file), 'utf-8'));
      allSections.push(...doc.sections);
    } catch {
      // skip unparseable modules
    }
  }

  if (allSections.length === 0) return undefined;
  return { sections: allSections } as AdfDocument;
}

/**
 * Scan written modules post-apply for sections that exceed the warning threshold.
 */
function scanModuleWarnings(aiDir: string, modules: string[]): ModuleSizeWarning[] {
  const warnings: ModuleSizeWarning[] = [];
  for (const mod of modules) {
    const p = path.join(aiDir, mod);
    if (!fs.existsSync(p)) continue;
    try {
      const doc = parseAdf(fs.readFileSync(p, 'utf-8'));
      for (const section of doc.sections) {
        if (section.content.type !== 'list') continue;
        const count = section.content.items.length;
        if (count >= SECTION_SIZE_WARN_THRESHOLD) {
          warnings.push({ module: mod, section: section.key, itemCount: count });
        }
      }
    } catch { /* skip unparseable */ }
  }
  return warnings;
}

/**
 * Project module sizes in dry-run mode: current items + incoming items per section.
 */
function projectModuleWarnings(
  aiDir: string,
  allModuleGroups: Record<string, Record<string, MigrationItem[]>>,
): ModuleSizeWarning[] {
  const warnings: ModuleSizeWarning[] = [];
  for (const [mod, sectionGroups] of Object.entries(allModuleGroups)) {
    const p = path.join(aiDir, mod);
    const currentCounts: Record<string, number> = {};
    if (fs.existsSync(p)) {
      try {
        const doc = parseAdf(fs.readFileSync(p, 'utf-8'));
        for (const section of doc.sections) {
          if (section.content.type === 'list') {
            currentCounts[section.key] = section.content.items.length;
          }
        }
      } catch { /* skip */ }
    }
    for (const [sectionKey, items] of Object.entries(sectionGroups)) {
      const projected = (currentCounts[sectionKey] ?? 0) + items.length;
      if (projected >= SECTION_SIZE_WARN_THRESHOLD) {
        warnings.push({ module: mod, section: sectionKey, itemCount: projected });
      }
    }
  }
  return warnings;
}

function loadTriggerMap(aiDir: string): TriggerMap | undefined {
  const manifestPath = path.join(aiDir, 'manifest.adf');
  if (!fs.existsSync(manifestPath)) return undefined;

  try {
    const manifestDoc = parseAdf(fs.readFileSync(manifestPath, 'utf-8'));
    const manifest = parseManifest(manifestDoc);
    const triggerMap: TriggerMap = {};
    for (const mod of manifest.onDemand) {
      if (mod.triggers.length > 0) {
        triggerMap[mod.path] = mod.triggers.map(t => t.toLowerCase());
      }
    }
    return triggerMap;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Output
// ============================================================================

function printTextResult(result: TidyResult): void {
  const tidied = result.files.filter(f => f.status === 'tidied');
  const clean = result.files.filter(f => f.status === 'clean');

  if (tidied.length === 0) {
    console.log('  All vendor files are clean.');
    return;
  }

  const label = result.dryRun ? 'Would tidy' : 'Tidied';
  console.log(`  ${label} ${tidied.length} vendor file(s):`);

  for (const f of tidied) {
    const routes = Object.entries(f.routing)
      .map(([mod, count]) => `${mod} (${count})`)
      .join(', ');
    console.log(`    ${f.file}: ${f.itemsExtracted} items \u2192 ${routes}`);
  }

  if (clean.length > 0) {
    console.log(`  ${clean.length} file(s) already clean.`);
  }

  if (result.moduleWarnings.length > 0) {
    console.log('');
    console.log('  ⚠ Module size warnings:');
    for (const w of result.moduleWarnings) {
      console.log(`    ${w.module} > ${w.section}: ${w.itemCount} items — consider running: charter adf prune`);
    }
  }

  if (result.dryRun) {
    console.log('');
    console.log('  Run without --dry-run to apply.');
  }
}

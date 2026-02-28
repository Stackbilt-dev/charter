/**
 * charter adf migrate
 *
 * Scans existing agent config files (CLAUDE.md, .cursorrules, agents.md, GEMINI.md,
 * copilot-instructions.md), classifies their content using the ADX-002 decision tree,
 * and migrates structured blocks into ADF modules. Replaces originals with thin pointers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseAdf,
  formatAdf,
  applyPatches,
  parseMarkdownSections,
  classifyElement,
  isDuplicateItem,
  buildMigrationPlan,
} from '@stackbilt/adf';
import type { AdfDocument, PatchOperation, MigrationItem } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { POINTER_CLAUDE_MD, POINTER_CURSORRULES, POINTER_AGENTS_MD } from './adf';

// ============================================================================
// Constants
// ============================================================================

const AGENT_CONFIG_FILES = [
  'CLAUDE.md',
  '.cursorrules',
  'agents.md',
  'GEMINI.md',
  'copilot-instructions.md',
];

const THIN_POINTER_MARKER = 'Do not duplicate ADF rules here';

const POINTER_TEMPLATES: Record<string, string> = {
  'CLAUDE.md': POINTER_CLAUDE_MD,
  '.cursorrules': POINTER_CURSORRULES,
  'agents.md': POINTER_AGENTS_MD,
};

// ============================================================================
// Command Entry
// ============================================================================

export async function adfMigrateCommand(options: CLIOptions, args: string[]): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const noBackup = args.includes('--no-backup');
  const sourceFile = getFlag(args, '--source');
  const mergeStrategy = (getFlag(args, '--merge-strategy') || 'dedupe') as 'append' | 'dedupe' | 'replace';
  const aiDir = getFlag(args, '--ai-dir') || '.ai';

  if (!['append', 'dedupe', 'replace'].includes(mergeStrategy)) {
    throw new CLIError(`Invalid --merge-strategy: ${mergeStrategy}. Use append, dedupe, or replace.`);
  }

  // Detect source files
  const sources = sourceFile
    ? [sourceFile]
    : AGENT_CONFIG_FILES.filter(f => fs.existsSync(path.resolve(f)));

  if (sources.length === 0) {
    if (options.format === 'json') {
      console.log(JSON.stringify({ migrated: false, reason: 'No agent config files found', scanned: AGENT_CONFIG_FILES }, null, 2));
    } else {
      console.log('  No agent config files found to migrate.');
      console.log(`  Looked for: ${AGENT_CONFIG_FILES.join(', ')}`);
    }
    return EXIT_CODE.SUCCESS;
  }

  const results: SourceMigrationResult[] = [];

  for (const source of sources) {
    const result = migrateSource(source, aiDir, mergeStrategy, dryRun, noBackup, options);
    results.push(result);
  }

  // Output
  if (options.format === 'json') {
    console.log(JSON.stringify({
      dryRun,
      mergeStrategy,
      sources: results,
    }, null, 2));
  } else {
    for (const r of results) {
      printTextResult(r, dryRun);
    }

    if (dryRun) {
      console.log('');
      console.log('  Run without --dry-run to apply.');
    }
  }

  return EXIT_CODE.SUCCESS;
}

// ============================================================================
// Per-source Migration
// ============================================================================

interface SourceMigrationResult {
  source: string;
  skipped: boolean;
  skipReason?: string;
  lineCount: number;
  sectionCount: number;
  plan?: ReturnType<typeof buildMigrationPlan>;
  actions: MigrationAction[];
}

interface MigrationAction {
  type: 'MERGE' | 'KEEP' | 'BACKUP' | 'SKIP';
  target: string;
  detail: string;
}

function migrateSource(
  sourcePath: string,
  aiDir: string,
  mergeStrategy: 'append' | 'dedupe' | 'replace',
  dryRun: boolean,
  noBackup: boolean,
  options: CLIOptions
): SourceMigrationResult {
  const fullPath = path.resolve(sourcePath);
  if (!fs.existsSync(fullPath)) {
    return {
      source: sourcePath,
      skipped: true,
      skipReason: 'File not found',
      lineCount: 0,
      sectionCount: 0,
      actions: [],
    };
  }

  const content = fs.readFileSync(fullPath, 'utf-8');

  // Skip if already a thin pointer
  if (content.includes(THIN_POINTER_MARKER)) {
    return {
      source: sourcePath,
      skipped: true,
      skipReason: 'Already a thin pointer',
      lineCount: content.split('\n').length,
      sectionCount: 0,
      actions: [{ type: 'SKIP', target: sourcePath, detail: 'Already a thin pointer' }],
    };
  }

  const lines = content.split('\n');
  const sections = parseMarkdownSections(content);

  // Load existing ADF for dedup
  let existingAdf: AdfDocument | undefined;
  const coreAdfPath = path.join(aiDir, 'core.adf');
  if (fs.existsSync(coreAdfPath) && mergeStrategy === 'dedupe') {
    try {
      existingAdf = parseAdf(fs.readFileSync(coreAdfPath, 'utf-8'));
    } catch {
      // If parse fails, proceed without dedup
    }
  }

  const plan = buildMigrationPlan(sections, existingAdf);
  const actions: MigrationAction[] = [];

  // Group migrate items by target module and section
  const moduleGroups = groupByModule(plan.migrateItems);

  for (const [module, sectionGroups] of Object.entries(moduleGroups)) {
    const counts = Object.entries(sectionGroups).map(
      ([sec, items]) => `${items.length} ${sec}`
    );
    actions.push({
      type: 'MERGE',
      target: path.join(aiDir, module),
      detail: `+${counts.join(', +')}`,
    });
  }

  if (plan.stayItems.length > 0) {
    const envItems = plan.stayItems.filter(i =>
      i.classification.reason.includes('Environment') || i.classification.reason.includes('runtime')
    );
    actions.push({
      type: 'KEEP',
      target: sourcePath,
      detail: `thin pointer + ${envItems.length} retained env rules`,
    });
  } else {
    actions.push({
      type: 'KEEP',
      target: sourcePath,
      detail: 'thin pointer (no retained items)',
    });
  }

  if (!noBackup) {
    actions.push({
      type: 'BACKUP',
      target: `${sourcePath}.pre-adf-migrate.bak`,
      detail: `Backup of ${sourcePath}`,
    });
  }

  // Apply if not dry-run
  if (!dryRun) {
    // Backup
    if (!noBackup) {
      fs.writeFileSync(`${fullPath}.pre-adf-migrate.bak`, content);
    }

    // Ensure .ai/ exists
    fs.mkdirSync(aiDir, { recursive: true });

    // Merge into ADF modules
    for (const [module, sectionGroups] of Object.entries(moduleGroups)) {
      const modulePath = path.join(aiDir, module);
      applyMigrationToModule(modulePath, sectionGroups, mergeStrategy);
    }

    // Write thin pointer with retained STAY items
    writePointerWithRetained(fullPath, sourcePath, plan.stayItems);
  }

  return {
    source: sourcePath,
    skipped: false,
    lineCount: lines.length,
    sectionCount: sections.length,
    plan,
    actions,
  };
}

// ============================================================================
// ADF Module Mutation
// ============================================================================

function groupByModule(
  items: MigrationItem[]
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
  mergeStrategy: 'append' | 'dedupe' | 'replace'
): void {
  // Load or create module document
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
      // Add new section with all items as list
      const listItems = items.map(i => formatItemForAdf(i));
      ops.push({
        op: 'ADD_SECTION',
        key: sectionKey,
        content: { type: 'list', items: listItems },
        weight,
      });
    } else {
      // Add individual bullets to existing section
      for (const item of items) {
        const formatted = formatItemForAdf(item);

        // Dedup check for existing content
        if (mergeStrategy === 'dedupe' && existingSection.content.type === 'list') {
          const isDup = existingSection.content.items.some(existing =>
            isDuplicateItem(existing, formatted)
          );
          if (isDup) continue;
        }

        if (mergeStrategy === 'replace') {
          // Replace strategy: skip adds to existing sections (they get replaced below)
          continue;
        }

        ops.push({
          op: 'ADD_BULLET',
          section: sectionKey,
          value: formatted,
        });
      }

      // Weight promotion
      if (weight === 'load-bearing' && existingSection.weight !== 'load-bearing') {
        // We can't directly update weight via patch, so we handle it post-patch
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
      // Represent code blocks as a concise description
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
// Pointer Generation
// ============================================================================

function writePointerWithRetained(
  fullPath: string,
  fileName: string,
  stayItems: MigrationItem[]
): void {
  const baseName = path.basename(fileName);
  let pointer = POINTER_TEMPLATES[baseName];

  if (!pointer) {
    // Generic pointer for files without a template
    pointer = `# ${baseName}\n\n` +
      '> This project uses [ADF](https://github.com/Stackbilt-dev/charter) for AI agent context management.\n' +
      '> All stack rules, constraints, and architectural guidance live in `.ai/`.\n' +
      '> **Do not duplicate ADF rules here.**\n\n' +
      'See `.ai/manifest.adf` for the module routing manifest.\n';
  }

  // Add retained env items
  const envItems = stayItems.filter(i =>
    i.classification.reason.includes('Environment') ||
    i.classification.reason.includes('runtime') ||
    i.classification.reason.includes('STAY')
  );

  if (envItems.length > 0) {
    // If pointer already has ## Environment, replace that section
    // Otherwise append
    const envSection = '\n## Environment\n' +
      envItems.map(i => `- ${i.element.content}`).join('\n') + '\n';

    if (pointer.includes('## Environment')) {
      // Replace from ## Environment to end (or next ##)
      pointer = pointer.replace(/## Environment[\s\S]*$/, envSection.trim() + '\n');
    } else {
      pointer += envSection;
    }
  }

  fs.writeFileSync(fullPath, pointer);
}

// ============================================================================
// Output
// ============================================================================

function printTextResult(result: SourceMigrationResult, dryRun: boolean): void {
  console.log(`  Source: ${result.source} (${result.lineCount} lines, ${result.sectionCount} sections)`);

  if (result.skipped) {
    console.log(`    Skipped: ${result.skipReason}`);
    console.log('');
    return;
  }

  if (result.plan) {
    // Print per-section breakdown
    for (const item of result.plan.items) {
      const arrow = item.classification.decision === 'STAY' ? 'STAY' : item.classification.targetSection;
      const weight = item.classification.decision === 'MIGRATE' ? ` [${item.classification.weight}]` : '';
      const module = item.classification.decision === 'MIGRATE' ? `  ${item.classification.targetModule}` : '';
      const reason = item.classification.decision === 'STAY' ? ` (${item.classification.reason})` : '';
      const preview = item.element.content.length > 50
        ? item.element.content.slice(0, 47) + '...'
        : item.element.content;
      console.log(`    "${preview}"  → ${arrow}${weight}${module}${reason}`);
    }
    console.log('');

    // Print plan summary
    console.log('  Plan:');
    for (const action of result.actions) {
      console.log(`    ${action.type} ${action.target}  (${action.detail})`);
    }
  }
  console.log('');
}

// ============================================================================
// Helpers
// ============================================================================


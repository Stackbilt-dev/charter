/**
 * charter adf populate
 *
 * Auto-fills ADF context files from codebase signals:
 * package.json, README.md, and stack detection.
 *
 * Replaces scaffold placeholder content with project-specific context.
 * Skips sections that have already been customized (unless --force).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAdf, formatAdf, applyPatches } from '@stackbilt/adf';
import type { AdfSection, PatchOperation } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import {
  loadPackageContexts,
  detectStack,
  inferProjectName,
  type PackageContext,
  type DetectionResult,
} from './setup';

// ============================================================================
// Scaffold markers — used to detect un-authored placeholder content
// ============================================================================

const SCAFFOLD_MARKERS = [
  'Frontend module scaffold',
  'Backend module scaffold',
  'Module scaffold',
  'Add framework-specific constraints',
  'Add service/API/database constraints',
  'Add project-specific rules',
  "run 'charter adf populate'",
  'Project context (run',
  'Repository initialized with ADF context system',
  'Configure on-demand modules for your stack',
];

function hasScaffoldContent(section: AdfSection): boolean {
  const text = sectionText(section);
  return SCAFFOLD_MARKERS.some(m => text.includes(m));
}

function sectionText(section: AdfSection): string {
  switch (section.content.type) {
    case 'list': return section.content.items.join('\n');
    case 'text': return section.content.value;
    case 'map': return section.content.entries.map(e => `${e.key}: ${e.value}`).join('\n');
    default: return '';
  }
}

// ============================================================================
// Command Entry
// ============================================================================

export async function adfPopulateCommand(options: CLIOptions, args: string[]): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const force = options.yes || args.includes('--force');
  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const manifestPath = path.join(aiDir, 'manifest.adf');

  if (!fs.existsSync(manifestPath)) {
    throw new CLIError(`manifest.adf not found at ${manifestPath}. Run 'charter adf init' first.`);
  }

  // Gather codebase signals
  const contexts = loadPackageContexts();
  const detection = detectStack(contexts);
  const projectName = inferProjectName(contexts) || path.basename(process.cwd());
  const rootPkg = readRootPackageJson();
  const description = rootPkg?.description;
  const readmeSummary = readReadmeSummary();

  const results: Array<{ file: string; ops: number; status: 'populated' | 'skipped' | 'missing' }> = [];

  const fileTasks: Array<{ file: string; build: () => PatchOperation[] | null }> = [
    {
      file: path.join(aiDir, 'core.adf'),
      build: () => buildCoreOps(aiDir, projectName, description, readmeSummary, detection, contexts, force),
    },
    {
      file: path.join(aiDir, 'state.adf'),
      build: () => buildStateOps(aiDir, detection, force),
    },
    {
      file: path.join(aiDir, 'backend.adf'),
      build: () => buildBackendOps(aiDir, detection, force),
    },
    {
      file: path.join(aiDir, 'frontend.adf'),
      build: () => buildFrontendOps(aiDir, detection, force),
    },
  ];

  for (const task of fileTasks) {
    if (!fs.existsSync(task.file)) {
      results.push({ file: task.file, ops: 0, status: 'missing' });
      continue;
    }

    const ops = task.build();
    if (!ops || ops.length === 0) {
      results.push({ file: task.file, ops: 0, status: 'skipped' });
      continue;
    }

    if (!dryRun) {
      const input = fs.readFileSync(task.file, 'utf-8');
      const doc = parseAdf(input);
      const patched = applyPatches(doc, ops);
      fs.writeFileSync(task.file, formatAdf(patched));
    }

    results.push({ file: task.file, ops: ops.length, status: 'populated' });
  }

  if (options.format === 'json') {
    console.log(JSON.stringify({
      dryRun,
      projectName,
      detection: {
        preset: detection.suggestedPreset,
        confidence: detection.confidence,
        runtime: detection.runtime,
        frameworks: detection.frameworks,
      },
      results,
    }, null, 2));
  } else {
    const prefix = dryRun ? '[dry-run] ' : '';
    console.log(`  ${prefix}ADF context populated from codebase signals:`);
    console.log(`    Project: ${projectName}${description ? ' — ' + description : ''}`);
    console.log(`    Stack: ${detection.suggestedPreset} (${detection.confidence} confidence)`);
    if (detection.frameworks.length > 0) {
      console.log(`    Frameworks: ${detection.frameworks.join(', ')}`);
    }
    console.log('');
    for (const r of results) {
      if (r.status === 'missing') continue;
      const icon = r.status === 'populated' ? '[ok]' : '[skip]';
      const detail = r.status === 'populated'
        ? `${r.ops} op${r.ops === 1 ? '' : 's'} applied`
        : 'already customized — use --force to overwrite';
      console.log(`    ${icon} ${r.file}  (${detail})`);
    }
    if (dryRun) {
      console.log('');
      console.log('  Run without --dry-run to apply.');
    }
  }

  return EXIT_CODE.SUCCESS;
}

// ============================================================================
// core.adf ops
// ============================================================================

function buildCoreOps(
  aiDir: string,
  projectName: string,
  description: string | undefined,
  readmeSummary: string | undefined,
  detection: DetectionResult,
  contexts: PackageContext[],
  force: boolean
): PatchOperation[] | null {
  const filePath = path.join(aiDir, 'core.adf');
  const input = fs.readFileSync(filePath, 'utf-8');
  const doc = parseAdf(input);
  const ops: PatchOperation[] = [];

  // Build CONTEXT items from signals
  const contextItems: string[] = [
    `project: ${projectName}${description ? ' — ' + description : ''}`,
  ];
  if (readmeSummary) contextItems.push(readmeSummary);
  if (detection.runtime.length > 0) contextItems.push(`runtime: ${detection.runtime.join(', ')}`);
  if (detection.frameworks.length > 0) contextItems.push(`stack: ${detection.frameworks.join(', ')}`);
  if (detection.monorepo) contextItems.push('monorepo: true');

  const contextSection = doc.sections.find(s => s.key === 'CONTEXT');
  if (!contextSection) {
    ops.push({
      op: 'ADD_SECTION',
      key: 'CONTEXT',
      decoration: '\u{1F4CB}',
      content: { type: 'list', items: contextItems },
    });
  } else if (force || hasScaffoldContent(contextSection)) {
    ops.push({
      op: 'REPLACE_SECTION',
      key: 'CONTEXT',
      content: { type: 'list', items: contextItems },
    });
  }

  // Add stack-specific constraints (additive, never overwrite existing)
  const constraintsSection = doc.sections.find(s => s.key === 'CONSTRAINTS');
  if (constraintsSection && constraintsSection.content.type === 'list') {
    const existingItems = constraintsSection.content.items;

    const addConstraint = (value: string, matchFn: (item: string) => boolean) => {
      if (!existingItems.some(matchFn)) {
        ops.push({ op: 'ADD_BULLET', section: 'CONSTRAINTS', value });
      }
    };

    // ESM: detect type: "module" in any package.json
    const isEsm = contexts.some(ctx => {
      try {
        const pkg = JSON.parse(fs.readFileSync(ctx.source, 'utf-8'));
        return pkg.type === 'module';
      } catch { return false; }
    });
    if (isEsm) {
      addConstraint(
        'Use .js extensions for all ESM imports (never .ts in import paths)',
        item => item.includes('.js extensions') || (item.includes('ESM') && item.includes('import'))
      );
    }

    if (detection.signals.hasCloudflare) {
      addConstraint(
        'No Node.js-specific APIs in Worker handlers; use CF-native APIs (fetch, KV, D1, R2)',
        item => item.includes('Worker handler') || (item.includes('Node') && item.includes('CF'))
      );
    }

    if (detection.signals.hasPnpm && detection.monorepo) {
      addConstraint(
        'Internal packages use pnpm workspace:^ protocol, never relative paths',
        item => item.includes('workspace') || (item.includes('pnpm') && item.includes('package'))
      );
    }
  }

  return ops.length > 0 ? ops : null;
}

// ============================================================================
// state.adf ops
// ============================================================================

function buildStateOps(
  aiDir: string,
  detection: DetectionResult,
  force: boolean
): PatchOperation[] | null {
  const filePath = path.join(aiDir, 'state.adf');
  const input = fs.readFileSync(filePath, 'utf-8');
  const doc = parseAdf(input);

  const stateSection = doc.sections.find(s => s.key === 'STATE');
  if (!stateSection) return null;
  if (!force && !hasScaffoldContent(stateSection)) return null;

  const stackSummary = [
    ...detection.runtime,
    ...detection.frameworks,
  ].join(', ') || detection.suggestedPreset;

  return [{
    op: 'REPLACE_SECTION',
    key: 'STATE',
    content: {
      type: 'map',
      entries: [
        { key: 'CURRENT', value: `Charter initialized — ${stackSummary} project` },
        { key: 'NEXT', value: 'Author project-specific constraints in core.adf' },
      ],
    },
  }];
}

// ============================================================================
// backend.adf ops
// ============================================================================

function buildBackendOps(
  aiDir: string,
  detection: DetectionResult,
  force: boolean
): PatchOperation[] | null {
  const filePath = path.join(aiDir, 'backend.adf');
  if (!fs.existsSync(filePath)) return null;

  const input = fs.readFileSync(filePath, 'utf-8');
  const doc = parseAdf(input);

  const contextSection = doc.sections.find(s => s.key === 'CONTEXT');
  if (contextSection && !force && !hasScaffoldContent(contextSection)) return null;

  const items: string[] = [];
  if (detection.signals.hasWorker || detection.signals.hasCloudflare) {
    items.push('Cloudflare Workers edge runtime (wrangler deploy)');
  }
  if (detection.signals.hasHono) {
    items.push('Hono for route composition — typed, lightweight, edge-compatible');
  }
  if (!detection.signals.hasWorker && detection.signals.hasBackend) {
    items.push('Node.js backend service with typed request boundaries');
  }
  if (items.length === 0) {
    items.push('Backend module — add service/API/database constraints and rules');
  }

  const op: PatchOperation = contextSection
    ? { op: 'REPLACE_SECTION', key: 'CONTEXT', content: { type: 'list', items } }
    : { op: 'ADD_SECTION', key: 'CONTEXT', decoration: '\u{1F4CB}', content: { type: 'list', items } };

  return [op];
}

// ============================================================================
// frontend.adf ops
// ============================================================================

function buildFrontendOps(
  aiDir: string,
  detection: DetectionResult,
  force: boolean
): PatchOperation[] | null {
  const filePath = path.join(aiDir, 'frontend.adf');
  if (!fs.existsSync(filePath)) return null;

  const input = fs.readFileSync(filePath, 'utf-8');
  const doc = parseAdf(input);

  const contextSection = doc.sections.find(s => s.key === 'CONTEXT');
  if (contextSection && !force && !hasScaffoldContent(contextSection)) return null;

  const items: string[] = [];
  if (detection.signals.hasReact) items.push('React component model (hooks-based, no class components)');
  if (detection.signals.hasVite) items.push('Vite for build tooling and dev server');
  if (items.length === 0) {
    items.push('Frontend module — add framework-specific constraints and rules');
  }

  const op: PatchOperation = contextSection
    ? { op: 'REPLACE_SECTION', key: 'CONTEXT', content: { type: 'list', items } }
    : { op: 'ADD_SECTION', key: 'CONTEXT', decoration: '\u{1F4CB}', content: { type: 'list', items } };

  return [op];
}

// ============================================================================
// Helpers
// ============================================================================

function readRootPackageJson(): { name?: string; description?: string; type?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function readReadmeSummary(): string | undefined {
  for (const name of ['README.md', 'readme.md', 'Readme.md']) {
    try {
      const content = fs.readFileSync(path.resolve(name), 'utf-8');
      const lines = content.split('\n');
      let inParagraph = false;
      const paragraphLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith('#')) continue;
        if (line.trim() === '') {
          if (inParagraph) break;
          continue;
        }
        inParagraph = true;
        paragraphLines.push(line.trim());
        if (paragraphLines.length >= 2) break;
      }

      if (paragraphLines.length > 0) {
        const summary = paragraphLines.join(' ');
        return summary.length > 120 ? summary.slice(0, 117) + '...' : summary;
      }
    } catch { /* file not found */ }
  }
  return undefined;
}

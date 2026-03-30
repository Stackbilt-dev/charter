/**
 * charter doctor
 *
 * Prints environment and configuration diagnostics for humans and agents.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { loadPatterns } from '../config';
import { parseAdf, parseManifest, stripCharterSentinels } from '@stackbilt/adf';
import { isGitRepo } from '../git-helpers';
import { POINTER_MARKERS } from './adf';

interface DoctorResult {
  status: 'PASS' | 'WARN';
  checks: Array<{
    name: string;
    status: 'PASS' | 'WARN' | 'INFO';
    details: string;
  }>;
}

export async function doctorCommand(options: CLIOptions, args: string[] = []): Promise<number> {
  const checks: DoctorResult['checks'] = [];
  const adfOnly = args.includes('--adf-only');
  const configFile = path.join(options.configPath, 'config.json');
  const inGitRepo = isGitRepo();

  checks.push({
    name: 'git repository',
    status: inGitRepo ? 'PASS' : 'WARN',
    details: inGitRepo ? 'Repository detected.' : 'Not inside a git repository.',
  });

  if (!adfOnly) {
    const hasConfig = fs.existsSync(configFile);
    checks.push({
      name: 'config file',
      status: hasConfig ? 'PASS' : 'WARN',
      details: hasConfig ? `${configFile} exists.` : `${configFile} not found. Run charter setup.`,
    });

    if (hasConfig) {
      checks.push(validateJSONConfig(configFile));
    }

    const patterns = loadPatterns(options.configPath);
    checks.push({
      name: 'patterns',
      status: patterns.length > 0 ? 'PASS' : 'WARN',
      details: patterns.length > 0
        ? `${patterns.length} pattern(s) loaded.`
        : 'No patterns found in .charter/patterns/*.json.',
    });

    const policyDir = path.join(options.configPath, 'policies');
    const policyCount = fs.existsSync(policyDir)
      ? fs.readdirSync(policyDir).filter((f) => f.endsWith('.md')).length
      : 0;

    checks.push({
      name: 'policy docs',
      status: policyCount > 0 ? 'PASS' : 'WARN',
      details: policyCount > 0 ? `${policyCount} markdown policy file(s).` : 'No policy markdown files found.',
    });
  }

  // ADF readiness checks
  const aiDir = '.ai';
  const manifestPath = path.join(aiDir, 'manifest.adf');
  const hasManifest = fs.existsSync(manifestPath);

  checks.push({
    name: 'adf manifest',
    status: hasManifest ? 'PASS' : 'WARN',
    details: hasManifest ? `${manifestPath} exists.` : `${manifestPath} not found. Run: charter adf init`,
  });

  if (hasManifest) {
    try {
      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifestDoc = parseAdf(manifestContent);
      const manifest = parseManifest(manifestDoc);

      checks.push({
        name: 'adf manifest parse',
        status: 'PASS',
        details: `Parsed: ${manifest.defaultLoad.length} default-load, ${manifest.onDemand.length} on-demand module(s).`,
      });

      // Required baseline wiring for a standard ADF repo
      const requiredDefaultModules = ['core.adf', 'state.adf'];
      const missingRequired = requiredDefaultModules.filter(mod => !manifest.defaultLoad.includes(mod));
      checks.push({
        name: 'adf required wiring',
        status: missingRequired.length === 0 ? 'PASS' : 'WARN',
        details: missingRequired.length === 0
          ? 'Required default-load modules present (core.adf, state.adf).'
          : `Missing from DEFAULT_LOAD: ${missingRequired.join(', ')}`,
      });

      // Check that all defaultLoad modules exist and parse
      const missingModules: string[] = [];
      for (const mod of manifest.defaultLoad) {
        const modPath = path.join(aiDir, mod);
        if (!fs.existsSync(modPath)) {
          missingModules.push(mod);
        } else {
          try {
            parseAdf(fs.readFileSync(modPath, 'utf-8'));
          } catch {
            missingModules.push(`${mod} (parse error)`);
          }
        }
      }

      checks.push({
        name: 'adf default modules',
        status: missingModules.length === 0 ? 'PASS' : 'WARN',
        details: missingModules.length === 0
          ? `All ${manifest.defaultLoad.length} default-load module(s) present and parseable.`
          : `Missing or unparseable: ${missingModules.join(', ')}`,
      });

      // Check that on-demand modules exist and parse (missing modules are warnings)
      const onDemandPaths = [...new Set(manifest.onDemand.map(m => m.path))];
      const onDemandIssues: string[] = [];
      for (const mod of onDemandPaths) {
        const modPath = path.join(aiDir, mod);
        if (!fs.existsSync(modPath)) {
          onDemandIssues.push(`${mod} (missing)`);
          continue;
        }
        try {
          parseAdf(fs.readFileSync(modPath, 'utf-8'));
        } catch {
          onDemandIssues.push(`${mod} (parse error)`);
        }
      }
      checks.push({
        name: 'adf on-demand modules',
        status: onDemandIssues.length === 0 ? 'PASS' : 'WARN',
        details: onDemandIssues.length === 0
          ? `All ${onDemandPaths.length} on-demand module(s) present and parseable.`
          : `Missing or unparseable: ${onDemandIssues.join(', ')}`,
      });

      // Agent config pointer check: flag files with stack rules that should be in .ai/
      const AGENT_CONFIG_FILES = ['CLAUDE.md', '.cursorrules', 'agents.md', 'AGENTS.md', 'GEMINI.md', 'copilot-instructions.md'];
      const nonPointerFiles: string[] = [];
      const pointerFiles: Array<{ file: string; content: string }> = [];
      for (const file of AGENT_CONFIG_FILES) {
        if (fs.existsSync(file)) {
          const content = fs.readFileSync(file, 'utf-8');
          const isPointer = POINTER_MARKERS.some(marker => content.includes(marker));
          if (!isPointer) {
            nonPointerFiles.push(file);
          } else {
            pointerFiles.push({ file, content });
          }
        }
      }
      if (nonPointerFiles.length > 0) {
        checks.push({
          name: 'adf agent config',
          status: 'WARN',
          details: `${nonPointerFiles.join(', ')} contain${nonPointerFiles.length === 1 ? 's' : ''} stack rules that should live in .ai/. Run: charter adf migrate --dry-run`,
        });
      } else {
        const pointerCount = pointerFiles.length;
        if (pointerCount > 0) {
          checks.push({
            name: 'adf agent config',
            status: 'PASS',
            details: `${pointerCount} agent config file(s) are thin pointers to .ai/.`,
          });
        }
      }

      // Vendor file bloat detection: line count, section overlap, keyword density
      const BLOAT_LINE_THRESHOLD = 80;
      const bloatWarnings: string[] = [];

      // Collect ADF section keys for overlap detection
      const adfSectionKeys = new Set<string>();
      const allModulePaths = [...manifest.defaultLoad, ...manifest.onDemand.map(m => m.path)];
      for (const mod of allModulePaths) {
        const modPath = path.join(aiDir, mod);
        if (fs.existsSync(modPath)) {
          try {
            const modDoc = parseAdf(fs.readFileSync(modPath, 'utf-8'));
            for (const sec of modDoc.sections) {
              adfSectionKeys.add(sec.key.toLowerCase());
            }
          } catch { /* skip unparseable */ }
        }
      }

      // Collect trigger keywords for density check
      const triggerKeywords: Array<{ keyword: string; module: string }> = [];
      for (const mod of manifest.onDemand) {
        for (const trigger of mod.triggers) {
          triggerKeywords.push({ keyword: trigger.toLowerCase(), module: mod.path });
        }
      }

      for (const { file, content } of pointerFiles) {
        // Strip charter-managed sentinel blocks before scanning for bloat/keywords.
        const strippedContent = stripCharterSentinels(content);
        const lines = strippedContent.split('\n');
        const lineCount = lines.length;
        const fileWarnings: string[] = [];

        // 1. Line count threshold
        if (lineCount > BLOAT_LINE_THRESHOLD) {
          fileWarnings.push(`${lineCount} lines (threshold: ${BLOAT_LINE_THRESHOLD})`);
        }

        // 2. Section overlap detection — find H2 headers that match ADF section keys
        const h2Sections = lines
          .filter(l => l.trim().startsWith('## '))
          .map(l => l.trim().replace(/^## /, ''))
          .filter(h => h !== 'Environment'); // Environment is legitimate

        for (const header of h2Sections) {
          const headerLower = header.toLowerCase();
          for (const adfKey of adfSectionKeys) {
            const keyWords = adfKey.toLowerCase().split(/[_\s]+/);
            if (keyWords.some(w => w.length > 3 && headerLower.includes(w))) {
              fileWarnings.push(`"${header}" section overlaps ADF section "${adfKey}"`);
              break;
            }
          }
        }

        // 3. Keyword density — check for trigger keyword concentration
        // Exclude pointer preamble lines (blockquotes, comments, marker lines)
        const nonPointerContent = lines.filter(l => {
          const t = l.trim();
          if (t.startsWith('>') || t.startsWith('<!--') || t.startsWith('#') && !t.startsWith('## ')) return false;
          if (POINTER_MARKERS.some(m => t.includes(m))) return false;
          if (t.includes('.ai/manifest.adf') || t.includes('auto-managed by Charter')) return false;
          return true;
        }).join('\n');
        const contentLower = nonPointerContent.toLowerCase();
        const matchedModules = new Map<string, string[]>();
        for (const { keyword, module } of triggerKeywords) {
          // Count occurrences (word boundary match)
          const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
          const matches = contentLower.match(regex);
          if (matches && matches.length >= 2) {
            if (!matchedModules.has(module)) matchedModules.set(module, []);
            matchedModules.get(module)!.push(`${keyword} (${matches.length}x)`);
          }
        }
        for (const [mod, keywords] of matchedModules) {
          fileWarnings.push(`trigger keywords [${keywords.join(', ')}] suggest content belongs in ${mod}`);
        }

        if (fileWarnings.length > 0) {
          bloatWarnings.push(`${file}: ${fileWarnings.join('; ')}`);
        }
      }

      if (bloatWarnings.length > 0) {
        checks.push({
          name: 'adf vendor bloat',
          status: 'WARN',
          details: `Vendor file bloat detected:\n    ${bloatWarnings.join('\n    ')}\n    Run: charter adf tidy --dry-run`,
        });
      } else if (pointerFiles.length > 0) {
        checks.push({
          name: 'adf vendor bloat',
          status: 'PASS',
          details: `${pointerFiles.length} vendor file(s) within bloat thresholds.`,
        });
      }

      // Cold-start check: thin pointers with no architectural orientation (#41)
      // A pointer that's <15 lines and contains no stack/framework keywords gives
      // agents zero context about the project. Soft [info] — does not fail doctor.
      //
      // HOWEVER: if the file is a validated thin pointer to a populated .ai/
      // directory with modules, the pointer IS doing its job — agents get context
      // from .ai/ modules, not from the pointer file. Suppress in that case (#72).
      const STACK_KEYWORDS = /\b(react|vue|svelte|next|nuxt|astro|remix|angular|node|bun|deno|python|go|rust|postgres|mysql|sqlite|d1|prisma|drizzle|hono|express|fastify|trpc|cloudflare|vercel|railway|docker|kubernetes)\b/i;
      const hasPopulatedModules = allModulePaths.length > 0;
      for (const { file, content } of pointerFiles) {
        const lineCount = content.split('\n').filter(l => l.trim()).length;
        const hasStackHint = STACK_KEYWORDS.test(content);
        if (lineCount < 15 && !hasStackHint && !hasPopulatedModules) {
          checks.push({
            name: 'adf cold start',
            status: 'INFO',
            details: `${file} is a thin pointer with ${lineCount} lines and no stack keywords — agents have no architecture orientation. Run: charter adf populate`,
          });
        }
      }

      // Sync lock status
      if (manifest.sync.length > 0) {
        const lockFile = path.join(aiDir, '.adf.lock');
        const hasLock = fs.existsSync(lockFile);
        checks.push({
          name: 'adf sync lock',
          status: hasLock ? 'PASS' : 'WARN',
          details: hasLock
            ? `${lockFile} exists (${manifest.sync.length} sync entry/entries).`
            : `${lockFile} not found. Run: charter adf sync --write`,
        });
      }
    } catch {
      checks.push({
        name: 'adf manifest parse',
        status: 'WARN',
        details: `${manifestPath} failed to parse.`,
      });
    }
  }

  const hasWarn = checks.some((check) => check.status === 'WARN');
  const result: DoctorResult = {
    status: hasWarn ? 'WARN' : 'PASS',
    checks,
  };

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`  Doctor status: ${result.status}`);
    for (const check of result.checks) {
      const icon = check.status === 'PASS' ? '[ok]' : check.status === 'INFO' ? '[info]' : '[warn]';
      console.log(`  ${icon} ${check.name}: ${check.details}`);
    }
  }

  if (options.ciMode && hasWarn) {
    return EXIT_CODE.POLICY_VIOLATION;
  }

  return EXIT_CODE.SUCCESS;
}


function validateJSONConfig(configFile: string): DoctorResult['checks'][number] {
  try {
    JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    return {
      name: 'config parse',
      status: 'PASS',
      details: 'config.json is valid JSON.',
    };
  } catch {
    return {
      name: 'config parse',
      status: 'WARN',
      details: 'config.json is invalid JSON.',
    };
  }
}

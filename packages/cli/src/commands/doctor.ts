/**
 * charter doctor
 *
 * Prints environment and configuration diagnostics for humans and agents.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLIOptions } from '../index';
import { EXIT_CODE } from '../index';
import { loadPatterns, loadConfig } from '../config';
import { parseAdf, parseManifest, stripCharterSentinels, evaluateLocBudgets, matchPath } from '@stackbilt/adf';
import type { LocBudgetRule } from '@stackbilt/adf';
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

// Known MCP client config file paths (relative to repo root) and the key they look up under.
const MCP_CLIENT_CONFIGS: Array<{ label: string; configPath: string }> = [
  { label: 'Claude Code', configPath: '.claude/settings.json' },
  { label: 'Claude Code (local)', configPath: '.claude/settings.local.json' },
  { label: 'Generic MCP (.mcp.json)', configPath: '.mcp.json' },
  { label: 'Cursor', configPath: '.cursor/mcp.json' },
];

function checkMcpWiring(): DoctorResult['checks'][number] {
  const wired: string[] = [];
  const missing: string[] = [];

  for (const { label, configPath } of MCP_CLIENT_CONFIGS) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const hasCharter = parsed?.mcpServers?.charter !== undefined;
      if (hasCharter) {
        wired.push(`${label} (${configPath})`);
      } else {
        missing.push(`${label} (${configPath}) — no mcpServers.charter entry`);
      }
    } catch {
      missing.push(`${label} (${configPath}) — invalid JSON`);
    }
  }

  if (wired.length === 0 && missing.length === 0) {
    return {
      name: 'mcp wiring',
      status: 'WARN',
      details: 'No MCP client config files found. Run: charter hook print --mcp-config --client claude',
    };
  }

  if (wired.length > 0) {
    const details = `charter serve wired in: ${wired.join('; ')}` +
      (missing.length > 0 ? `\n    Not wired: ${missing.join('; ')}` : '');
    return { name: 'mcp wiring', status: 'PASS', details };
  }

  return {
    name: 'mcp wiring',
    status: 'WARN',
    details: `MCP config file(s) found but charter not wired: ${missing.join('; ')}\n    Run: charter hook print --mcp-config --client claude`,
  };
}

export async function doctorCommand(options: CLIOptions, args: string[] = []): Promise<number> {
  const checks: DoctorResult['checks'] = [];
  const adfOnly = args.includes('--adf-only');
  const mcpMode = args.includes('--mcp');
  const configFile = path.join(options.configPath, 'config.json');
  const inGitRepo = isGitRepo();
  const config = loadConfig(options.configPath);
  // Number of files with per-file LOC measurement declared in manifest METRICS;
  // set during manifest parse, used by the source LOC budget coverage check.
  let manifestLocMetricCount = 0;

  // --mcp: focused MCP wiring check only
  if (mcpMode) {
    checks.push(checkMcpWiring());
    const hasWarn = checks.some(c => c.status === 'WARN');
    const result: DoctorResult = { status: hasWarn ? 'WARN' : 'PASS', checks };
    if (options.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`  Doctor status: ${result.status}`);
      for (const check of result.checks) {
        const icon = check.status === 'PASS' ? '[ok]' : check.status === 'INFO' ? '[info]' : '[warn]';
        console.log(`  ${icon} ${check.name}: ${check.details}`);
      }
    }
    if (options.ciMode && hasWarn) return EXIT_CODE.POLICY_VIOLATION;
    return EXIT_CODE.SUCCESS;
  }

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

    const securityDenyPath = path.join(options.configPath, 'patterns', 'security-deny.json');
    if (fs.existsSync(securityDenyPath)) {
      const securityTestFiles = findSecurityTestFiles('.');
      checks.push({
        name: 'security test coverage',
        status: securityTestFiles.length > 0 ? 'PASS' : 'WARN',
        details: securityTestFiles.length > 0
          ? `${securityTestFiles.length} security test file(s): ${securityTestFiles.slice(0, 5).join(', ')}`
          : 'Security-sensitive repo has no **/security* or **/l4* test file. Add L4/security regression tests.',
      });
    }
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
      manifestLocMetricCount = manifest.metrics.length;

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

  // Source LOC budget coverage + enforcement (#186).
  // Runs regardless of --adf-only so the pre-commit/CI gate surfaces it.
  const locBudgets = config.locBudgets;
  const budgetRules = locBudgets?.paths ?? [];
  const budgetsEnabled = !!locBudgets && locBudgets.enabled !== false && budgetRules.length > 0;

  if (budgetsEnabled) {
    const measured = collectBudgetFiles('.', budgetRules);
    const results = evaluateLocBudgets(measured, budgetRules, {
      warn: locBudgets!.defaultWarn,
      fail: locBudgets!.defaultFail,
    });
    const failed = results.filter(r => r.status === 'fail');
    const warned = results.filter(r => r.status === 'warn');

    if (failed.length > 0) {
      // Over the fail ceiling → WARN (doctor fails CI on any WARN in --ci mode).
      checks.push({
        name: 'source loc budget',
        status: 'WARN',
        details: `${failed.length} file(s) over their fail ceiling:\n    ${failed.map(r => r.message).join('\n    ')}`,
      });
    } else if (warned.length > 0) {
      // Over the warn ceiling only → advisory INFO (does not break CI).
      checks.push({
        name: 'source loc budget',
        status: 'INFO',
        details: `${warned.length} file(s) over their warn ceiling (advisory):\n    ${warned.map(r => r.message).join('\n    ')}`,
      });
    } else {
      checks.push({
        name: 'source loc budget',
        status: 'PASS',
        details: `${results.length} file(s) within configured source LOC budgets.`,
      });
    }
  } else if (manifestLocMetricCount === 0) {
    // No runtime LOC coverage from either source → soft, non-blocking nudge.
    // Intentionally INFO, not WARN: doctor fails CI on any WARN, and emitting
    // a warning here would break every repo that hasn't opted in yet (#186).
    checks.push({
      name: 'source loc budget',
      status: 'INFO',
      details: 'No runtime source LOC coverage configured. Only ADF entry_loc (if declared) is enforced, so other files can grow into god-objects unchecked. Add a `locBudgets` block to .charter/config.json to set per-path warn/fail ceilings.',
    });
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

/**
 * Walk the repo and measure line counts for files matching any LOC budget rule.
 * Skips the same heavy/managed directories as the security-test walk. Paths are
 * returned repo-relative with forward slashes so they match POSIX-style patterns.
 */
function collectBudgetFiles(
  rootPath: string,
  rules: LocBudgetRule[],
): Array<{ path: string; lines: number }> {
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'coverage', '.ai', '.charter', '.pnpm-store']);
  const out: Array<{ path: string; lines: number }> = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = (path.relative(rootPath, fullPath) || entry.name).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          walk(fullPath);
        }
        continue;
      }

      if (entry.isFile() && rules.some(r => matchPath(relPath, r.pattern))) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          out.push({ path: relPath, lines: content.split('\n').length });
        } catch {
          // Skip unreadable files.
        }
      }
    }
  }

  walk(rootPath);
  return out;
}

function findSecurityTestFiles(rootPath: string): string[] {
  const matches: string[] = [];
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'coverage', '.ai', '.charter']);

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(rootPath, fullPath) || entry.name;
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          walk(fullPath);
        }
        continue;
      }

      if (entry.isFile() && /^(security|l4)/i.test(entry.name) && isTestLikePath(relPath)) {
        matches.push(relPath);
      }
    }
  }

  walk(rootPath);
  return matches.sort();
}

function isTestLikePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/test/')
    || normalized.includes('/tests/')
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized);
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

/**
 * .charter/ Config Loader
 *
 * Loads governance configuration from the .charter/ directory.
 * Config format is kept simple for v0.1 — YAML support comes later.
 * For now, we use JSON config files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Pattern } from '@stackbilt/types';

// ============================================================================
// Config Types
// ============================================================================

export interface CharterConfig {
  /** Project name */
  project: string;
  /** Version of config schema */
  version: string;

  /** Git validation settings */
  git: {
    /** Require Governed-By trailers on high-risk commits */
    requireTrailers: boolean;
    /** Risk level threshold for requiring trailers: LOW, MEDIUM, HIGH */
    trailerThreshold: 'LOW' | 'MEDIUM' | 'HIGH';
  };

  /** Drift scanning settings */
  drift: {
    /** Enable drift scanning */
    enabled: boolean;
    /** Minimum drift score to pass (0.0-1.0) */
    minScore: number;
    /** File glob patterns to include */
    include: string[];
    /** File glob patterns to exclude */
    exclude: string[];
  };

  /** Validation settings */
  validation: {
    /** Citation strictness: STRICT, WARN, PERMISSIVE */
    citationStrictness: 'STRICT' | 'WARN' | 'PERMISSIVE';
  };

  /** CI behavior */
  ci: {
    /** Fail CI on WARN (default: only fail on FAIL) */
    failOnWarn: boolean;
    /** Post PR comments (requires GitHub token) */
    postComments: boolean;
  };
}

const DEFAULT_CONFIG: CharterConfig = {
  project: 'my-project',
  version: '0.1',
  git: {
    requireTrailers: true,
    trailerThreshold: 'HIGH',
  },
  drift: {
    enabled: true,
    minScore: 0.7,
    include: ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx'],
    exclude: ['node_modules/**', 'dist/**', '.git/**', 'coverage/**'],
  },
  validation: {
    citationStrictness: 'WARN',
  },
  ci: {
    failOnWarn: false,
    postComments: false,
  },
};

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Load config from .charter/config.json
 * Falls back to defaults if not found.
 */
export function loadConfig(configPath: string): CharterConfig {
  const configFile = path.join(configPath, 'config.json');

  if (!fs.existsSync(configFile)) {
    return DEFAULT_CONFIG;
  }

  try {
    const raw = fs.readFileSync(configFile, 'utf-8');
    const parsed = JSON.parse(raw);
    // Merge with defaults (shallow merge per section)
    return {
      project: parsed.project || DEFAULT_CONFIG.project,
      version: parsed.version || DEFAULT_CONFIG.version,
      git: { ...DEFAULT_CONFIG.git, ...parsed.git },
      drift: { ...DEFAULT_CONFIG.drift, ...parsed.drift },
      validation: { ...DEFAULT_CONFIG.validation, ...parsed.validation },
      ci: { ...DEFAULT_CONFIG.ci, ...parsed.ci },
    };
  } catch (err) {
    console.warn(`Warning: Failed to parse ${configFile}, using defaults`);
    return DEFAULT_CONFIG;
  }
}

/**
 * Load blessed patterns from .charter/patterns/*.json
 */
export function loadPatterns(configPath: string): Pattern[] {
  const patternsDir = path.join(configPath, 'patterns');

  if (!fs.existsSync(patternsDir)) {
    return [];
  }

  const patterns: Pattern[] = [];
  const files = fs.readdirSync(patternsDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(patternsDir, file), 'utf-8');
      const parsed = JSON.parse(raw);

      // Support both single pattern and array of patterns
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        patterns.push({
          id: item.id || `local-${file}-${patterns.length}`,
          name: item.name,
          category: item.category || 'COMPUTE',
          blessedSolution: item.blessed_solution || item.blessedSolution || '',
          rationale: item.rationale || null,
          antiPatterns: item.anti_patterns || item.antiPatterns || null,
          documentationUrl: item.documentation_url || item.documentationUrl || null,
          relatedLedgerId: null,
          status: item.status || 'ACTIVE',
          createdAt: item.created_at || new Date().toISOString(),
          projectId: null,
        });
      }
    } catch {
      console.warn(`Warning: Failed to parse pattern file: ${file}`);
    }
  }

  return patterns;
}

/**
 * Get the default config as JSON string (for init command).
 */
export function getDefaultConfigJSON(): string {
  return JSON.stringify(DEFAULT_CONFIG, null, 2);
}

export { DEFAULT_CONFIG };

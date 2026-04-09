/**
 * Ontology Policy Validator
 *
 * Validates that changed code references business concepts by their canonical
 * registered names rather than arbitrary aliases. Consumes a data-registry
 * YAML file (e.g., stackbilt_llc/policies/data-registry.yaml) that declares
 * each concept's canonical name, owner service, sensitivity tier, and aliases.
 *
 * Pure logic — no filesystem, no network, no external dependencies. Callers
 * read the registry file and the diff lines, then pass them in.
 *
 * Related: Stackbilt-dev/charter#69 — typed data access policy umbrella.
 */

// ============================================================================
// Types
// ============================================================================

export type OntologySensitivityTier =
  | 'public'
  | 'service_internal'
  | 'cross_service_rpc'
  | 'pii_scoped'
  | 'billing_critical'
  | 'secrets';

export interface OntologyConcept {
  /** Canonical name, e.g. 'tenant', 'subscription', 'quota' */
  name: string;
  /** Owning service, e.g. 'edge-auth' */
  owner: string;
  /** D1 table name (or null for derived concepts) */
  table: string | null;
  /** Sensitivity tier controlling access patterns */
  sensitivity: OntologySensitivityTier;
  /** Human-readable definition */
  definition: string;
  /** Non-canonical synonyms that refer to the same concept */
  aliases: string[];
  /** RPC method on the owning service, if the concept is exposed via RPC */
  rpcMethod?: string;
  /** MCP tool name for the owning service, if applicable */
  mcpTool?: string;
}

export interface OntologyRegistry {
  /** Map of canonical name → concept */
  concepts: Map<string, OntologyConcept>;
  /** Index of alias (lowercased, spaces-removed) → canonical name */
  aliasIndex: Map<string, string>;
  /** Set of all known alias tokens (normalized) */
  aliasTokens: Set<string>;
  /** Set of all canonical name tokens (normalized) */
  canonicalTokens: Set<string>;
}

export interface OntologyChangedLine {
  file: string;
  line: number;
  text: string;
}

export interface OntologyViolation {
  type: 'NON_CANONICAL_ALIAS' | 'REGISTRY_PARSE_ERROR';
  severity: 'INFO' | 'WARN' | 'FAIL';
  identifier: string;
  canonical?: string;
  owner?: string;
  sensitivity?: OntologySensitivityTier;
  file?: string;
  line?: number;
  message: string;
}

export interface OntologyReference {
  identifier: string;
  canonical: string;
  owner: string;
  sensitivity: OntologySensitivityTier;
  isAlias: boolean;
  file: string;
  line: number;
}

export interface OntologyCheckResult {
  /** Whether the check passed overall (no WARN or FAIL violations) */
  passed: boolean;
  /** All registered-concept references found in the diff (informational) */
  references: OntologyReference[];
  /** Violations (alias usage, etc.) */
  violations: OntologyViolation[];
  /** Summary counts by canonical name */
  referencedConcepts: Map<string, number>;
}

// ============================================================================
// Registry Loading
// ============================================================================

/**
 * Normalize an identifier for token matching: lowercased, stripped of
 * surrounding non-word characters, underscores removed.
 *
 * Examples:
 *   'tenantId'   → 'tenantid'
 *   'tenant_id'  → 'tenantid'
 *   'TENANTS'    → 'tenants'
 *   'api key'    → 'apikey'
 */
export function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[_\s\-]/g, '');
}

/**
 * Parse a data-registry YAML file (the format used by
 * stackbilt_llc/policies/data-registry.yaml) into an OntologyRegistry.
 *
 * This is a minimal YAML subset parser tailored to the registry format.
 * It does NOT support: anchors, multi-line strings, complex flow mappings,
 * quoted strings, or tags. For the specific registry shape it handles:
 *   - Comments (`# ...`)
 *   - Nested scalar maps (2-space indent)
 *   - Inline flow sequences (`[a, b, c]`)
 *   - Bare string values
 *
 * @throws Error if the registry structure is malformed
 */
export function parseOntologyRegistry(yamlText: string): OntologyRegistry {
  const lines = yamlText.split(/\r?\n/);
  const concepts = new Map<string, OntologyConcept>();
  const aliasIndex = new Map<string, string>();
  const aliasTokens = new Set<string>();
  const canonicalTokens = new Set<string>();

  let inConcepts = false;
  let currentConceptName: string | null = null;
  let currentConcept: Partial<OntologyConcept> | null = null;

  const flushConcept = (): void => {
    if (currentConceptName && currentConcept && currentConcept.owner && currentConcept.sensitivity) {
      const concept: OntologyConcept = {
        name: currentConceptName,
        owner: currentConcept.owner,
        table: currentConcept.table ?? null,
        sensitivity: currentConcept.sensitivity as OntologySensitivityTier,
        definition: currentConcept.definition ?? '',
        aliases: currentConcept.aliases ?? [],
        rpcMethod: currentConcept.rpcMethod,
        mcpTool: currentConcept.mcpTool,
      };
      concepts.set(currentConceptName, concept);
      canonicalTokens.add(normalizeToken(currentConceptName));
      for (const alias of concept.aliases) {
        const token = normalizeToken(alias);
        if (token.length > 0) {
          aliasTokens.add(token);
          aliasIndex.set(token, currentConceptName);
        }
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    // Strip comments
    const commentIdx = rawLine.indexOf('#');
    const line = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
    if (!line.trim()) continue;

    // Top-level 'concepts:' marker
    if (/^concepts:\s*$/.test(line)) {
      inConcepts = true;
      continue;
    }
    if (!inConcepts) continue;

    // Concept name at 2-space indent followed by a colon (e.g. '  tenant:')
    const conceptHeader = line.match(/^ {2}([a-zA-Z_][a-zA-Z0-9_]*):\s*$/);
    if (conceptHeader) {
      flushConcept();
      currentConceptName = conceptHeader[1];
      currentConcept = {};
      continue;
    }

    // Field at 4-space indent (e.g. '    owner: edge-auth')
    const fieldMatch = line.match(/^ {4}([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (fieldMatch && currentConcept) {
      const [, key, rawValue] = fieldMatch;
      const value = rawValue.trim();

      switch (key) {
        case 'owner':
          currentConcept.owner = value;
          break;
        case 'table':
          currentConcept.table = value === 'null' || value === '' ? null : value;
          break;
        case 'sensitivity':
          currentConcept.sensitivity = value as OntologySensitivityTier;
          break;
        case 'definition':
          currentConcept.definition = value;
          break;
        case 'rpc_method':
          currentConcept.rpcMethod = value;
          break;
        case 'mcp_tool':
          currentConcept.mcpTool = value;
          break;
        case 'aliases':
          currentConcept.aliases = parseInlineFlowSequence(value);
          break;
        // Silently ignore unknown fields for forward compatibility
      }
    }
  }

  flushConcept();

  if (concepts.size === 0) {
    throw new Error('Ontology registry parse error: no concepts found. Expected top-level "concepts:" key with indented concept entries.');
  }

  return { concepts, aliasIndex, aliasTokens, canonicalTokens };
}

/**
 * Parse an inline YAML flow-sequence literal: [a, b, c] → ['a', 'b', 'c'].
 * Handles bare strings with spaces and underscores but not quoted strings.
 */
export function parseInlineFlowSequence(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return [];
  }
  const inner = trimmed.slice(1, -1);
  if (!inner.trim()) return [];
  return inner
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// ============================================================================
// Diff Checking
// ============================================================================

/**
 * Strip common comment syntax from a line before token extraction.
 * Supports `// ...` (JS/TS/C), `# ...` (YAML/Python/shell/TOML),
 * `-- ...` (SQL), and inline `/* ... *\/` (JS/C). Multi-line block
 * comments are left to the caller since we process one line at a time.
 *
 * Also strips string literals (single, double, backtick-quoted) to avoid
 * matching business terms that happen to appear in user-facing copy.
 */
export function stripCommentsAndStrings(line: string): string {
  // Remove inline block comments /* ... */
  let result = line.replace(/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g, ' ');
  // Remove trailing // ... line comments (must not be inside a URL like http://)
  result = result.replace(/(^|[^:])\/\/.*$/, '$1');
  // Remove trailing # ... comments (YAML/Python/shell/TOML)
  // Guarded so we don't strip `#region` markers or `#include` directives.
  result = result.replace(/(^|\s)#(?:\s|$).*$/, '$1');
  // Remove trailing -- ... comments (SQL)
  result = result.replace(/(^|\s)--\s.*$/, '$1');
  // Remove string literals to avoid matching words inside user-facing copy
  result = result
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
    .replace(/`(?:[^`\\]|\\.)*`/g, ' ');
  return result;
}

/**
 * Extract candidate identifier tokens from a line of source code.
 * Returns normalized tokens (lowercased, punctuation-stripped) suitable
 * for matching against the registry's alias/canonical indexes.
 *
 * Strips comments and string literals first so that natural-language
 * prose (comments, user-facing strings) doesn't trigger false positives
 * on alias words that appear in English sentences (e.g. "usage" or
 * "account" in a TODO comment).
 *
 * The extractor is language-agnostic: a single regex yields every
 * word-like token in the remaining code. This works across TypeScript,
 * JavaScript, SQL, YAML, and markdown source.
 */
export function extractIdentifiersFromLine(line: string): string[] {
  const stripped = stripCommentsAndStrings(line);
  const matches = stripped.match(/[a-zA-Z_][a-zA-Z0-9_]*/g);
  if (!matches) return [];
  return matches.map(normalizeToken);
}

/**
 * Check a set of changed lines against the ontology registry. Returns
 * registered-concept references (informational) and any alias violations
 * (non-canonical usage of a known alias in new code).
 *
 * Caller is responsible for filtering the diff to NEW lines only if that's
 * the desired scope. This function treats every input line as in-scope.
 */
export function checkOntologyDiff(
  changedLines: OntologyChangedLine[],
  registry: OntologyRegistry,
  options: { ignoreAliasViolations?: boolean } = {}
): OntologyCheckResult {
  const references: OntologyReference[] = [];
  const violations: OntologyViolation[] = [];
  const referencedConcepts = new Map<string, number>();

  for (const line of changedLines) {
    const tokens = extractIdentifiersFromLine(line.text);
    const seenOnLine = new Set<string>();

    for (const token of tokens) {
      // Avoid double-reporting if the same token appears twice on a line
      if (seenOnLine.has(token)) continue;
      seenOnLine.add(token);

      // Canonical match? Report as clean reference.
      if (registry.canonicalTokens.has(token)) {
        const canonicalName = findCanonicalByToken(token, registry);
        if (canonicalName) {
          const concept = registry.concepts.get(canonicalName)!;
          references.push({
            identifier: token,
            canonical: canonicalName,
            owner: concept.owner,
            sensitivity: concept.sensitivity,
            isAlias: false,
            file: line.file,
            line: line.line,
          });
          referencedConcepts.set(canonicalName, (referencedConcepts.get(canonicalName) ?? 0) + 1);
        }
        continue;
      }

      // Alias match? Report as reference AND violation unless suppressed.
      if (registry.aliasTokens.has(token)) {
        const canonicalName = registry.aliasIndex.get(token);
        if (!canonicalName) continue;
        const concept = registry.concepts.get(canonicalName);
        if (!concept) continue;

        // An alias that is also the canonical name's own lowercase form
        // doesn't count as a violation — it's the canonical itself.
        if (normalizeToken(canonicalName) === token) continue;

        references.push({
          identifier: token,
          canonical: canonicalName,
          owner: concept.owner,
          sensitivity: concept.sensitivity,
          isAlias: true,
          file: line.file,
          line: line.line,
        });
        referencedConcepts.set(canonicalName, (referencedConcepts.get(canonicalName) ?? 0) + 1);

        if (!options.ignoreAliasViolations) {
          violations.push({
            type: 'NON_CANONICAL_ALIAS',
            severity: 'WARN',
            identifier: token,
            canonical: canonicalName,
            owner: concept.owner,
            sensitivity: concept.sensitivity,
            file: line.file,
            line: line.line,
            message: `Uses alias '${token}' for concept '${canonicalName}' (owned by ${concept.owner}, ${concept.sensitivity}). Prefer the canonical form in new code; aliases are acceptable in user-facing copy only.`,
          });
        }
      }
    }
  }

  const passed = violations.every(v => v.severity !== 'WARN' && v.severity !== 'FAIL');

  return {
    passed,
    references,
    violations,
    referencedConcepts,
  };
}

/** Walk the concepts map to find the canonical name whose normalized form matches. */
function findCanonicalByToken(token: string, registry: OntologyRegistry): string | null {
  for (const [name] of registry.concepts) {
    if (normalizeToken(name) === token) return name;
  }
  return null;
}

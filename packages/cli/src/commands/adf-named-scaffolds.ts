/**
 * Named-module scaffold registry.
 *
 * Rich scaffolds for canonical policy modules that consumer repos can adopt
 * with `charter adf create <name>`. The generic empty placeholder in
 * buildModuleScaffold is the fallback; entries in NAMED_MODULE_SCAFFOLDS
 * take precedence.
 *
 * Each named module also registers default manifest trigger keywords in
 * NAMED_MODULE_DEFAULT_TRIGGERS. When `charter adf create <name>` is called
 * without an explicit --triggers flag, these auto-populate the ON_DEMAND
 * entry so the wiring is a one-command operation.
 *
 * Adding a new named module:
 *   1. Add the scaffold content as an exported const
 *   2. Register it in NAMED_MODULE_SCAFFOLDS
 *   3. Register default triggers in NAMED_MODULE_DEFAULT_TRIGGERS
 *   4. Add tests in __tests__/named-scaffolds.test.ts
 */

/**
 * Typed data access and ontology enforcement policy (Stackbilt-dev/charter#69).
 *
 * Codifies the cross-repo policy for how services reference business concepts
 * (tenant, user, subscription, quota, etc.) — derived from the canonical data
 * registry at Stackbilt-dev/stackbilt_llc/policies/data-registry.yaml.
 *
 * Declares six sensitivity tiers, the disambiguation protocol, and RPC
 * boundary rules. Consumed by charter validate / codebeast DATA_AUTHORITY /
 * AEGIS disambiguation firewall as the single source of truth for data
 * access policy across the ecosystem.
 */
export const TYPED_DATA_ACCESS_SCAFFOLD = `ADF: 0.1

\u{1F3AF} TASK: Typed data access and ontology enforcement policy

\u{1F4CB} CONTEXT:
  - Business concepts (tenant, user, subscription, quota, credit, mrr, etc.) are defined in a canonical data registry — the single source of truth for ownership, sensitivity, and access shape across the ecosystem
  - Reference registry location: Stackbilt-dev/stackbilt_llc/policies/data-registry.yaml (22+ concepts, 6 sensitivity tiers)
  - Each concept declares: owner service, D1 table, sensitivity tier, definition, aliases, rpc_method, mcp_tool
  - Consumer services derive their KNOWN_CONCEPTS and alias maps from the registry at build time (compiled-const snapshot)
  - Disambiguation protocol halts on undefined concepts rather than guessing
  - CodeBeast DATA_AUTHORITY sensitivity class escalates raw D1 access to owned tables

\u{1F510} SENSITIVITY TIERS [load-bearing]:
  - public            \u2014 readable from any service, no auth required (e.g., blog_post)
  - service_internal  \u2014 readable/writable only by the owning service, raw D1 access is fine within the owner
  - cross_service_rpc \u2014 accessible via declared rpc_method or Service Binding, never raw D1 from a non-owning service
  - pii_scoped        \u2014 accessible only via owning service + audit_log entry required at the call site
  - billing_critical  \u2014 writable only by the owning service plus the Stripe webhook handler; never leaves the owning service boundary even via RPC
  - secrets           \u2014 never leaves the owning service boundary under any circumstance

\u26A0\uFE0F CONSTRAINTS [load-bearing]:
  - New code referencing a business concept MUST check the canonical registry first; terms not in the registry or its aliases MUST be added before the code lands
  - Non-owning services reading or writing cross_service_rpc concepts MUST use the declared rpc_method or mcp_tool \u2014 raw D1 access to another service's table is a DATA_AUTHORITY violation
  - pii_scoped access requires an audit_log entry at the call site \u2014 no silent reads
  - billing_critical and secrets tiers NEVER cross the owning service boundary, even via RPC
  - When encountering an undefined data concept in requirements, tasks, or user prompts, HALT and ask for clarification rather than guessing shape, ownership, or sensitivity
  - Registry updates MUST come before consumer code updates \u2014 the source of truth leads, consumers follow
  - When promoting a concept to a higher sensitivity tier, all existing consumers of raw D1 access must migrate to RPC in the same change set

\u{1F4D6} ADVISORY:
  - Check the registry before reaching for a new type definition \u2014 the concept may already exist with a canonical shape
  - Use charter surface --format json to discover what D1 tables a service currently exposes; cross-reference against registry ownership
  - Aliases (e.g., "credits" for "quota") are semantically equivalent; prefer the canonical form in new code, accept aliases in user-facing copy
  - The disambiguation protocol is load-bearing for autonomous agents \u2014 these systems cannot safely guess business term semantics

\u{1F4CA} METRICS:
  REGISTRY_PATH: stackbilt_llc/policies/data-registry.yaml
  REGISTRY_REPO: Stackbilt-dev/stackbilt_llc
  SENSITIVITY_TIERS: 6
  DOCUMENTED_CONCEPTS: 22

\u{1F517} REFERENCES:
  - Stackbilt-dev/charter#69 \u2014 typed data access policy umbrella issue
  - codebeast#9 \u2014 DATA_AUTHORITY sensitivity class (enforcement side)
  - Stackbilt-dev/aegis#344 \u2014 disambiguation firewall (runtime halt mechanism)
`;

/**
 * Registry of rich named-module scaffolds. When `charter adf create <name>`
 * matches a name in this map, the corresponding scaffold is written instead
 * of the generic empty placeholder from buildModuleScaffold's fallback.
 */
export const NAMED_MODULE_SCAFFOLDS: Record<string, string> = {
  'typed-data-access': TYPED_DATA_ACCESS_SCAFFOLD,
};

/**
 * Default manifest trigger keywords for named modules. Used when
 * `charter adf create <name>` matches a known module and no explicit
 * --triggers flag is provided.
 */
export const NAMED_MODULE_DEFAULT_TRIGGERS: Record<string, string[]> = {
  'typed-data-access': [
    'tenant',
    'user',
    'subscription',
    'quota',
    'credit',
    'mrr',
    'pii',
    'sensitivity',
    'data registry',
    'ontology',
    'disambiguation',
    'DATA_AUTHORITY',
    'raw D1',
    'service boundary',
    'auth_scoped',
    'billing_critical',
  ],
};

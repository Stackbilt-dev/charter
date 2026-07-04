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
 * Typed data access and ontology enforcement policy.
 *
 * Codifies a generic cross-service policy for how services reference
 * business concepts (tenant, user, subscription, quota, etc.) — derived
 * from a canonical data registry that is the single source of truth for
 * ownership, sensitivity, and access shape.
 *
 * Declares six sensitivity tiers, a disambiguation step, and cross-service
 * access-boundary rules. Framework-generic content only — keep this in
 * sync with the repo-local `.ai/typed-data-access.adf` policy module.
 */
export const TYPED_DATA_ACCESS_SCAFFOLD = `ADF: 0.1

\u{1F3AF} TASK: Typed data access and ontology enforcement policy

\u{1F4CB} CONTEXT:
  - Business concepts (tenant, user, subscription, quota, credit, etc.) are defined in a canonical data registry \u2014 the single source of truth for ownership, sensitivity, and access shape across services
  - Each concept declares: owner service, storage table, sensitivity tier, definition, aliases, and the accessor (RPC method, tool, or API) non-owning services must use
  - Consumer services derive their known-concepts and alias maps from the registry at build time (a compiled-const snapshot pattern, not a runtime fetch)
  - A disambiguation step halts on undefined concepts rather than guessing shape, ownership, or sensitivity

\u{1F510} SENSITIVITY TIERS [load-bearing]:
  - public            \u2014 readable from any service, no auth required (e.g., blog_post)
  - service_internal  \u2014 readable/writable only by the owning service, raw storage access is fine within the owner
  - cross_service_rpc \u2014 accessible via a declared RPC method or service binding, never raw storage access from a non-owning service
  - pii_scoped        \u2014 accessible only via the owning service + an audit-log entry required at the call site
  - billing_critical  \u2014 writable only by the owning service plus its designated payment-webhook handler; never leaves the owning service boundary even via RPC
  - secrets           \u2014 never leaves the owning service boundary under any circumstance

\u26A0\uFE0F CONSTRAINTS [load-bearing]:
  - New code referencing a business concept MUST check the canonical registry first; terms not in the registry or its aliases MUST be added before the code lands
  - Non-owning services reading or writing cross_service_rpc concepts MUST use the declared accessor \u2014 raw storage access to another service's table is a violation
  - pii_scoped access requires an audit-log entry at the call site \u2014 no silent reads
  - billing_critical and secrets tiers NEVER cross the owning service boundary, even via RPC
  - When encountering an undefined data concept in requirements, tasks, or user prompts, HALT and ask for clarification rather than guessing shape, ownership, or sensitivity
  - Registry updates MUST come before consumer code updates \u2014 the source of truth leads, consumers follow
  - When promoting a concept to a higher sensitivity tier, all existing consumers of raw storage access must migrate to the declared accessor in the same change set

\u{1F4D6} ADVISORY:
  - Check the registry before reaching for a new type definition \u2014 the concept may already exist with a canonical shape
  - Use charter surface --format json to discover what tables/resources a service currently exposes; cross-reference against registry ownership
  - Aliases (e.g., "credits" for "quota") are semantically equivalent; prefer the canonical form in new code, accept aliases in user-facing copy
  - The disambiguation step is load-bearing for autonomous agents \u2014 these systems cannot safely guess business-term semantics

\u{1F4CA} METRICS:
  SENSITIVITY_TIERS: 6
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
    'pii',
    'sensitivity',
    'data registry',
    'ontology',
    'disambiguation',
    'raw storage access',
    'service boundary',
    'auth_scoped',
    'billing_critical',
  ],
};

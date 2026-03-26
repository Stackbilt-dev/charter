---
name: drafter
user-invocable: true
description: Generate governance documents (ADRs, policies, decision records) using Charter's governance context. Use when the user asks to draft, write, or generate any governance documentation.
---

# Drafter Skill

Generate governance documents using Charter's project context, ADF modules, and current repository state.

## Use When

Use this skill when the user asks to draft, write, formalize, or generate governance documentation such as:

- ADRs
- Policy documents
- Decision records
- Operating agreements
- Compliance documents

If the request is ambiguous, ask: "What governance document would you like to draft?"

## Instructions

### 1. Detect Project Context

Identify the project and its governing context before drafting.

Preferred sources:

1. Charter MCP tools, if available:
   - `getProjectContext` for the relevant task or topic
   - `getArchitecturalDecisions` for load-bearing constraints
   - `getProjectState` for current validation state and active issues
   - `getRecentChanges` for recent work that may affect the document

2. Local Charter artifacts, if MCP is not available:
   - `.ai/manifest.adf`
   - `.ai/core.adf`
   - `.ai/state.adf`
   - Relevant on-demand modules such as `decisions.adf`, `planning.adf`, `backend.adf`, `frontend.adf`, or `content.adf`

3. Repository context:
   - `package.json`, `wrangler.toml`, or current directory name for project identity
   - Existing governance docs in directories like `docs/`, `adrs/`, `ADR/`, `decisions/`, `policies/`, or `compliance/`
   - Recent issues, PRs, changelog entries, or design notes when available

Never invent project constraints that are not supported by the available Charter or repository context. If something is unclear, mark it as an assumption or open question.

### 2. Identify Document Type

Classify the requested document and draft with the right structure.

Supported document types:

- **ADR** - Architecture Decision Record
- **Policy Document** - Governance or operational policy
- **Decision Record** - Lightweight record of a decision and rationale
- **Operating Agreement** - Roles, decision rights, escalation, and working terms
- **Compliance Document** - Controls, obligations, evidence, and review process

If the user names a format, use it. Otherwise infer from the request and confirm only if the intent is unclear.

### 3. Gather Drafting Inputs

Collect the minimum information needed to produce a solid first draft:

- **Title / Subject** - What is the document about?
- **Purpose** - Why is the document needed now?
- **Decision or Rule** - What is being decided, mandated, or formalized?
- **Scope** - What systems, teams, or workflows are affected?
- **Audience** - Who will read or approve it?
- **Status** - Proposed, draft, accepted, active, superseded, etc.
- **Constraints** - Relevant ADF constraints, policies, or prior decisions
- **Evidence** - Existing code, modules, commits, incidents, or requirements that support the draft
- **Effective timing** - Decision date, review date, rollout date, or compliance deadline

If critical inputs are missing, ask concise follow-up questions. If only minor details are missing, draft anyway and include an `Assumptions` or `Open Questions` section.

### 4. Draft from Charter Context

Write the document directly using the project context you gathered.

Drafting rules:

- Reflect Charter governance context, not generic boilerplate
- Use ADF modules and current project state to anchor the document in real constraints
- Separate hard rules from rationale
- Prefer precise, reviewable language over marketing language
- Call out tradeoffs, consequences, and enforcement expectations where relevant
- Preserve existing document naming or citation patterns already used in the repository
- Keep the draft generic to the governed project; do not include unrelated organization-specific names or internal references

When useful, explicitly reference:

- Load-bearing constraints from `core.adf`
- Active project state from `state.adf`
- Topic-specific guidance from on-demand ADF modules
- Prior ADRs, policies, or decisions already present in the repo
- Recent implementation changes that created the need for the document

### 5. Use the Right Template

Default structures:

**ADR Template**
- Title
- Status
- Date
- Context
- Decision
- Alternatives Considered
- Consequences
- Implementation Notes
- Related Decisions / References

**Policy Document Template**
- Title
- Policy ID or Status
- Purpose
- Scope
- Roles and Responsibilities
- Policy Statement
- Enforcement
- Exceptions
- Review Cadence
- References

**Decision Record Template**
- Title
- Status
- Date
- Context
- Options Considered
- Decision
- Rationale
- Follow-Up Actions

**Operating Agreement Template**
- Title
- Purpose
- Participants / Decision Owners
- Scope of Authority
- Decision Rights
- Working Norms
- Escalation Path
- Review and Amendment Process

**Compliance Document Template**
- Title
- Status
- Objective
- Scope
- Applicable Obligations or Standards
- Controls
- Evidence Requirements
- Owners
- Exceptions and Risk Acceptance
- Review Cadence

### 6. Review and Refine

Before returning the draft, check:

- Is the document aligned with actual Charter and repository context?
- Are hard constraints clearly distinguished from advisory guidance?
- Are assumptions, unknowns, and pending approvals explicit?
- Does the structure match the requested document type?
- Is the tone formal, concise, and decision-oriented?

If the user asks for a first pass, optimize for completeness and clarity. If the user asks for a final version, tighten language and remove unresolved placeholders where possible.

### 7. Save Location Guidance

If the user wants the draft saved, place it in the most appropriate project location, for example:

- `docs/adrs/`
- `docs/policies/`
- `decisions/`
- `governance/`
- `compliance/`

Match the repository's existing conventions before introducing a new folder structure.

## Notes

- This skill is for drafting and formalization, not policy enforcement.
- Prefer drafting from live project context over generic templates.
- When repository context is thin, produce a usable draft with explicit placeholders rather than blocking.
- If the repository already uses governance citation formats, retain them consistently.

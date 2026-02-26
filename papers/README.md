# Charter Kit — Research & White Papers

This directory contains versioned white papers documenting the design rationale,
quantitative analysis, and architectural decisions behind Charter Kit and the
Attention-Directed Format (ADF).

## Papers

| ID | Title | Version | Date | Status |
|---|---|---|---|---|
| CSA-001 | [Context-as-Code](./context-as-code-v1.1.md) | 1.1 | 2026-02-26 | Published |
| CSA-002 | [Context-as-Code II: Greenfield](./context-as-code-greenfield-v0.1.md) | 0.1 | 2026-02-26 | Draft |
| ADX-001 | [Agent DX Feedback: Lockfile Schema Discoverability](./AGENT_DX_FEEDBACK_001.md) | n/a | 2026-02-26 | Draft |
| ADX-002 | [Agent DX Feedback: ADF Greenfield Bootstrapping — Rule Routing Friction](./AGENT_DX_FEEDBACK_002.md) | n/a | 2026-02-26 | Draft |
| ADX-003 | [Agent DX Feedback: Install/Setup Automation Friction (Windows + PNPM Workspace)](./AGENT_DX_FEEDBACK_003.md) | n/a | 2026-02-26 | Draft |
| RM-001 | [ADF vNext Roadmap (Draft): Agent DX-Driven Priorities](./adf-vnext-roadmap-v0.1.md) | 0.1 | 2026-02-26 | Draft |

## Versioning Convention

Each paper follows `<slug>-v<major>.<minor>.md`:

- **Major** increments on substantive content revisions (new data, changed conclusions).
- **Minor** increments on editorial fixes, formatting, or addenda that don't change findings.

The YAML frontmatter in each paper tracks `version`, `status`, `charter-version`
(the toolkit release the paper corresponds to), and `paper-id` for stable cross-referencing.

### Statuses

- **draft** — in progress, not yet reviewed
- **published** — reviewed and released
- **superseded** — replaced by a newer version (frontmatter will include `superseded-by`)

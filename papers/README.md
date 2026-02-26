# Charter Kit — Research & White Papers

This directory contains versioned white papers documenting the design rationale,
quantitative analysis, and architectural decisions behind Charter Kit and the
Attention-Directed Format (ADF).

## Published Papers

| ID | Title | Version | Date | Status |
|---|---|---|---|---|
| CSA-001 | [Context-as-Code](./context-as-code-v1.0.md) | 1.0 | 2026-02-26 | Published |

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

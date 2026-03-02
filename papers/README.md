# Charter Kit Papers

This directory is the curated narrative layer for Charter's iterative process.

GitHub Issues and PRs are the system of record for active work. The papers here summarize the important findings, decisions, and release outcomes without mirroring every link.

## Sections

### Research Papers

Long-form research, architecture, and rationale documents.

| ID | Title | Version | Date | Status |
|---|---|---|---|---|
| CSA-001 | [Context-as-Code](./context-as-code-v1.1.md) | 1.1 | 2026-02-26 | Published |
| CSA-002 | [Context-as-Code II: Greenfield](./context-as-code-greenfield-v0.1.md) | 0.2 | 2026-02-26 | Draft |
| RM-001 | [ADF vNext Roadmap (Draft): Agent DX-Driven Priorities](./adf-vnext-roadmap-v0.1.md) | 0.1 | 2026-02-26 | Draft |
| n/a | [Architect v2 x Charter ADF Integration Brief](./ARCHITECT_V2_INTEGRATION_BRIEF.md) | n/a | 2026-02-26 | Proposal |

### UX Feedback

Agent/user experience findings are categorized by journey buckets:

- Onboarding
- Daily Use
- Reliability and Trust
- Output Ergonomics
- Automation and CI

Start here: [UX Feedback Index](./ux-feedback/README.md)

### Release Plans

Versioned plans tie prioritized UX findings to release execution and outcomes.

Start here: [Release Plans Index](./releases/README.md)

## Curation Rules

`papers/` includes only high-signal items:

- High-severity user-facing friction
- Cross-cutting reliability or trust gaps
- Work explicitly tied to feedback IDs (ADX-*)
- Planned release themes with measurable outcomes

Everything else remains tracked in GitHub Issues/PRs.

## Versioning Convention

Versioned papers follow `<slug>-v<major>.<minor>.md`:

- Major increments on substantive content revisions (new data, changed conclusions)
- Minor increments on editorial fixes or addenda that do not change findings

Standard status values:

- `draft`
- `published`
- `superseded`

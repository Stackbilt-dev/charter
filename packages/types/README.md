# @stackbilt/types

Shared type definitions for [Charter Kit](https://github.com/Stackbilt-dev/charter) -- a local-first governance toolkit for software repos.

This package contains all TypeScript type aliases, enums, and interfaces used across the Charter Kit monorepo. It exports only types; there is no runtime code.

## Install

```bash
npm install @stackbilt/types
```

## Usage

```typescript
import type {
  ChangeClass,
  CommitRiskLevel,
  DriftViolation,
  ValidationResult,
} from '@stackbilt/types';
```

## Exported Types

### Core Enums and Literals

| Type | Values |
|------|--------|
| `AppMode` | `GOVERNANCE`, `STRATEGY`, `DRAFTER`, `RED_TEAM`, `BRIEF` |
| `LedgerEntryType` | `RULING`, `ADR`, `POLICY`, `SOP`, `STRATEGIC`, `REVIEW`, `NOTARY_STAMP` |
| `LedgerStatus` | `ACTIVE`, `SUPERSEDED`, `ARCHIVED` |
| `PatternStatus` | `ACTIVE`, `DEPRECATED`, `EVALUATING` |
| `PatternCategory` | `COMPUTE`, `DATA`, `INTEGRATION`, `SECURITY`, `ASYNC` |
| `RequestStatus` | `SUBMITTED`, `QUEUED`, `IN_REVIEW`, `RESOLVED`, `BLOCKED`, `DEFERRED` |
| `RequestType` | `FEATURE_APPROVAL`, `ARCHITECTURE_REVIEW`, `POLICY_QUESTION`, `EXCEPTION_REQUEST`, `TOOL_EVALUATION` |
| `Domain` | `ARCHITECTURE`, `DATA`, `STANDARDS`, `SECURITY`, `STRATEGY` |
| `Urgency` | `LOW`, `STANDARD`, `ELEVATED`, `CRITICAL` |
| `Complexity` | `TRIVIAL`, `SIMPLE`, `MODERATE`, `COMPLEX`, `EPIC` |

### Validation

- `ValidationStatus` -- `PASS`, `WARN`, `FAIL`
- `ValidationRequest` -- input for validation checks
- `RuleEvaluation` -- individual rule result
- `PatternEvaluation` -- pattern alignment result
- `ValidationResult` -- full validation output with rules, ADRs, and patterns

### Data Model

- `Pattern` -- blessed-stack pattern definition
- `LedgerEntry` -- governance ledger record (rulings, ADRs, policies)
- `GovernanceRequest` -- governance request lifecycle record
- `Protocol` -- protocol definition
- `QualityMetadata` -- quality scoring metadata
- `NotaryStamp` -- cryptographic notary stamp

### Git Validation

- `GitValidationStatus` -- `PASS`, `WARN`, `FAIL`
- `CommitRiskLevel` -- `LOW`, `MEDIUM`, `HIGH`
- `GitCommit` -- parsed commit data
- `GovernedByTrailer` -- parsed `Governed-By` trailer
- `ResolvesRequestTrailer` -- parsed `Resolves-Request` trailer
- `UnlinkedCommit` -- commit missing governance trailers
- `GitValidationResponse` -- full git validation output

### Change Classification

- `ChangeClass` -- `SURFACE`, `LOCAL`, `CROSS_CUTTING`
- `GovernanceStatus` -- `CLEAR`, `VIOLATION`, `NEEDS_REVIEW`
- `ChangeRecommendation` -- `APPROVE`, `APPROVE_WITH_MITIGATIONS`, `REJECT`, `ESCALATE`
- `ChangeClassification` -- full classification result

### Drift Scanner

- `DriftViolation` -- single drift violation with file, line, and severity
- `DriftReport` -- aggregated drift scan results

### LLM Provider (Bridge Contract)

- `LLMRequest` -- prompt input
- `LLMResponse` -- model output
- `LLMProvider` -- provider interface for pluggable LLM backends

## Requirements

- Node >= 18
- TypeScript (types only -- no runtime dependency)

## License

Apache-2.0

## Links

- [Repository](https://github.com/Stackbilt-dev/charter)
- [Issues](https://github.com/Stackbilt-dev/charter/issues)

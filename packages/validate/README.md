# @stackbilt/validate

Citation validation and commit message intent classification for [Charter Kit](https://github.com/Stackbilt-dev/charter) -- a local-first governance toolkit for software repos. Pure heuristics, no LLM calls.

> **Want the full toolkit?** Just install the CLI — it includes everything:
> ```bash
> npm install -g @stackbilt/cli
> ```
> Only install this package directly if you need citation validation or intent classification without the CLI.

## Install

```bash
npm install @stackbilt/validate
```

## Usage

### Extract and validate citations

```ts
import { extractCitations, validateCitations, enrichCitations } from '@stackbilt/validate';

const text = 'Per [Section 3.1] and [ADR-012], this approach is approved.';

const citations = extractCitations(text);
// => ['Section 3.1', 'ADR-012']

const result = validateCitations(text, bundle, 'WARN');
// => { valid: true, violations: [], totalCitations: 2, validCount: 2 }
```

### Classify commit message intent

```ts
import { classifyMessage } from '@stackbilt/validate';

const result = classifyMessage('Should we adopt GraphQL or stick with REST?');
// => {
//   intent: 'decision',
//   confidence: 1,
//   dudePhases: ['D', 'U', 'Di', 'E'],
//   suggestedMode: 'GOVERNANCE',
//   complexity: 'low',
//   domain: 'ARCHITECTURE'
// }
```

## API Reference

### `extractCitations(text: string): string[]`

Extract governance citation references from text. Recognized: `[Section X.Y]`, `[ADR-XXX]`, `[RFC-YYYY-XXX]`, `[Pattern: Name]`, `[POLICY-XXX]`.

### `validateCitations(text, bundle, strictness?): CitationValidationResult`

Validate citations against a `CitationBundle`. Unknown citations receive closest-match suggestions via Levenshtein distance.

### `enrichCitations(text, bundle): string`

Replace citation references with hyperlinked, titled versions.

### `classifyMessage(message, context?): Classification`

Classify a message by intent (`ideation`, `decision`, `doubt`, `synthesis`, `question`, `review`), DUDE phases, complexity, and suggested app mode. Runs in under 5 ms.

## Types

- `CitationViolation`, `CitationValidationResult`, `ValidationStrictness`, `CitationBundle`
- `Classification`, `MessageIntent`, `DudePhase`

## Requirements

- Node >= 18
- Peer dependency: `@stackbilt/types`

## License

Apache-2.0

## Links

- [Repository](https://github.com/Stackbilt-dev/charter)
- [Issues](https://github.com/Stackbilt-dev/charter/issues)

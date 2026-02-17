# @stackbilt/core

Zod schemas and sanitization helpers for [Charter Kit](https://github.com/Stackbilt-dev/charter) -- a local-first governance toolkit for software repos.

## Install

```bash
npm install @stackbilt/core
```

Requires Node >= 18. The only runtime dependency is [zod](https://github.com/colinhacks/zod).

## Usage

### Sanitize user input

```ts
import { sanitizeInput } from '@stackbilt/core';

const clean = sanitizeInput(rawUserInput);
```

### Safe error messages

`sanitizeErrorMessage` maps known error patterns (database, network, auth) to user-friendly messages and returns a generic fallback for anything unrecognized. Internal details are never exposed to callers.

```ts
import { sanitizeErrorMessage } from '@stackbilt/core';

try {
  await riskyOperation();
} catch (err) {
  const message = sanitizeErrorMessage(err);
  // "Database constraint violated", "Network error - please retry", etc.
}
```

### Validate governance data with Zod schemas

```ts
import { CreateLedgerEntrySchema, CreatePatternSchema } from '@stackbilt/core';

const result = CreateLedgerEntrySchema.safeParse(payload);
if (!result.success) {
  console.error(result.error.issues);
}
```

## API Reference

### Functions

| Export | Signature | Description |
|---|---|---|
| `sanitizeInput` | `(input: string) => string` | Strip control characters and enforce length limit |
| `sanitizeErrorMessage` | `(error: unknown) => string` | Return a safe, user-facing error message |

### Schemas

| Schema | Purpose |
|---|---|
| `CreateLedgerEntrySchema` | Validate new ledger entries (rulings, ADRs, policies, notary stamps) |
| `UpdateLedgerStatusSchema` | Validate status transitions (`ACTIVE`, `SUPERSEDED`, `ARCHIVED`) |
| `CreatePatternSchema` | Validate new blessed-stack patterns |
| `UpdatePatternSchema` | Validate pattern updates |
| `CreateProtocolSchema` | Validate governance protocols |
| `CreateGovernanceRequestSchema` | Validate governance requests |
| `ResolveGovernanceRequestSchema` | Validate request resolutions |
| `CreateProjectSchema` | Validate new project definitions |

Each schema also exports an inferred TypeScript type (e.g., `CreateLedgerEntryRequest`, `CreatePatternRequest`).

## License

Apache-2.0

## Links

- [Repository](https://github.com/Stackbilt-dev/charter)
- [Issues](https://github.com/Stackbilt-dev/charter/issues)

# @stackbilt/git

Git trailer parsing, commit risk scoring, and governance suggestion generation for [Charter Kit](https://github.com/Stackbilt-dev/charter) -- a local-first governance toolkit for software repos.

> **Want the full toolkit?** Just install the CLI — it includes everything:
> ```bash
> npm install -g @stackbilt/cli
> ```
> Only install this package directly if you need trailer parsing and risk scoring without the CLI.

## Install

```bash
npm install @stackbilt/git
```

## Usage

### Parse trailers from a commit message

```ts
import { parseTrailersFromMessage } from '@stackbilt/git';

const trailers = parseTrailersFromMessage('abc1234', `feat(api): add user endpoint

Governed-By: ADR-0012
Resolves-Request: REQ-0045
`);

console.log(trailers.governedBy);
// [{ commitSha: 'abc1234', reference: 'ADR-0012' }]
```

### Assess commit risk

```ts
import { assessCommitRisk } from '@stackbilt/git';

assessCommitRisk(['migrations/002_add_table.sql'], 'feat: add table');
// => 'HIGH'

assessCommitRisk(['lib/utils.ts'], 'refactor: extract helper');
// => 'MEDIUM'

assessCommitRisk(['README.md'], 'docs: update readme');
// => 'LOW'
```

**Risk classification:**

| Level  | File patterns |
| ------ | ------------- |
| HIGH   | `migrations/`, `*.sql`, `worker/handlers/`, `worker/services/` |
| MEDIUM | `lib/`, `components/`, `context/`, `worker/lib/` |
| LOW    | `*.md`, `*.json`, `*.yml`, `test/`, `*.test.*`, `.github/` |

### Generate governance suggestions

```ts
import { generateSuggestions } from '@stackbilt/git';

const suggestions = generateSuggestions(trailers, unlinkedCommits, totalCommits);
// ['No commits have governance trailers. Consider linking significant changes to ADRs.']
```

## API Reference

### `parseTrailersFromMessage(commitSha, message): ParsedTrailers`

Parse `Governed-By` and `Resolves-Request` trailers from a single commit message.

### `parseAllTrailers(commits: GitCommit[]): ParsedTrailers`

Parse trailers from an array of commits, returning combined results.

### `assessCommitRisk(filesChanged, commitMessage): CommitRiskLevel`

Score a commit as `HIGH`, `MEDIUM`, or `LOW`. Falls back to message keyword analysis when no files are provided.

### `generateSuggestions(trailers, unlinkedCommits, totalCommits): string[]`

Generate governance suggestions based on trailer coverage and unlinked high-risk commits.

## Requirements

- Node >= 18
- Peer dependency: `@stackbilt/types`

## License

Apache-2.0

## Links

- [Repository](https://github.com/Stackbilt-dev/charter)
- [Issues](https://github.com/Stackbilt-dev/charter/issues)

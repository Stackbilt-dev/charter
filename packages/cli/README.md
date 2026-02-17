# @stackbilt/cli

CLI entry point for Charter Kit -- a local-first governance toolkit for software repositories. Orchestrates all other `@stackbilt/*` packages to parse commit trailers, score risk, detect blessed-stack drift, and classify change scope. No LLM calls at runtime.

> **This is the only package most users need.** One install gives you the full Charter Kit toolkit.

## Install

```bash
npm install -g @stackbilt/cli
```

This pulls in all Charter Kit packages automatically. You get the `charter` command globally.

For CI pipelines, install as a dev dependency instead:

```bash
npm install --save-dev @stackbilt/cli
```

Requires Node >= 18.

## Quick Start

```bash
charter setup          # bootstrap .charter/ directory
charter doctor         # check CLI + config health
charter validate       # validate commit governance trailers
charter drift          # scan for blessed-stack drift
charter audit          # generate governance audit report
charter classify "migrate auth provider"
```

## Commands

### `charter setup`

Bootstrap `.charter/` with config, patterns, and policies. Optionally generates a GitHub Actions workflow.

```bash
charter setup --ci github --yes
```

### `charter init`

Scaffold `.charter/` config templates only.

### `charter doctor`

Validate CLI installation and `.charter/` config.

### `charter validate`

Validate git commits for `Governed-By` and `Resolves-Request` trailers.

```bash
charter validate --ci --format json
```

### `charter drift`

Scan files against blessed-stack patterns in `.charter/patterns/*.json`.

```bash
charter drift --path ./src --ci
```

### `charter audit`

Generate a governance audit report covering trailers, risk, and drift.

### `charter classify`

Classify a change as `SURFACE`, `LOCAL`, or `CROSS_CUTTING`.

```bash
charter classify "update button color"
```

## Global Options

| Option | Description | Default |
|---|---|---|
| `--config <path>` | Path to `.charter/` directory | `.charter/` |
| `--format <mode>` | Output: `text` or `json` | `text` |
| `--ci` | CI mode: exit non-zero on WARN or FAIL | off |
| `--yes` | Auto-accept safe setup overwrites | off |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Policy violation (CI mode) |
| 2 | Runtime or usage error |

## Related Packages

- `@stackbilt/types` -- shared enums and interfaces
- `@stackbilt/core` -- Zod schemas and sanitization helpers
- `@stackbilt/git` -- trailer parsing and commit risk assessment
- `@stackbilt/classify` -- heuristic change classification
- `@stackbilt/drift` -- blessed-stack pattern drift detection
- `@stackbilt/validate` -- citation validation and intent classification
- `@stackbilt/ci` -- GitHub Actions integration helpers

## License

Apache-2.0

## Repository

[https://github.com/Stackbilt-dev/charter](https://github.com/Stackbilt-dev/charter)

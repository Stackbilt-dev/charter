# Charter v1.9.2 — evidence documentation and compiled-context safety

This patch synchronizes Charter's public evidence documentation and prevents compiled vendor context from being fed back into its ADF source. No CLI commands, flags, JSON contracts, or ADF source semantics changed.

## Changed

- Updated the npm-facing CLI README to link the evidence register and disclose the exact-routing failures.
- Marked the pre-build Architect v2 integration brief as superseded and linked its observational outcomes and limitations.
- Updated the launch FAQ, publication record, follow-up social copy, papers index, and repository ADF state after the v1.9.1 release.
- Removed three duplicated generated-context blocks from Charter's own `core.adf`, reducing its default estimated context from approximately 3,021 to 1,347 tokens.

## Fixed

- Pre-commit auto-tidy now ignores files carrying the `charter adf compile` generation banner. Compiled vendor output is already derived from `.ai/`; migrating it back into the source modules could duplicate context.
- The release workflow pins npm 11.6.2 so npm 12's newer Node requirement cannot break trusted publishing on the Node 20 runner.

## Upgrade

```bash
npm install --save-dev @stackbilt/cli@1.9.2
npx charter --version
```

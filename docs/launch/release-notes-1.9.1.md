# Charter v1.9.1 — launch clarity and reproducible context benchmark

This patch release sharpens Charter's context-compiler onboarding, publishes reproducible evidence, and repairs compatibility and observability defects. No commands, flags, schema shapes, or ADF source semantics changed.

## Added

- A synthetic context-routing benchmark with 30 byte-for-byte-preserved rules and four pinned tasks.
- A reviewed expected-result snapshot and CI gate for routing or estimation changes.
- An exact-scoring 38-session migration-routing snapshot that preserves known failures instead of accepting near-misses.
- A public evidence register separating reproducible, observational, and development evidence.
- Reproducible SVG and PNG launch assets.
- Publication-ready Charter and ADF technical announcements, FAQs, and launch copy.

## Documentation

- Repositioned Charter around its primary job: compiling one modular context source for multiple AI coding agents.
- Made the read-only `charter score` command the first-run CTA.
- Added explicit measurement limitations and links to the raw benchmark fixture.
- Clarified that ADF is a vendor-neutral specification and Charter is its TypeScript reference implementation.
- Removed obsolete Stackbilt engine authentication guidance from the CLI package README.

## Fixed

- Restored legacy `(Triggers: ...)` manifest compatibility.
- Corrected `triggerMatches[].matched` to report individual trigger matches.
- Fixed `adf tidy` pointer restoration for duplicated `Session Start` blocks and empty/deduplicated headings.

## Benchmark snapshot

- 30/30 rules preserved byte-for-byte.
- Four task routes matched their expected module sets.
- Estimated task-context reduction ranged from 40.0% to 77.4%.
- Average estimated reduction: 58.1%.

Charter uses a structural estimate of roughly four characters per token. The benchmark measures relative routed context; it does not claim exact provider billing or improved model adherence.

## Upgrade

```bash
npm install --save-dev @stackbilt/cli@1.9.1
npx charter --version
```

# Charter + ADF Publishing Kit

This directory records the v1.9.1 publication kit and retains reusable follow-up material. Charter v1.9.1 was published on 2026-08-24; verify live links and current measurements before reusing any copy in a later release.

## Canonical links

- Charter: https://github.com/Stackbilt-dev/charter
- Reproducible benchmark: https://github.com/Stackbilt-dev/charter/tree/main/examples/context-routing-benchmark
- Evidence register: https://github.com/Stackbilt-dev/charter/blob/main/papers/charter-evidence-2026-08.md
- ADF specification: https://github.com/adf-spec/adf
- ADF specification text: https://github.com/adf-spec/adf/blob/main/SPEC.md
- Charter npm package: https://www.npmjs.com/package/@stackbilt/cli
- Discord: https://discord.gg/aJmE8wmQDS

The benchmark and evidence register are public on `main`.

## Message split

| Launch | Lead with | Ask for |
|---|---|---|
| Charter | A working context compiler developers can try read-only | Score runs, workflow feedback, benchmark review |
| ADF | A vendor-neutral interoperability specification | Spec critique, conformance implementations, governance participation |

Charter is the reference implementation of ADF. ADF is not a Stackbilt product specification.

## Files

- [charter-announcement.md](./charter-announcement.md) — canonical long-form product announcement.
- [adf-announcement.md](./adf-announcement.md) — standards-focused announcement.
- [social-copy.md](./social-copy.md) — launch copy plus a post-release LinkedIn evidence-audit follow-up.
- [faq.md](./faq.md) — concise answers to predictable technical objections.
- [publish-checklist.md](./publish-checklist.md) — release record, remaining outreach tasks, and measurement sheet.
- [release-notes-1.9.2.md](./release-notes-1.9.2.md) — follow-up patch notes for evidence-documentation and compiled-context safety fixes.
- [release-notes-1.9.1.md](./release-notes-1.9.1.md) — notes for the published npm/GitHub patch release.
- [../assets/context-routing-benchmark.svg](../assets/context-routing-benchmark.svg) — 1200×630 share card based on the committed benchmark snapshot.
- [../assets/adf-spec-card.svg](../assets/adf-spec-card.svg) — 1200×630 neutral share card for the specification launch.

Render platform-ready PNG copies with:

```bash
pnpm run render:launch-assets
```

Set `CHARTER_CHROME_BIN` if Chrome is installed under a different executable name.

## Core facts approved for reuse

- Charter is Apache-2.0 and local-first.
- `charter score` is read-only unless `--badge --write` is explicitly passed.
- Product commands make no Charter service call; `npx` may contact npm to obtain the package.
- ADF resolution is deterministic and does not require an LLM.
- The synthetic benchmark preserves 30/30 rules byte-for-byte.
- Its four pinned tasks reduce estimated context by 40.0–77.4%, averaging 58.1%.
- Charter's estimator is structural and approximates one token per four characters; it is not a provider billing tokenizer.
- The exact-scoring migration harness extracts 178/178 expected items and restores 38/38 pointers; exact module routing currently passes 29/38 sessions, with all mismatches disclosed.
- The historical greenfield study is observational and does not establish model-outcome improvements.
- ADF Draft 0.1 has parser, resolver, and compiler conformance fixtures. Charter is the listed TypeScript reference implementation.

If a post needs a shorter claim, omit detail rather than strengthening the wording.

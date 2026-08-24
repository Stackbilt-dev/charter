# Charter + ADF Publishing Kit

Everything in this directory is publication-ready. Replace only bracketed placeholders, verify the linked changes are on GitHub, and publish in the sequence below.

## Canonical links

- Charter: https://github.com/Stackbilt-dev/charter
- Reproducible benchmark: https://github.com/Stackbilt-dev/charter/tree/main/examples/context-routing-benchmark
- ADF specification: https://github.com/adf-spec/adf
- ADF specification text: https://github.com/adf-spec/adf/blob/main/SPEC.md
- Charter npm package: https://www.npmjs.com/package/@stackbilt/cli
- Discord: https://discord.gg/aJmE8wmQDS

Do not publish benchmark links until the benchmark files are on `main`.

## Message split

| Launch | Lead with | Ask for |
|---|---|---|
| Charter | A working context compiler developers can try read-only | Score runs, workflow feedback, benchmark review |
| ADF | A vendor-neutral interoperability specification | Spec critique, conformance implementations, governance participation |

Charter is the reference implementation of ADF. ADF is not a Stackbilt product specification.

## Files

- [charter-announcement.md](./charter-announcement.md) — canonical long-form product announcement.
- [adf-announcement.md](./adf-announcement.md) — standards-focused announcement.
- [social-copy.md](./social-copy.md) — final copy for Hacker News, Reddit/forums, LinkedIn, X, and Product Hunt.
- [faq.md](./faq.md) — concise answers to predictable technical objections.
- [publish-checklist.md](./publish-checklist.md) — ordered launch procedure and measurement sheet.
- [release-notes-1.9.1.md](./release-notes-1.9.1.md) — patch-release notes ready for the npm/GitHub release that refreshes the package page.
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
- The greenfield study measured default context growing from 558 to 569 estimated tokens while the subject application reached 2,074 production LOC across 24 files.
- ADF Draft 0.1 has parser, resolver, and compiler conformance fixtures. Charter is the listed TypeScript reference implementation.

If a post needs a shorter claim, omit detail rather than strengthening the wording.

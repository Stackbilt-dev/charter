# v1.9.1 Publication Record and Outreach Checklist

> Release status: published on 2026-08-24. The [GitHub release](https://github.com/Stackbilt-dev/charter/releases/tag/v1.9.1) and all 13 npm packages are live. Unchecked items below are optional distribution or measurement work, not release blockers.

## Completed release gates

- [x] Merge the README, benchmark, CI, metadata, and publishing-kit changes to Charter `main`.
- [x] Confirm https://github.com/Stackbilt-dev/charter/tree/main/examples/context-routing-benchmark resolves publicly.
- [x] Run `pnpm run benchmark:context` from the release checkout.
- [x] Run the npm and pnpm packed-consumer install smoke.
- [x] Publish all 13 `@stackbilt/*` packages at `1.9.1` through trusted-publisher OIDC.
- [x] Verify the GitHub release and npm registry versions.
- [x] Publish the evidence register with estimated-token and model-outcome limitations.

## Remaining optional outreach

- [ ] Confirm the README renders [`context-routing-benchmark.svg`](../assets/context-routing-benchmark.svg) correctly on desktop and mobile.
- [ ] Run `pnpm run render:launch-assets` and use the PNG cards for platforms that do not accept SVG uploads.
- [ ] Run `npx @stackbilt/cli score` in a repository that does not already depend on Charter.
- [ ] Confirm the ADF repository description and topics remain neutral.
- [ ] Replace any bracketed placeholders in the final publication venue.
- [ ] Prepare a text-only fallback in case a platform suppresses the SVG preview.

## Original recommended publication order

Retained as the outreach plan; completing the npm/GitHub release did not imply that every promotional step below occurred.

### Day 0

1. Merge Charter changes.
2. Publish the next Charter patch if the npm page should match the launch immediately.
3. Verify all canonical links in [README.md](./README.md).
4. Publish the canonical Charter announcement on the Stackbilt-controlled site or LinkedIn article surface.

### Day 1

1. Submit the Charter Show HN post between 8:00 and 10:00 US Eastern.
2. Remain available for the first three hours.
3. Answer technical criticism directly; do not redirect every question to Discord.
4. Record questions that recur more than once.

### Day 2

1. Publish the ADF standards announcement separately.
2. Ask for review of normative behavior and fixtures, not Charter adoption.
3. Link back to the Charter benchmark only as reference-implementation evidence.

### Days 3–5

1. Publish the Reddit/forum version in one relevant community at a time.
2. Adapt the opening paragraph to the community rather than cross-posting identical text.
3. Publish the LinkedIn post with the benchmark SVG.
4. Publish the X thread.

### Week 2

1. Publish one read-only teardown of an outside repository after checking its contribution and branding expectations.
2. Publish a short “what we learned” follow-up using actual objections and failures.
3. Fix the highest-frequency onboarding problem before starting another announcement cycle.

## Response discipline

- Respond to a benchmark challenge with the fixture, runner, snapshot, and limitation—not a stronger claim.
- Respond to “why not AGENTS.md?” with the complementary-layer explanation.
- Respond to “yet another standard” by pointing to neutral governance and inviting an alternative implementation.
- Thank people who find routing failures and open a reproducible issue.
- Never describe npm downloads, clones, or impressions as users.
- Ask before quoting a user's repository, score, or feedback in later content.

## Launch-day measurement sheet

Record values at publication time, +24 hours, +7 days, and +30 days.

| Metric | T0 | +24h | +7d | +30d |
|---|---:|---:|---:|---:|
| GitHub unique visitors | | | | |
| Charter stars | | | | |
| Charter forks | | | | |
| ADF stars | | | | |
| npm weekly downloads | | | | |
| Public/opt-in score reports | | | | |
| Public/opt-in bootstrap confirmations | | | | |
| External badge/config repositories | | | | |
| Outside issues | | | | |
| Outside pull requests | | | | |

Capture the publication URL and exact text beside each measurement. Attribution is otherwise guesswork.

## Go/no-go gate used for v1.9.1

Publish only when all are true:

- benchmark snapshot passes;
- canonical links are public;
- npm command works in a clean repository;
- claims retain “estimated” and the tokenizer limitation;
- Charter and ADF posts have different calls to action;
- someone is available to respond after publication.

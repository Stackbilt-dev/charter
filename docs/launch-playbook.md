# Charter Launch Playbook

This playbook is for earning sustained adoption, not manufacturing a one-day traffic spike. The loop is:

```text
See a Charter score → score your own repo → fix visible gaps → publish the badge → someone else sees it
```

## Positioning

### Category

**Context compiler for AI coding agents**

Avoid leading with “governance toolkit.” Governance explains how Charter works and why teams can trust it; it is not the initial reason most developers will try it.

### One-line pitch

> Write your project rules once. Charter gives Claude Code, Codex, Cursor, and Gemini only the context each task needs.

### Expanded pitch

> Charter turns sprawling agent instruction files into modular, task-routed context. It compiles one `.ai/` source into every supported vendor format, enforces context budgets, and grades the result locally with no account or runtime service dependency.

### Initial audience

Focus on developers who:

- actively use at least two coding agents;
- maintain a substantial `CLAUDE.md`, `AGENTS.md`, or `.cursorrules` file;
- work in a repository large enough that agent orientation and rule drift are recurring costs;
- are comfortable running an `npx` command.

Do not begin with enterprise compliance buyers, generic scaffold users, or developers who have not yet experienced agent-context problems.

## Offer ladder

Each step should earn enough trust for the next one.

1. **Inspect:** `npx @stackbilt/cli score` is read-only and produces an immediate grade plus prioritized fixes.
2. **Adopt:** `npx @stackbilt/cli bootstrap --yes` creates `.ai/` and migrates existing instructions.
3. **Standardize:** `charter adf compile --target all --write` produces all vendor files from one source.
4. **Enforce:** compile checks, evidence checks, and the score run in CI.
5. **Share:** `charter score --badge --write` creates a public README badge.

The primary launch conversion is a successful score run. Stars and impressions are secondary.

## Required proof assets

### 1. Thirty-second terminal recording

Record at 1200×675 or another 16:9 size with large, readable text. Use a real sample repository containing two or more agent instruction files.

Shot list:

1. Show the large, duplicated instruction files with `wc -l`.
2. Run `npx @stackbilt/cli score` and pause on the grade and recommendations.
3. Run `charter adf migrate --dry-run` and show rules being assigned to modules.
4. Run `charter adf bundle --task "Fix the React login form"` and highlight loaded versus skipped modules.
5. End on `charter adf compile --target all --check` passing.

Do not speed the recording so much that output becomes decorative. The viewer should be able to understand the result with audio muted.

### 2. Reproducible benchmark

Publish one small fixture repository containing:

- the original monolithic instruction files;
- the migrated `.ai/` directory;
- three representative tasks;
- the exact Charter commands used;
- before/after estimated context for each task;
- limitations, including that Charter's token estimate is character-based rather than provider-tokenizer exact.

The benchmark should be rerunnable in CI. Avoid averages without the per-task raw results.

### 3. Three outside-repository teardowns

Choose recognizable open-source repositories that already contain substantive agent instructions. Open no unsolicited pull requests during the launch. Publish read-only analyses showing:

- current instruction-file size;
- duplicated or conflicting guidance;
- proposed module boundaries;
- task-specific context reduction;
- the resulting Charter score.

Ask maintainers for permission before using a project name or logo as an endorsement.

## Launch sequence

### Week 1: establish proof

- Ship the README positioning and read-only CTA.
- Produce the terminal recording.
- Publish the reproducible benchmark.
- Verify the npm landing page contains the same first-screen story.
- Ensure `charter score` works in a clean Node 18, 20, and 22 environment.
- Create one canonical link target rather than splitting traffic across GitHub, npm, and ecosystem pages.

### Week 2: launch narrowly

- Publish the Show HN post first and remain available to answer technical questions.
- Post the benchmark, not a generic product announcement, to relevant agent-development communities.
- Share one teardown per day rather than repeating the same launch message.
- Invite users to reply with their score and repository—not merely to star the project.
- Convert repeated objections and failures into visible issues and small releases.

### Weeks 3–4: compound

- Publish the best user result as a case study with permission.
- Add a gallery of repositories using the score badge.
- Ship fixes for the three most common onboarding failures.
- Publish aggregate, privacy-safe score findings only if the data was explicitly submitted by users.
- Repeat the launch around evidence, not around another feature list.

## Launch copy

### Hacker News

**Title**

> Show HN: Charter – compile one modular context source for Claude, Codex, Cursor and Gemini

**Opening**

> I kept accumulating agent instructions in CLAUDE.md, AGENTS.md and .cursorrules. The files duplicated each other, every task loaded rules it did not need, and changes drifted between tools.
>
> I built Charter, an Apache-2.0 local CLI that treats agent context like source code. Rules live in small `.ai/` modules, a manifest loads modules by task trigger, and Charter compiles those modules back into each vendor format. It also includes a read-only score command, so you can inspect a repo before allowing any changes:
>
> `npx @stackbilt/cli score`
>
> There are no product network calls or accounts. ADF is published separately as an open specification. I would especially value feedback on the routing model, the scoring rubric, and whether the compiled-file approach fits real multi-agent workflows.

### Reddit or developer forum

**Title**

> My coding-agent rule files became a second codebase, so I built a compiler for them

**Body direction**

Lead with the duplicated-file problem, show the terminal recording, disclose that you built Charter, and link directly to the benchmark. End with a specific question: “What is the most painful failure mode in your current agent instructions?” Avoid posting identical copy across communities.

### LinkedIn

> AI coding agents do not usually fail because a repository has no instructions. They fail because every instruction is loaded at once, the important rules are indistinguishable from preferences, and four vendor files quietly drift apart.
>
> Charter treats that context like compiled source: modular inputs, task-based routing, measurable budgets, and generated outputs for Claude Code, Codex, Cursor, and Gemini.
>
> The first command is deliberately read-only: `npx @stackbilt/cli score`.
>
> We published the implementation, the ADF specification, and the measurement methodology. I would like to see scores from real repositories—and hear where the rubric is wrong.

## Distribution surfaces

Prioritize surfaces where developers are already discussing context engineering:

1. GitHub README and repository social preview.
2. npm README and package keywords.
3. ADF specification documentation linking to Charter as the reference implementation.
4. Claude Code, Codex, Cursor, and MCP community directories where self-submission is permitted.
5. Technical posts centered on benchmarks and repository teardowns.
6. The existing Stackbilt ecosystem only after the standalone Charter story is understood.

Avoid paid promotion until the score-to-bootstrap conversion is understood. Buying impressions for an unclear activation path will make the numbers noisier, not healthier.

## Two-repository strategy

Keep the standard and the product visibly independent:

| Repository | Owns | Primary audience |
|---|---|---|
| [`adf-spec/adf`](https://github.com/adf-spec/adf) | Normative specification, governance, conformance fixtures, implementation registry | Tool builders, standards contributors, agent-platform maintainers |
| [`Stackbilt-dev/charter`](https://github.com/Stackbilt-dev/charter) | Reference implementation, CLI workflow, benchmarks, adoption guides, case studies | Developers and teams using coding agents |

Every Charter explanation of ADF should link to the neutral specification. The specification should link to Charter only as the reference implementation and explicitly welcome alternatives. Do not mirror normative prose into Charter where it can drift; link to `SPEC.md` and pin behavior with the conformance suite.

Coordinate launches without posting duplicate announcements:

- The ADF post asks for review of the format, resolution algorithm, interoperability contract, and governance.
- The Charter post asks developers to run the product, inspect the benchmark, and challenge the workflow.
- Cross-link the posts so standards discussion does not get buried under CLI support and product feedback does not become a specification debate.

## Measurement

Record a weekly funnel:

| Stage | Metric | Why it matters |
|---|---|---|
| Discovery | Unique repository visitors | Human attention reaching the canonical page |
| Curiosity | Opt-in score reports or campaign responses | People experiencing the product's first value |
| Activation | Public `.ai/` configs or opt-in bootstrap confirmations | Repositories adopting `.ai/` |
| Retention | Opt-in follow-up or later public activity | Continued use rather than one-time inspection |
| Sharing | New external badge URLs and mentions | The product loop reaching another developer |
| Community | Outside issues, PRs, and contributors | Trust and participation beyond the core team |

Use ratios, not raw totals:

- visitor → score run;
- score run → bootstrap;
- bootstrap → second-week activity;
- activated repository → badge/share;
- issue opened → first human response time.

### Baseline captured 2026-08-23

- GitHub stars: 0
- GitHub forks: 0
- GitHub unique visitors, preceding 14 days: 5
- GitHub unique cloners, preceding 14 days: 68
- npm CLI downloads, preceding 7 days: 76

Clone and npm counts can include automation and dependency installation. Do not describe them as users without corroborating activation data.

## Messaging guardrails

- Link every quantitative claim to a reproducible source.
- Say “estimated tokens” when using Charter's character-based estimator.
- Do not claim that instructions are ignored without a controlled evaluation.
- Do not present Stackbilt ecosystem adoption as independent community adoption.
- Do not ask for a star before delivering a useful result.
- Keep “local-first” precise: distinguish product network calls from npm downloading the package.
- Be explicit about which files a command writes before asking someone to run it.

## Definition of a successful first campaign

Within 30 days:

- at least 100 unique developers submit or publicly share a `charter score` result;
- at least 20 repositories publicly adopt `.ai/` or confirm bootstrap through an opt-in campaign response;
- at least 5 unrelated repositories publish a Charter badge or configuration;
- at least 3 users return in a later week;
- at least 2 outside contributors open a substantive issue or pull request.

These thresholds measure the beginning of a community loop. A large impression count without activation does not.

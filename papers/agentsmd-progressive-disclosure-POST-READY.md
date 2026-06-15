# POST-READY — AAIF progressive-disclosure proposal

**Reviewed and fact-checked 2026-06-11.** All references verified; prose aligned with
SPEC.md §4.2 and the shipped `charter adf compile` (merged in Stackbilt-dev/charter#203).

**Blocked on:** posting must happen under **Kurt's personal GitHub account** (per the
posting strategy — standards threads reward individuals). This machine's `gh` is
authenticated as `stackbilt-admin`, so it was deliberately NOT posted from here.

**To post:**
1. Comment 1 → https://github.com/agentsmd/agents.md/issues/135 — paste the body below.
2. Comment 2 → https://github.com/agentsmd/agents.md/issues/71 — paste the cross-reference at the bottom.

---

## Comment for #135 (paste everything between the markers)

<!-- post-body-start -->
## Proposal: Progressive disclosure via an optional module index

AGENTS.md works because it is one predictable file. It degrades for the same reason:

1. **Truncation is silent.** Codex caps project docs at 32 KiB by default; content past the cap is dropped without warning. Other hosts enforce smaller caps. Authors have no signal that half their rules never reached the model.
2. **Attention dilutes before truncation does.** Field guidance already converges on keeping AGENTS.md under ~150–200 lines because adherence falls off in long flat files. Real repos need far more than 200 lines of rules — they just don't need them *all at once*.
3. **The workaround is fragmenting the standard.** Teams are inventing ad-hoc splits today: `AGENTS.md.d/` directories, per-tool symlinks, skill-style frontmatter staging. Each is tool-specific, none is discoverable by other agents, and the spec's main asset — predictability — erodes with every private convention.

The spec needs an *official* answer to "my rules don't fit in one attention span," or it will accumulate unofficial ones.

### Design constraints

Any solution should preserve what made AGENTS.md win:

- **Flat files stay valid.** A plain AGENTS.md with no modules must remain fully conformant forever.
- **Graceful degradation.** A tool that has never heard of this proposal must still get useful behavior from a modular repo, with zero code changes.
- **Deterministic resolution.** Selecting which modules apply must not require an LLM call. String matching only.
- **No new file format.** Modules are plain Markdown.

### Proposal

#### 1. Module directory

A repo MAY add a module directory alongside AGENTS.md (aligning with the dedicated-directory direction in #71, which proposes `.agent/` — see open question 1):

```text
AGENTS.md          # entry point — always read first (unchanged)
.agents/
  testing.md       # loaded when the task involves tests
  frontend.md      # loaded when the task involves UI work
  security.md      # loaded when the task touches auth/secrets
```

#### 2. Module index in AGENTS.md

AGENTS.md declares its modules in an index — ordinary Markdown, fenced by HTML comments so tools can parse it deterministically:

```markdown
<!-- agents-modules -->
## Additional instructions

Read the matching file before working in these areas:

- `.agents/testing.md` — test conventions. Triggers: test, vitest, coverage, mock
- `.agents/frontend.md` — UI rules. Triggers: react, css, component, a11y
- `.agents/security.md` — auth/secrets handling. Triggers: auth, token, secret, cookie
<!-- /agents-modules -->
```

**Conforming tools** parse the index and inject matching modules' contents when the task description or touched file paths match a trigger (case-insensitive substring match — deliberately primitive, deliberately deterministic — a knowing simplification of the stricter prefix-stem rule Charter uses in production).

**Non-conforming tools** see an ordinary Markdown list instructing the agent to read specific files in specific situations. Current frontier models follow that instruction unaided — modular repos work *today* on tools that have never implemented this spec. That is the graceful-degradation property: the fallback is not "broken," it is "slightly less token-efficient."

#### 3. Optional budget hint

A module line MAY end with a size hint, e.g. `(~600 tokens)`. Tools MAY use hints to warn when always-loaded content approaches host caps (the silent-truncation problem becomes a lint error instead). Hints are advisory; tools MUST NOT fail on their absence.

#### Explicitly out of scope

- No new syntax beyond the two comment fences. No YAML frontmatter requirement, no schema file, no manifest format.
- No nesting (modules cannot declare sub-modules) in v1 — keep resolution single-pass.
- No conditional logic beyond keyword triggers. If/else belongs in tools, not the spec.

### Prior art and evidence

This mechanism is not speculative — it is extracted from a system running in production:

- **Charter** (Apache-2.0, [github.com/Stackbilt-dev/charter](https://github.com/Stackbilt-dev/charter)) has shipped trigger-based modular agent context since early 2026: a manifest declares always-loaded vs. on-demand modules with trigger keywords and per-bundle token budgets; a bundler composes exactly the modules a task needs. The repo governs itself with the mechanism on every commit.
- The migration direction is solved: Charter's `adf migrate` classifies an existing flat config file (CLAUDE.md, AGENTS.md, .cursorrules) by rule strength and routes content into modules automatically — so adoption does not require hand-splitting files.
- The compatibility direction is implemented: `charter adf compile --target agents` renders the modular source back to a flat AGENTS.md (with the module index exactly as above) for tools that want one file, and `--check` gates CI on drift between the two.

I'd be glad to contribute a conformance test suite (fixture repos + expected module-selection outputs) and adapt Charter's tooling as a neutral reference implementation under whatever home the Agentic AI Foundation (AAIF) prefers.

### Open questions for maintainers

1. `.agents/` vs `.agent/` vs `AGENTS.md.d/` — this proposal works with any; #71 should settle the name.
2. Should triggers match on the user's task text, on touched file paths, or both? (Charter's experience: both, union semantics, is what users expect.)
3. Does the index belong in AGENTS.md itself (this proposal — keeps one entry point) or in a separate manifest file (cleaner parsing, but breaks the "one file to read first" invariant)?
4. Minimum conformance: is parsing the fenced index required for v1.1 compliance, or a MAY with the Markdown fallback as the floor?
<!-- post-body-end -->

---

## Cross-reference comment for #71

<!-- xref-body-start -->
Related: I've posted a progressive-disclosure proposal in #135 that builds on the dedicated-directory direction proposed here — an optional, HTML-comment-fenced module index inside AGENTS.md that points at per-topic Markdown files with deterministic keyword triggers, while keeping flat AGENTS.md files fully conformant and degrading gracefully on tools that don't implement it. Whatever directory name this issue settles on (`.agent/`, `.agents/`, `AGENTS.md.d/`), the index mechanism works with it.
<!-- xref-body-end -->

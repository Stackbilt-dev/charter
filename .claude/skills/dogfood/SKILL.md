# Dogfood Skill

Capture real-world friction encountered while using Charter CLI in this repo.
Creates a `papers/AGENT_DX_FEEDBACK_NNN.md` entry and optionally escalates to a GitHub issue.

## When to Use
- A charter command behaved unexpectedly or produced confusing output
- A CLI flag is missing, awkward, or undiscoverable
- A hook, doctor check, or evidence gate surprised you
- An agent (Claude, Codex, etc.) struggled with Charter's output or documentation
- You noticed a gap between what Charter promises and what it delivers

## Steps

1. **Determine the next feedback ID**:
   ```bash
   ls papers/AGENT_DX_FEEDBACK_*.md | sort | tail -1
   ```
   Increment by 1 (e.g., if last is `007`, next is `ADX-008` → filename `AGENT_DX_FEEDBACK_008.md`).

2. **Classify the feedback**:

   **Bucket** (pick one):
   - `onboarding` — friction encountered during initial setup or first-time use
   - `daily-use` — friction during routine development workflows
   - `reliability-trust` — unexpected behavior, silent failures, wrong output
   - `output-ergonomics` — CLI output is hard to read, parse, or act on
   - `automation-ci` — friction in CI/pre-commit/hook contexts

   **Severity** (pick one):
   - `high` — blocks work or produces wrong results silently
   - `medium` — causes confusion or requires workaround
   - `low` — minor annoyance or polish issue

   **Status**: always `new` for fresh dogfood entries.

3. **Create the paper file** at `papers/AGENT_DX_FEEDBACK_NNN.md`:

   ```markdown
   ---
   title: "Agent DX Feedback: <short title>"
   feedback-id: ADX-NNN
   date: YYYY-MM-DD
   source: "Claude Code working on charter"
   severity: <high|medium|low>
   bucket: <bucket>
   status: new
   related: []
   tracked-issues: []
   tracked-prs: []
   ---

   # Agent DX Feedback: <short title>

   ## Observation
   <What happened. Be concrete — include the command run, the output received,
   and what was surprising or broken about it.>

   ## Root Cause
   <Why did this happen? Trace to the specific code, doc gap, or design decision.>

   ## Impact
   <Who is affected and how. Does this affect agents, humans, or both?>

   ## Recommended Charter Improvements
   ### P0/P1/P2: <fix title>
   <What should change and why.>
   ```

4. **Validate the paper passes lint**:
   ```bash
   pnpm run docs:check
   ```
   Fix any frontmatter errors before proceeding.

5. **Escalate to GitHub issue** if severity is `high` or the fix is clearly actionable:
   - Use `/issue` to file a formal issue, cross-referencing the ADX feedback ID in the body
   - Add the issue number to `tracked-issues` in the paper frontmatter

6. **Commit** using `/commit` — group the new paper (and any linked issue update) as a single commit:
   ```
   docs(feedback): ADX-NNN <short title>
   ```

## Notes
- Write observations while the friction is fresh — don't reconstruct from memory
- `source` should describe the working context: `"Claude Code working on charter"`, `"Codex agent on edgestack_v2"`, etc.
- Even small friction is worth capturing — low severity entries build the pattern record
- If you file a GitHub issue, update `tracked-issues` in the paper before committing

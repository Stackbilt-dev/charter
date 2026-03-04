# Issue Skill

File a well-structured GitHub issue against Stackbilt-dev/charter.

## Steps

1. **Understand the issue** — ask the user (or infer from context) what the problem or feature is. Identify:
   - Type: bug, enhancement, refactor, docs
   - Area: adf, cli, bootstrap, hook, doctor, setup, types
   - Priority: p0 (blocking), p1 (high), p2 (normal)
   - Milestone: v0.6.0 or v0.7.0 (or none if unplanned)

2. **Draft the issue body** using this structure:

   For **features/enhancements**:
   ```
   ## Problem
   <what is broken or missing>

   ## Proposed Solution
   <what should be built>

   ## Acceptance Criteria
   - [ ] ...
   - [ ] ...

   ## Dependencies
   <other issues this depends on, if any>
   ```

   For **bugs**:
   ```
   ## Problem
   <what is broken>

   ## Steps to Reproduce
   1. ...

   ## Expected Behavior
   <what should happen>

   ## Actual Behavior
   <what happens instead>

   ## Environment
   - Charter CLI: vX.Y.Z
   ```

3. **Select labels** from available: `bug`, `enhancement`, `type:feature`, `type:refactor`, `area:adf`, `priority:p0`, `priority:p1`, `priority:p2`, `good first issue`

4. **File the issue** using:
   ```
   gh issue create --repo Stackbilt-dev/charter \
     --title "..." \
     --body "..." \
     --label "..." \
     --milestone <number>
   ```

5. **Confirm** by printing the issue URL.

## Notes
- Milestone numbers: v0.6.0 = 1, v0.7.0 = 2
- Keep titles in conventional-commit style: `feat(area):`, `fix(area):`, `refactor(area):`, `docs:`
- Cross-reference related issues in the body using `#<number>`

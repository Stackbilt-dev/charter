# Charter Kit Governance Policy

This document defines the engineering governance policy for the `Stackbilt-dev/charter` OSS monorepo.
It is the authoritative reference for commit standards, change classification, exception handling,
and escalation paths.

---

## Commit Trailers

All commits to `main` that touch public-facing behavior must include at least one governance trailer.

### Required Trailers

| Trailer | When required |
|---------|--------------|
| `Governed-By: <policy-section>` | Breaking changes, architecture decisions, OSS API mutations |
| `Resolves-Request: <issue-url>` | Any change linked to a tracked GitHub issue |

### Trailer Format

```
feat(adf): add STACK field to manifest parser

Parses and exposes the STACK key from manifest.adf sections.

Governed-By: oss-additive-only-api
Resolves-Request: https://github.com/Stackbilt-dev/charter/issues/160
```

Trailers must appear after the blank line following the commit body. The `charter validate` command
enforces trailer format on CI. Coverage is reported by `charter audit`.

### Commit Trailer Coverage Target

- New repos: ≥50% of commits on `main` must carry trailers within 30 days of onboarding
- Established repos: ≥67% coverage earns full trailer score in `charter audit`

---

## Change Classification

Every PR should be classified using Charter's three-tier change model before merge:

| Class | Definition | Review requirement |
|-------|-----------|-------------------|
| `SURFACE` | Docs, comments, copy, rename with no behavior change | Author self-review |
| `LOCAL` | Bug fix or feature within a single package boundary | Standard PR review |
| `CROSS_CUTTING` | API contract change, inter-package dependency, CI workflow, ADF schema | Architecture review required |

Run `charter setup --detect-only` to get a suggested classification. For cross_cutting changes,
include the output in the PR description.

### Classification Tags in PR Titles

Append `[SURFACE]`, `[LOCAL]`, or `[CROSS_CUTTING]` to PR titles for cross-cutting changes when
the conventional commit prefix doesn't make the scope obvious.

---

## Exception Path

Exceptions to this policy require explicit approval and documentation.

### Valid Exception Conditions

- **Emergency hotfix**: Production incident requiring immediate merge without full governance coverage.
  Must be followed within 24 hours by a follow-up commit adding missing trailers.
- **Waiver request**: Engineering lead approves an exception for a specific PR via a GitHub issue
  comment with the label `governance-waiver`.
- **Override for tooling PRs**: Automated dependency updates (Dependabot, Renovate) are exempt from
  trailer requirements but must still pass all CI checks.

### Documenting an Exception

Add an `Exception:` trailer to any commit that knowingly bypasses a policy requirement:

```
chore(deps): bump vitest to 5.0.0

Exception: automated dependency update — trailer waiver per governance-policy.md §Exception Path
```

Exceptions are surfaced in `charter audit --format json` under `git.governedByRefs`.

---

## Escalation and Approval

### When to Escalate

Escalate to an architectural review when:

- A PR changes a type exported from `@stackbilt/types`
- A PR removes or renames a public export from any OSS package
- A PR modifies `.ai/manifest.adf` DEFAULT_LOAD entries
- A PR adds a new inter-package dependency
- The `charter setup --detect-only` output flags `CROSS_CUTTING` with `HIGH` confidence

### Escalation Process

1. Open a GitHub issue tagged `architecture-review` describing the change and its rationale
2. Link the issue in the PR description and add the `Governed-By:` trailer referencing the issue
3. Request explicit approval from `@Stackbilt-dev/charter-maintainers` before merge
4. Record the architectural decision in `.ai/state.adf` under the `DECISIONS` section if it
   changes the module's long-term direction

### Approval Authority

| Change type | Approval required from |
|-------------|----------------------|
| Public API removal | Two maintainer reviews |
| Major version bump | Engineering lead sign-off |
| ADF manifest restructure | Architecture review (GitHub issue + `architecture-review` label) |
| CI/CD pipeline changes | DevOps + one maintainer |

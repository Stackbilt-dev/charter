---
title: "Agent DX Feedback: charter CLI UX — Bootstrap, Migrate, Doctor, and Output Ergonomics"
feedback-id: ADX-005
date: 2026-02-28
source: "Claude Opus 4.6 (Anthropic) UX walkthrough of charter CLI"
severity: medium
bucket: output-ergonomics
status: triaged
related:
  - ADX-004 (bootstrap overwrite hazard)
  - ADX-003 (install automation friction)
  - ADX-002 (onboarding friction baseline)
tracked-issues: []
tracked-prs: []
---

# Agent DX Feedback: charter CLI UX — Bootstrap, Migrate, Doctor, and Output Ergonomics

## Summary

End-to-end UX walkthrough of the charter CLI surfaced 8 findings across bootstrap,
migrate, doctor, audit, and output formatting. The overall impression is strongly
positive — bootstrap delivers high value with a single command. The issues below are
edge-case robustness and output ergonomics, not fundamental design problems.

## Findings

### F1. Bootstrap value is high (positive signal)

One command creates governance + ADF + CI quickly. The bootstrap flow is the strongest
onboarding path charter has. This validates the ADX-002/ADX-003 investment in reducing
setup friction.

**No action needed** — document as a positive baseline for future regression testing.

### F2. Hook install: false "not inside a git repository" failure

`charter bootstrap` hook-install step failed with:

> Not inside a git repository

...while `charter doctor` and `git rev-parse --show-toplevel` both succeeded in the
same shell session and working directory.

**Likely cause:** The hook-install codepath resolves the git root differently from the
doctor/audit codepaths. Possible cwd drift if the install step spawns a subprocess
that changes directory, or a different git-detection helper that doesn't handle
WSL/Windows path translation.

**Severity:** Medium — breaks bootstrap in WSL environments; manual `.githooks` copy
works around it.

**Recommended fix:**
- Unify git-root resolution across all CLI commands (single `resolveGitRoot()` utility)
- Add integration test: run hook-install from a subdirectory of a git repo
- If the root cause is WSL path translation, normalize paths before calling `git rev-parse`

### F3. `adf migrate` on `.cursorrules` fails with patch error

Running `charter adf migrate` against a `.cursorrules` file failed with a patch error:

> ADD_BULLET into text section

The migrator attempted to apply a structured ADF patch operation (ADD_BULLET) to a
section that contained free-form text rather than a bullet list.

**Severity:** Medium — `.cursorrules` is a common migration source; failure here blocks
the recommended onboarding path.

**Recommended fix:**
- Detect section content type before applying bullet operations
- Fall back to `APPEND_TEXT` when the target section is free-form prose
- Emit a structured warning: `"section 'X' is prose, not a list — appended as text"`

### F4. Doctor warns on `.cursorrules` even after thin-pointer conversion

After converting `.cursorrules` to a thin pointer (referencing `.ai/` as the canonical
source), `charter doctor` continued to warn about the file. The warning only cleared
after deleting `.cursorrules` entirely.

**Likely cause:** Doctor checks for file existence rather than file content. A thin
pointer is functionally equivalent to deletion (the file just says "see .ai/"), but
doctor doesn't parse the content to determine whether it's a thin pointer.

**Severity:** Low — cosmetic; causes false positive warnings that erode trust in doctor
output over time.

**Recommended fix:**
- Detect thin-pointer pattern in `.cursorrules` (e.g., file contains only a pointer
  comment and no substantive rules)
- Suppress warning when the file is a recognized thin pointer
- Alternatively, document that `.cursorrules` should be deleted (not converted) post-migration

### F5. Bootstrap install step fails under sandboxed EPERM

When running inside a sandboxed environment (e.g., Claude Code sandbox, restricted
shell), the npm install step fails with `EPERM`. The error message is clear about
what happened but doesn't suggest recovery.

**Severity:** Low — the error is honest, but agents and users lose time diagnosing it.

**Recommended fix:**
Add a hint to the error output:
```
Install failed (EPERM). Retry outside the sandbox:
  npm install @stackbilt/charter --save-dev
Then re-run: charter bootstrap --skip install
```

### F6. `audit` hard error on repos with no HEAD

Running `charter audit` on a freshly initialized repository (no commits yet) produces
a hard error because there is no HEAD to diff against.

**Severity:** Low — edge case (fresh repos), but it's a poor first impression for users
who run `charter bootstrap && charter audit` immediately.

**Recommended fix:**
- Detect the no-HEAD state with `git rev-parse HEAD` before attempting audit
- Return a structured response:
  ```json
  {
    "status": "skipped",
    "reason": "no-commits-yet",
    "message": "No commits to audit. Run audit after your first commit."
  }
  ```
- Exit 0 (not an error)

### F7. `migrate` JSON output is very large; compact mode needed

The JSON output from `charter adf migrate` is comprehensive but extremely large. For
agent consumption, most of the bulk is unnecessary — agents need the status, warnings,
and file-level summary, not the full patch payloads.

**Severity:** Low — doesn't break anything, but wastes agent context window tokens and
makes log review harder.

**Recommended fix:**
- Add `--compact` or `--summary` flag that emits:
  ```json
  {
    "status": "success",
    "filesProcessed": 3,
    "warnings": ["..."],
    "patchesApplied": 12
  }
  ```
- Keep the verbose output as default or behind `--verbose` for debugging
- Consider a `--format brief` option consistent with other CLI tools

### F8. Encoding roughness in generated ADF text

Some terminal contexts show emoji/mojibake artifacts in ADF-generated text. ADF section
headers use emoji prefixes (e.g., `🧠 CONTEXT:`, `📖 GUIDE:`) which render incorrectly
in terminals without full Unicode support.

**Severity:** Low — cosmetic, but confusing in CI logs and minimal terminal emulators.

**Recommended fix:**
- Add `--ascii` or `--no-emoji` flag for all output commands
- Map emoji section headers to ASCII equivalents: `[CONTEXT]:`, `[GUIDE]:`, etc.
- Detect terminal capabilities (`$TERM`, `$LANG`) and auto-select ASCII mode when
  Unicode support is uncertain
- Alternatively, make the ADF spec allow both emoji and ASCII section headers

## Priority Summary

| ID | Finding | Severity | Effort |
|----|---------|----------|--------|
| F2 | Hook install git-detection bug | Medium | Small (unify git-root helper) |
| F3 | Migrate patch error on prose sections | Medium | Medium (content-type detection) |
| F4 | Doctor false positive on thin pointers | Low | Small (pointer detection) |
| F5 | Install EPERM missing retry hint | Low | Trivial (string change) |
| F6 | Audit hard error on no-HEAD | Low | Small (guard clause) |
| F7 | Migrate JSON too large for agents | Low | Medium (compact output mode) |
| F8 | Emoji encoding in minimal terminals | Low | Medium (ASCII output option) |

## Relationship to Prior Feedback

- **ADX-002** introduced the bootstrap path; F2 and F5 are friction in that path
- **ADX-003** covered install automation; F5 is the sandboxed variant of that issue
- **ADX-004** covered destructive overwrites; F2 shows another bootstrap failure mode
- F7 and F8 are new categories (output ergonomics) not covered in prior feedback

## Summary

- What changed?
- Why was this change needed?

## Scope

- [ ] `@stackbilt/types`
- [ ] `@stackbilt/core`
- [ ] `@stackbilt/git`
- [ ] `@stackbilt/classify`
- [ ] `@stackbilt/validate`
- [ ] `@stackbilt/drift`
- [ ] `@stackbilt/ci`
- [ ] `@stackbilt/cli`
- [ ] Docs only

## Validation

Run from repo root and paste relevant output:

```bash
pnpm run typecheck
pnpm run build
```

CLI behavior checks (if applicable):

```bash
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js doctor --format json
node packages/cli/dist/bin.js validate --format json
```

## Compatibility

- [ ] No breaking changes
- [ ] Breaking change (explain migration below)

Migration notes (if breaking):

## Agent Contract Impact

- [ ] No JSON schema/output contract changes
- [ ] JSON output/exit-code behavior changed (documented in `README.md` + `CHANGELOG.md`)

Details:

## Linked Issues

Closes #

## Screenshots / Output Samples (if applicable)

Include command output snippets or screenshots for behavior/UI changes.

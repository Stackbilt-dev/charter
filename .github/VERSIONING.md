# Versioning Invariant

Charter uses **unified workspace versioning**: every package under `packages/*/package.json` carries the same version as the release tag.

## Invariant

For any release tag `vX.Y.Z`:

```
packages/*/package.json  →  "version": "X.Y.Z"
```

All packages under `packages/*` ship together at the same version. There is no per-package version drift.

## Enforcement

`.github/workflows/release.yml` — `publish-npm` job, "Verify tag and workspace versions" step — enforces this at release time. It loops over every `packages/*/package.json` and fails the build if any version does not match the tag.

## Migration note

If Charter ever adopts independent per-package versioning, the enforcement step must be reworked before the first diverging release. Each package would need its own expected version source (e.g. the package's own `package.json` rather than the global tag). See [#122](https://github.com/Stackbilt-dev/charter/issues/122) for the original discussion.

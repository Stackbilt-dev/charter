# Release Skill

Execute the full Charter release process for the current version bump.

## Steps

1. **Determine version** — read current version from `packages/cli/package.json`. Ask user to confirm or specify the new version (patch/minor/major).

2. **Update CHANGELOG.md** — move the `[Unreleased]` section to a new version section with today's date. Format: `## [X.Y.Z] - YYYY-MM-DD`.

3. **Bump all package versions** — update `version` in every `packages/*/package.json` and the root `package.json` devDependency for `@stackbilt/cli`.

4. **Build** — run `pnpm run build` and confirm it succeeds with no errors.

5. **Commit** — use `/commit` to stage and commit all version/changelog changes. Message format: `chore(release): bump all packages to vX.Y.Z`.

6. **Tag** — run `git tag vX.Y.Z` and `git push origin main --tags`.

7. **Publish** — run `pnpm publish -r --access public`. Watch for any package-specific errors.

8. **GitHub release** — run `gh release create vX.Y.Z --title "vX.Y.Z" --notes-from-tag` or draft notes from the CHANGELOG section. Use `--repo Stackbilt-dev/charter`.

9. **Confirm** — run `npm view @stackbilt/cli version` to verify the published version is live.

## Notes
- Always build before tagging — never tag a broken build.
- If publish fails mid-way, check which packages succeeded before retrying.
- The root `package.json` dogfoods `@stackbilt/cli` — update that devDependency too.

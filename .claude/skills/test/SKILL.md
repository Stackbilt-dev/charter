# Test Skill

Run tests for the Charter monorepo with correct filter syntax and clear reporting.

## Steps

1. **Determine scope** — infer from context which package(s) to test, or run all.

2. **Run tests**:

   All packages:
   ```bash
   pnpm run test
   ```

   Single package (by name):
   ```bash
   pnpm exec vitest run --project @stackbilt/<package>
   ```
   Valid packages: `adf`, `cli`, `classify`, `core`, `drift`, `git`, `types`, `validate`, `ci`

   Single test file:
   ```bash
   pnpm exec vitest run packages/<package>/src/__tests__/<file>.test.ts
   ```

   Watch mode (interactive):
   ```bash
   pnpm run test:watch
   ```

   With coverage:
   ```bash
   pnpm run test:coverage
   ```

3. **Report results** — summarize:
   - Pass/fail counts per package
   - Any failing test names and the assertion that failed
   - Whether the failure is pre-existing or introduced by recent changes

## Notes
- Tests use Vitest. Config is in the root `vitest.config.ts`.
- If a test fails due to a missing build artifact (`dist/`), run `pnpm run build` first.
- Pre-existing failures should be noted but not necessarily fixed unless that is the task.

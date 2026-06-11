import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Worktree-aware alias resolution: maps @stackbilt/* workspace packages to
// their local dist/ directories so vitest can resolve cross-package imports
// without a fully linked pnpm workspace node_modules tree.
const worktreeRoot = new URL('.', import.meta.url).pathname;
const pkg = (name: string) => resolve(worktreeRoot, `packages/${name}/dist/index.js`);

export default defineConfig({
  test: {
    include: ['packages/*/src/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@stackbilt/adf': pkg('adf'),
      '@stackbilt/blast': pkg('blast'),
      '@stackbilt/ci': pkg('ci'),
      '@stackbilt/classify': pkg('classify'),
      '@stackbilt/core': pkg('core'),
      '@stackbilt/drift': pkg('drift'),
      '@stackbilt/git': pkg('git'),
      '@stackbilt/policies': pkg('policies'),
      '@stackbilt/surface': pkg('surface'),
      '@stackbilt/types': pkg('types'),
      '@stackbilt/validate': pkg('validate'),
    },
  },
});

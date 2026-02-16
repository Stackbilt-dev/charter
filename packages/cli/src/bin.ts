#!/usr/bin/env node

/**
 * charter CLI entrypoint
 *
 * Usage:
 *   npx charter init          # Scaffold .charter/ directory
 *   npx charter validate      # Run governance checks on staged/changed files
 *   npx charter audit         # Generate governance audit report
 *   npx charter drift         # Scan codebase for pattern drift
 *   npx charter classify <subject>  # Classify a change
 */

import { run } from './index';

run(process.argv.slice(2)).catch((err) => {
  console.error('charter:', err.message || err);
  process.exit(1);
});

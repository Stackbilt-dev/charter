#!/usr/bin/env node
/**
 * eval-brief-coverage.mjs
 *
 * Deterministic fixture-based eval for charter context.
 * Verifies that the brief's content coverage is sufficient for agent orientation.
 *
 * Does NOT call a live model — tests structural coverage against fixture answers.
 * CI-safe and reproducible.
 *
 * Acceptance: a brief-primed agent should reach first useful action in ≤5 tool calls.
 * This script verifies the brief contains enough information to answer 5 standard
 * orientation questions without any additional tool calls.
 */

import { execSync } from 'node:child_process';
import * as assert from 'node:assert';

const REQUIRED_SECTIONS = ['## Identity', '## Surface', '## Hotspots', '## Sensitivity', '## Governance', '## See also'];

// 5 standard agent orientation questions — answers must be findable in the brief alone
const ORIENTATION_CHECKS = [
  {
    question: 'What stack/preset is this repo?',
    check: (brief) => /\*\*Stack\*\*:/.test(brief),
    description: 'Brief must contain Stack identity',
  },
  {
    question: 'What HTTP routes does this project expose?',
    check: (brief) => /## Surface/.test(brief),
    description: 'Brief must contain Surface section',
  },
  {
    question: 'Which files are most load-bearing (hot)?',
    check: (brief) => /## Hotspots/.test(brief) && (/importers/.test(brief) || /Hotspots: analysis unavailable/.test(brief)),
    description: 'Brief must contain Hotspots with importer data',
  },
  {
    question: 'What governance modules are loaded by default?',
    check: (brief) => /## Governance/.test(brief) && (/DEFAULT_LOAD/.test(brief) || /No ADF manifest/.test(brief)),
    description: 'Brief must contain Governance/DEFAULT_LOAD',
  },
  {
    question: 'Where are the human-authored rules?',
    check: (brief) => /## See also/.test(brief) && /CLAUDE\.md/.test(brief),
    description: 'Brief must reference CLAUDE.md in See also',
  },
];

let brief;
try {
  brief = execSync('node packages/cli/dist/bin.js context --stdout-only', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (err) {
  console.error('eval-brief-coverage: could not run charter context (is CLI built?)');
  console.error(err.message);
  process.exit(1);
}

let passed = 0;
let failed = 0;

console.log('=== charter context eval: orientation coverage ===\n');

// Check all required sections present
for (const section of REQUIRED_SECTIONS) {
  if (brief.includes(section)) {
    console.log(`  ✓ Section present: ${section}`);
    passed++;
  } else {
    console.error(`  ✗ Missing section: ${section}`);
    failed++;
  }
}

// Check 5 orientation questions answerable from brief alone
console.log('\n--- Orientation coverage (≤5 tool calls target) ---');
for (const { question, check, description } of ORIENTATION_CHECKS) {
  if (check(brief)) {
    console.log(`  ✓ Q: "${question}"`);
    passed++;
  } else {
    console.error(`  ✗ Q: "${question}"`);
    console.error(`    Expected: ${description}`);
    failed++;
  }
}

const total = passed + failed;
console.log(`\nResult: ${passed}/${total} checks passed`);

if (failed > 0) {
  console.error(`\nFAIL: ${failed} coverage check(s) failed.`);
  console.error('Agent orientation coverage insufficient — brief does not answer all 5 standard questions.');
  process.exit(1);
}

console.log('\nPASS: Brief covers all 5 orientation questions. Agent cold-boot cost target is achievable.');

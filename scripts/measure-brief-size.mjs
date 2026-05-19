#!/usr/bin/env node
// scripts/measure-brief-size.mjs
import { execSync } from 'node:child_process';

const TOKEN_BUDGET = 2000;
const CHARS_PER_TOKEN = 4;
const CHAR_BUDGET = TOKEN_BUDGET * CHARS_PER_TOKEN;

let output;
try {
  output = execSync('node packages/cli/dist/bin.js context --stdout-only', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (err) {
  console.error('measure-brief-size: could not run charter context (is CLI built?)');
  console.error(err.message);
  process.exit(1);
}

const chars = output.length;
const estimatedTokens = Math.ceil(chars / CHARS_PER_TOKEN);
console.log(`Brief size: ${chars} chars ≈ ${estimatedTokens} tokens (budget: ${TOKEN_BUDGET})`);

if (estimatedTokens > TOKEN_BUDGET) {
  console.error(`ERROR: Brief exceeds ${TOKEN_BUDGET}-token budget by ${estimatedTokens - TOKEN_BUDGET} tokens.`);
  console.error('Reduce section content or verify truncation logic in packages/cli/src/commands/context.ts');
  process.exit(1);
}

console.log('OK: Brief is within token budget.');

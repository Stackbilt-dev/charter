import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const outPath = args.out || 'governance/scorecard.json';
const validatePath = args.validate || 'governance/validate.json';
const driftPath = args.drift || 'governance/drift.json';

const validate = await readJsonIfExists(validatePath);
const drift = await readJsonIfExists(driftPath);
const repoName = args.repo || process.env.SCORECARD_REPO_NAME || 'digitalcsa-kit';
const scorecard = {
  repo: {
    name: repoName,
    source: deriveSource(args.source || process.env.SCORECARD_REPO_SOURCE || '', repoName),
    commit: process.env.GITHUB_SHA || deriveCommit(),
  },
  generatedAt: new Date().toISOString(),
  governanceMode: (process.env.GOVERNANCE_MODE || 'advisory').toLowerCase() === 'enforced' ? 'enforced' : 'advisory',
  charterValidate: {
    status: normalizeStatus(validate?.status),
    checksRun: typeof validate?.commits === 'number' ? validate.commits : 0,
    warnings: getCount(validate, ['warnings', 'suggestions']),
    errors: getCount(validate, ['errors', 'evidence.policyOffenders']),
  },
  charterDrift: {
    status: normalizeStatus(drift?.status),
    driftScore: typeof drift?.driftScore === 'number' ? drift.driftScore : undefined,
    patternsCustomized: toNumberOrUndefined(drift?.patternsCustomized),
  },
  csaDecisions: {
    decisionIds: parseCsv(process.env.CSA_DECISION_IDS),
    openRequests: toNumberOrZero(process.env.CSA_OPEN_REQUESTS),
    lastDecisionAt: process.env.CSA_LAST_DECISION_AT || undefined,
  },
  notes: 'Generated in CI from Charter JSON outputs.',
};

validateScorecard(scorecard);
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(scorecard, null, 2), 'utf8');
console.log(`Wrote ${outPath}`);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--out') parsed.out = argv[i + 1];
    if (token === '--validate') parsed.validate = argv[i + 1];
    if (token === '--drift') parsed.drift = argv[i + 1];
    if (token === '--repo') parsed.repo = argv[i + 1];
    if (token === '--source') parsed.source = argv[i + 1];
  }
  return parsed;
}

function parseCsv(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'pass' || normalized === 'ok') return 'pass';
  if (normalized === 'warn' || normalized === 'warning') return 'warn';
  if (normalized === 'fail' || normalized === 'error') return 'fail';
  return 'warn';
}

function getCount(obj, paths) {
  for (const keyPath of paths) {
    const value = deepGet(obj, keyPath);
    if (typeof value === 'number') return value;
    if (Array.isArray(value)) return value.length;
  }
  return 0;
}

function deepGet(obj, keyPath) {
  return keyPath.split('.').reduce((acc, segment) => (acc ? acc[segment] : undefined), obj);
}

function toNumberOrUndefined(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toNumberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function deriveSource(explicitSource, repoName) {
  if (explicitSource && explicitSource.trim().length > 0) return explicitSource.trim();
  try {
    const remote = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
    if (remote.length > 0) return remote;
  } catch {
    // noop
  }
  return `https://github.com/${repoName}`;
}

function deriveCommit() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function validateScorecard(candidate) {
  const required = ['repo', 'generatedAt', 'governanceMode', 'charterValidate', 'charterDrift', 'csaDecisions'];
  for (const field of required) {
    if (!(field in candidate)) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
  if (!candidate.repo.source || candidate.repo.source.trim().length === 0) {
    throw new Error('repo.source is required');
  }
}

import fs from 'node:fs/promises';

const args = parseArgs(process.argv.slice(2));
const scorecardPath = args.file || 'governance/scorecard.json';
const raw = await fs.readFile(scorecardPath, 'utf8');
const data = JSON.parse(raw);

const errors = [];
const allowedStatus = new Set(['pass', 'warn', 'fail']);
const allowedMode = new Set(['advisory', 'enforced']);

requireField(data, 'repo', errors);
requireField(data, 'generatedAt', errors);
requireField(data, 'governanceMode', errors);
requireField(data, 'charterValidate', errors);
requireField(data, 'charterDrift', errors);
requireField(data, 'csaDecisions', errors);

if (data.repo) {
  requireField(data.repo, 'name', errors, 'repo.name');
  requireField(data.repo, 'source', errors, 'repo.source');
  if (typeof data.repo.name !== 'string' || data.repo.name.trim().length === 0) {
    errors.push('repo.name must be a non-empty string');
  }
  if (typeof data.repo.source !== 'string' || data.repo.source.trim().length === 0) {
    errors.push('repo.source must be a non-empty string');
  }
}

if (!allowedMode.has(data.governanceMode)) {
  errors.push('governanceMode must be advisory or enforced');
}

if (data.charterValidate) {
  if (!allowedStatus.has(data.charterValidate.status)) {
    errors.push('charterValidate.status must be pass, warn, or fail');
  }
  validateNonNegativeInt(data.charterValidate.checksRun, 'charterValidate.checksRun', errors, true);
  validateNonNegativeInt(data.charterValidate.warnings, 'charterValidate.warnings', errors, true);
  validateNonNegativeInt(data.charterValidate.errors, 'charterValidate.errors', errors, true);
}

if (data.charterDrift) {
  if (!allowedStatus.has(data.charterDrift.status)) {
    errors.push('charterDrift.status must be pass, warn, or fail');
  }
  if (data.charterDrift.driftScore !== undefined) {
    if (typeof data.charterDrift.driftScore !== 'number' || data.charterDrift.driftScore < 0 || data.charterDrift.driftScore > 1) {
      errors.push('charterDrift.driftScore must be a number between 0 and 1');
    }
  }
  if (data.charterDrift.patternsCustomized !== undefined) {
    validateNonNegativeInt(data.charterDrift.patternsCustomized, 'charterDrift.patternsCustomized', errors, false);
  }
}

if (data.csaDecisions) {
  if (!Array.isArray(data.csaDecisions.decisionIds)) {
    errors.push('csaDecisions.decisionIds must be an array');
  }
  validateNonNegativeInt(data.csaDecisions.openRequests, 'csaDecisions.openRequests', errors, false);
}

if (errors.length > 0) {
  console.error('Scorecard validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Scorecard validation passed: ${scorecardPath}`);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--file') parsed.file = argv[i + 1];
  }
  return parsed;
}

function requireField(obj, field, errors, label) {
  if (!(field in obj)) {
    errors.push(`${label || field} is required`);
  }
}

function validateNonNegativeInt(value, label, errors, optional) {
  if (value === undefined) {
    if (!optional) errors.push(`${label} is required`);
    return;
  }
  if (!Number.isInteger(value) || value < 0) {
    errors.push(`${label} must be a non-negative integer`);
  }
}

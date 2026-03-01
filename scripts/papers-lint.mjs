import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const cwd = process.cwd();
const papersDir = path.join(cwd, 'papers');

const feedbackPattern = /^AGENT_DX_FEEDBACK_\d{3}\.md$/;
const feedbackRequiredKeys = [
  'feedback-id',
  'date',
  'source',
  'severity',
  'bucket',
  'status',
  'tracked-issues',
  'tracked-prs'
];

const releasePlanRequiredKeys = [
  'release',
  'status',
  'target-window',
  'charter-version-base',
  'inputs',
  'milestone-link',
  'owner'
];

const allowedBuckets = new Set([
  'onboarding',
  'daily-use',
  'reliability-trust',
  'output-ergonomics',
  'automation-ci'
]);

const allowedFeedbackStatus = new Set(['new', 'triaged', 'planned', 'shipped']);
const allowedReleaseStatus = new Set(['draft', 'active', 'shipped', 'superseded']);

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    return null;
  }

  const map = new Map();
  const lines = match[1].split(/\r?\n/);
  let activeListKey = null;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      const [, key, valueRaw] = keyMatch;
      const value = valueRaw.trim();

      if (value === '') {
        map.set(key, []);
        activeListKey = key;
      } else {
        map.set(key, value);
        activeListKey = null;
      }
      continue;
    }

    const listMatch = line.match(/^\s*-\s*(.*)$/);
    if (listMatch && activeListKey) {
      const existing = map.get(activeListKey);
      if (Array.isArray(existing)) {
        existing.push(listMatch[1].trim());
      }
      continue;
    }

    activeListKey = null;
  }

  return map;
}

function normalizeScalar(value) {
  if (Array.isArray(value)) {
    return '';
  }
  return String(value).trim().replace(/^"|"$/g, '');
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value;
  }

  const scalar = normalizeScalar(value);
  if (scalar === '[]') {
    return [];
  }

  return null;
}

async function listFiles(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function requireKeys(map, keys, filePath, failures) {
  for (const key of keys) {
    if (!map.has(key)) {
      failures.push(`${filePath}: missing frontmatter key '${key}'`);
    }
  }
}

async function lintFeedbackFiles(failures) {
  const entries = await listFiles(papersDir);
  const feedbackFiles = entries.filter((entry) => entry.isFile() && feedbackPattern.test(entry.name));

  for (const file of feedbackFiles) {
    const fullPath = path.join(papersDir, file.name);
    const relPath = path.relative(cwd, fullPath);
    const raw = await fs.readFile(fullPath, 'utf8');
    const fm = parseFrontmatter(raw);

    if (!fm) {
      failures.push(`${relPath}: missing YAML frontmatter block`);
      continue;
    }

    requireKeys(fm, feedbackRequiredKeys, relPath, failures);

    const bucket = normalizeScalar(fm.get('bucket'));
    if (bucket && !allowedBuckets.has(bucket)) {
      failures.push(`${relPath}: invalid bucket '${bucket}'`);
    }

    const status = normalizeScalar(fm.get('status'));
    if (status && !allowedFeedbackStatus.has(status)) {
      failures.push(`${relPath}: invalid status '${status}'`);
    }

    const trackedIssues = normalizeList(fm.get('tracked-issues'));
    const trackedPrs = normalizeList(fm.get('tracked-prs'));

    if (!Array.isArray(trackedIssues)) {
      failures.push(`${relPath}: 'tracked-issues' must be a YAML list`);
    }

    if (!Array.isArray(trackedPrs)) {
      failures.push(`${relPath}: 'tracked-prs' must be a YAML list`);
    }
  }
}

async function lintReleasePlans(failures) {
  const releaseDir = path.join(papersDir, 'releases');
  const entries = await listFiles(releaseDir);
  const planFiles = entries.filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith('-plan.md') &&
      entry.name !== 'template.release-plan.md'
  );

  for (const file of planFiles) {
    const fullPath = path.join(releaseDir, file.name);
    const relPath = path.relative(cwd, fullPath);
    const raw = await fs.readFile(fullPath, 'utf8');
    const fm = parseFrontmatter(raw);

    if (!fm) {
      failures.push(`${relPath}: missing YAML frontmatter block`);
      continue;
    }

    requireKeys(fm, releasePlanRequiredKeys, relPath, failures);

    const status = normalizeScalar(fm.get('status'));
    if (status && !allowedReleaseStatus.has(status)) {
      failures.push(`${relPath}: invalid release status '${status}'`);
    }

    const inputs = normalizeList(fm.get('inputs'));
    if (!Array.isArray(inputs) || inputs.length === 0) {
      failures.push(`${relPath}: 'inputs' must be a non-empty YAML list`);
    }
  }
}

async function main() {
  const failures = [];

  await lintFeedbackFiles(failures);
  await lintReleasePlans(failures);

  if (failures.length > 0) {
    console.error('papers-lint failed');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log('papers-lint passed');
}

main().catch((error) => {
  console.error(`papers-lint fatal: ${error.message}`);
  process.exit(1);
});

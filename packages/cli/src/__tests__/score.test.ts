import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { run } from '../index';
import { scoreCommand } from '../commands/score';

const baseOptions: CLIOptions = {
  configPath: '.charter',
  format: 'json',
  ciMode: false,
  yes: false,
};

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  vi.restoreAllMocks();
});

describe('scoreCommand', () => {
  it('gives a strong score to a well-grounded Charter-style repo', async () => {
    const tmp = createTempRepo();
    process.chdir(tmp);

    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.githooks'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.codex', 'skills', 'review'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });

    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'ready-repo',
      version: '1.0.0',
      scripts: {
        test: 'vitest run',
        'test:unit': 'vitest run src/index.ts',
      },
    }, null, 2));

    fs.writeFileSync(path.join(tmp, 'README.md'), `# Ready Repo

See \`src/index.ts\` and \`.ai/manifest.adf\`.

\`\`\`sh
npm test
npm run test:unit
\`\`\`
`);

    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), `# Working Rules

Use \`src/index.ts\` as the main entrypoint.
Review \`.ai/manifest.adf\` before changing architecture.

\`\`\`sh
charter adf evidence --auto-measure
\`\`\`
`);

    fs.writeFileSync(path.join(tmp, '.cursorrules'), `Keep edits small.
Check \`.ai/core.adf\` and \`.ai/state.adf\` before large changes.
`);

    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), `# Agents

Coordinate ownership before parallel changes.
Use \`npm test\` before handing work back.
`);

    fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), `ADF: 0.1
ROLE: Repo context router

DEFAULT_LOAD:
  - core.adf
  - state.adf

ON_DEMAND:
  - backend.adf (Triggers on: API, Node, DB)
`);

    fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), `ADF: 0.1

CONTEXT:
  - Service entrypoint: src/index.ts

CONSTRAINTS [load-bearing]:
  - Run npm test before merge
  - Keep API handlers pure at the edge

METRICS:
  entry_loc: 12 / 200 [lines]
`);

    fs.writeFileSync(path.join(tmp, '.ai', 'state.adf'), `ADF: 0.1
STATE:
  CURRENT: scoring implementation is active
  NEXT: keep docs synchronized
`);

    fs.writeFileSync(path.join(tmp, '.ai', 'backend.adf'), `ADF: 0.1
CONTEXT:
  - API routes live in src/index.ts
`);

    fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), 'export const ready = true;\n');
    fs.writeFileSync(path.join(tmp, '.github', 'workflows', 'ci.yml'), 'name: CI\non: [push]\n');
    fs.writeFileSync(path.join(tmp, '.githooks', 'pre-commit'), '#!/usr/bin/env sh\nnpm test\n');
    fs.writeFileSync(path.join(tmp, '.codex', 'skills', 'review', 'SKILL.md'), '# Review Skill\n');
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({
      permissions: {
        allow: ['Bash(npm test)'],
      },
    }, null, 2));

    const { exitCode, report } = await captureJson(() => scoreCommand(baseOptions, []));

    expect(exitCode).toBe(0);
    expect(report.score.grade).toBe('A');
    expect(report.score.total).toBeGreaterThanOrEqual(95);
    expect(findCategory(report, 'agent-config')?.score).toBe(25);
    expect(findCategory(report, 'architecture')?.score).toBe(20);
    expect(findCategory(report, 'governance')?.score).toBe(10);
    expect(report.recommendations).not.toContainEqual(expect.stringContaining('charter bootstrap --yes'));
  });

  it('is registered in the top-level CLI and scores non-Charter repos without crashing', async () => {
    const tmp = createTempRepo();
    process.chdir(tmp);

    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true });

    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'plain-repo',
      version: '1.0.0',
      scripts: {
        test: 'node --test',
      },
    }, null, 2));

    fs.writeFileSync(path.join(tmp, 'README.md'), `# Plain Repo

Main module: \`src/app.ts\`

\`\`\`sh
npm test
\`\`\`
`);

    fs.writeFileSync(path.join(tmp, 'src', 'app.ts'), 'export const app = 1;\n');
    fs.writeFileSync(path.join(tmp, '.github', 'workflows', 'ci.yml'), 'name: CI\non: [push]\n');

    const { exitCode, report } = await captureJson(() => run(['score', '--format', 'json']));

    expect(exitCode).toBe(0);
    expect(report.score.total).toBeGreaterThan(0);
    expect(report.recommendations.some((item: string) => item.includes('charter bootstrap --yes'))).toBe(true);
    expect(report.recommendations.some((item: string) => item.includes('CLAUDE.md'))).toBe(true);
  });

  it('falls back to mtime freshness and flags stale config relative to code', async () => {
    const tmp = createTempRepo();
    process.chdir(tmp);

    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });

    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'stale-repo',
      version: '1.0.0',
      scripts: {
        test: 'node --test',
      },
    }, null, 2));

    fs.writeFileSync(path.join(tmp, 'README.md'), `# Stale Repo

\`\`\`sh
npm test
\`\`\`
`);
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# Repo Rules\n\nRun `npm test` before merge.\n');
    fs.writeFileSync(path.join(tmp, '.cursorrules'), 'Keep changes localized.\n');
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# Agents\n\nCoordinate work.\n');
    fs.writeFileSync(path.join(tmp, 'src', 'app.ts'), 'export const stale = true;\n');

    const oldDate = new Date(Date.now() - (160 * 24 * 60 * 60 * 1000));
    const newDate = new Date(Date.now() - (2 * 24 * 60 * 60 * 1000));

    for (const file of ['CLAUDE.md', '.cursorrules', 'AGENTS.md']) {
      fs.utimesSync(path.join(tmp, file), oldDate, oldDate);
    }
    fs.utimesSync(path.join(tmp, 'src', 'app.ts'), newDate, newDate);

    const { report } = await captureJson(() => scoreCommand(baseOptions, []));

    expect(report.signals.freshness.strategy).toBe('mtime');
    expect((report.signals.freshness.deltaDays || 0)).toBeGreaterThan(100);
    expect(findCategory(report, 'freshness')?.score).toBeLessThanOrEqual(2);
    expect(report.recommendations.some((item: string) => item.includes('Refresh agent config after recent code changes'))).toBe(true);
  });
});

function createTempRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-score-test-'));
  tempDirs.push(tmp);
  return tmp;
}

async function captureJson(runCommand: () => Promise<number>): Promise<{ exitCode: number; report: any }> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
    logs.push(String(message ?? ''));
  });

  const exitCode = await runCommand();
  return {
    exitCode,
    report: JSON.parse(logs[0]),
  };
}

function findCategory(report: { categories: Array<{ id: string; score: number }> }, id: string): { id: string; score: number } | undefined {
  return report.categories.find((category) => category.id === id);
}

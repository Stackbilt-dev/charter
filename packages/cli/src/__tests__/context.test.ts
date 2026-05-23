import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../index';
import { generateBrief, contextCommand } from '../commands/context';
import cliPkg from '../../package.json';

const options: CLIOptions = {
  configPath: '.charter',
  format: 'text',
  ciMode: false,
  yes: false,
};

// Track original cwd and temp dirs for cleanup
const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-context-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('generateBrief on minimal repo returns all 5 sections', () => {
  it('generates a brief with all required sections', { timeout: 30000 }, async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    // Set up package.json
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'test-worker',
        version: '1.0.0',
        description: 'A test worker',
      }),
      'utf8'
    );

    // Set up .charter/config.json
    fs.mkdirSync(path.join(tmp, '.charter'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.charter', 'config.json'),
      JSON.stringify({ stack: 'worker', preset: 'worker' }),
      'utf8'
    );

    // Set up src/index.ts with a Hono route
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'src', 'index.ts'),
      `import { Hono } from 'hono';\nconst app = new Hono();\napp.get('/api/hello', (c) => c.json({ ok: true }));\nexport default app;\n`,
      'utf8'
    );

    // Set up .ai/manifest.adf with core.adf in DEFAULT_LOAD
    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.ai', 'manifest.adf'),
      `ADF: 0.1\n\nDEFAULT_LOAD:\n  - core.adf\n\nON_DEMAND:\n  - backend.adf (Triggers on: backend, api)\n`,
      'utf8'
    );

    const result = await generateBrief({ configPath: '.charter', aiDir: '.ai' });

    expect(result.markdown).toContain('## Identity');
    expect(result.markdown).toContain('## Surface');
    expect(result.markdown).toContain('## Hotspots');
    expect(result.markdown).toContain('## Sensitivity');
    expect(result.markdown).toContain('## Governance');
  });
});

describe('generateBrief respects token ceiling', () => {
  it('truncates when surface has many routes and keeps tokenCount <= 2000', { timeout: 30000 }, async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'large-surface', version: '1.0.0' }),
      'utf8'
    );
    fs.mkdirSync(path.join(tmp, '.charter'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.charter', 'config.json'),
      JSON.stringify({ stack: 'backend', preset: 'backend' }),
      'utf8'
    );

    // Create many routes with very long paths to guarantee > 8000 chars in surface section
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    const routeLines: string[] = [`import { Hono } from 'hono';`, `const app = new Hono();`];
    // Generate 50 routes with very long paths (each route line ~100 chars in markdown table)
    for (let i = 0; i < 50; i++) {
      const pad = 'a'.repeat(60); // long path padding
      routeLines.push(
        `app.get('/api/${pad}-endpoint-number-${i}/very/deep/nesting/path', (c) => c.json({ id: ${i} }));`
      );
    }
    routeLines.push('export default app;');
    fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), routeLines.join('\n'), 'utf8');

    // Create a large manifest to push Governance section over budget
    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    const manifestLines = ['ADF: 0.1', '', 'DEFAULT_LOAD:', '  - core.adf', '', 'ON_DEMAND:'];
    for (let i = 0; i < 30; i++) {
      // Long trigger lists to add bulk to the ON_DEMAND section
      const triggers = Array.from({ length: 10 }, (_, j) => `feature-${i}-trigger-${j}-keyword`).join(', ');
      manifestLines.push(`  - module-${i}.adf (Triggers on: ${triggers})`);
    }
    fs.writeFileSync(path.join(tmp, '.ai', 'manifest.adf'), manifestLines.join('\n'), 'utf8');

    const result = await generateBrief({ configPath: '.charter', aiDir: '.ai' });

    expect(result.tokenCount).toBeLessThanOrEqual(2000);
    expect(result.truncated).toBe(true);
  });
});

describe('generateBrief reads ADF-driven preset and sensitivity', () => {
  it('uses PRESET from manifest.adf and SENSITIVITY from referenced modules', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'adf-brief', version: '1.0.0' }),
      'utf8'
    );

    fs.mkdirSync(path.join(tmp, '.charter'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.charter', 'config.json'), JSON.stringify({}), 'utf8');

    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.ai', 'manifest.adf'),
      `ADF: 0.1
PRESET: worker

DEFAULT_LOAD:
  - core.adf

ON_DEMAND:
  - backend.adf (Triggers on: api, worker)
`,
      'utf8'
    );

    fs.writeFileSync(path.join(tmp, '.ai', 'core.adf'), `ADF: 0.1\n`, 'utf8');
    fs.writeFileSync(
      path.join(tmp, '.ai', 'backend.adf'),
      `ADF: 0.1
🔒 SENSITIVITY:
  - SECRETS: .env, wrangler.toml
  - EGRESS: src/routes/**
`,
      'utf8'
    );

    const result = await generateBrief({ configPath: '.charter', aiDir: '.ai' });

    expect(result.markdown).toContain('- **Preset**: worker');
    expect(result.markdown).toContain('- **Stack**: worker');
    expect(result.markdown).toContain('- SECRETS: .env, wrangler.toml');
    expect(result.markdown).toContain('- EGRESS: src/routes/**');
  });
});

describe('contextCommand writes .charter/context.md', () => {
  it('writes context.md when --write flag is passed', { timeout: 30000 }, async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'write-test', version: '0.1.0' }),
      'utf8'
    );

    // Silence stdout for the write-only test
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await contextCommand(
      { ...options, configPath: path.join(tmp, '.charter') },
      ['--write']
    );

    expect(exitCode).toBe(0);
    const outPath = path.join(tmp, '.charter', 'context.md');
    expect(fs.existsSync(outPath)).toBe(true);
    const content = fs.readFileSync(outPath, 'utf8');
    expect(content).toContain('## Identity');
  });
});

describe('generateBrief version resolution', () => {
  it('uses CLI package version when repo package.json is a private workspace root', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    // Monorepo workspace root: private: true AND workspaces field present
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'my-monorepo', version: '0.1.0', private: true, workspaces: ['packages/*'] }),
      'utf8'
    );

    const result = await generateBrief({ configPath: '.charter' });

    // Should NOT show the stale workspace version
    expect(result.markdown).not.toContain('v0.1.0');
    // Should show the actual installed CLI version
    expect(result.markdown).toContain(`v${cliPkg.version}`);
  });

  it('keeps the repo version for a private package that is not a workspace root', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    // Internal app: private: true but NO workspaces field — must preserve its own version
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'internal-app', version: '2.4.1', private: true }),
      'utf8'
    );

    const result = await generateBrief({ configPath: '.charter' });

    expect(result.markdown).toContain('v2.4.1');
  });

  it('uses the repo package.json version for normal non-private packages', async () => {
    const tmp = makeTempDir();
    process.chdir(tmp);

    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'my-app', version: '3.7.2' }),
      'utf8'
    );

    const result = await generateBrief({ configPath: '.charter' });

    expect(result.markdown).toContain('v3.7.2');
  });
});

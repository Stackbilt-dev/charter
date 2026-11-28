import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filePathRoutingKeywords, filePathToTokens, relativizeFilePath } from '../commands/adf-path-tokens';
import { adfContextCommand } from '../commands/adf-context';
import type { CLIOptions } from '../index';

// Mirrors this repo's .ai/manifest.adf ON_DEMAND section (#442 routing table).
const CHARTER_MANIFEST = `ADF: 0.1

📦 DEFAULT_LOAD:
  - core.adf
  - state.adf

📂 ON_DEMAND:
  - adf-dev.adf (Triggers on: ADF, parser, formatter, patcher, bundler, metric, weight)
  - governance.adf (Triggers on: validate, drift, audit, trailer, risk, governance)
  - classifier.adf (Triggers on: classifier, routing, auto-route, adf add, classify, rule placement)
  - analysis.adf (Triggers on: blast, surface, dependency graph, blast radius, route extraction, schema extraction)
  - typed-data-access.adf (Triggers on: tenant, user, subscription, quota, credit, mrr, pii, sensitivity, data registry, ontology, disambiguation, DATA_AUTHORITY, raw D1, service boundary, auth_scoped, billing_critical)
`;

// Guard fixture: a repo whose triggers are exactly the generic path words.
const GENERIC_TRIGGER_MANIFEST = `ADF: 0.1

📦 DEFAULT_LOAD:
  - core.adf

📂 ON_DEMAND:
  - layout.adf (Triggers on: packages, src, lib, dist, index, main, build)
  - testing.adf (Triggers on: tests, spec, fixtures, mock)
  - formats.adf (Triggers on: ts, js, json, md, yaml)
`;

let tmpDir: string;
let logs: string[];

// Guard fixture: triggers named after the directories a checkout usually sits
// in, plus the temp dir's own name parts. None may match from an absolute path.
const CHECKOUT_ROOT_MANIFEST = `ADF: 0.1

📦 DEFAULT_LOAD:
  - core.adf

📂 ON_DEMAND:
  - people.adf (Triggers on: user, users, home, projects, documents)
  - machine.adf (Triggers on: appdata, local, temp, tmp, var, folders, private)
  - fixture.adf (Triggers on: charter, path, tokens, checkout)
  - billing.adf (Triggers on: billing, invoice)
`;

function runContext(manifest: string, files: string, repoDir: string = tmpDir): { keywords: string[]; resolvedModules: string[]; triggerMatches: Array<{ module: string; trigger: string; matched: boolean; matchedKeywords: string[] }> } {
  const aiDir = path.join(repoDir, '.ai');
  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'manifest.adf'), manifest);
  const options: CLIOptions = { configPath: path.join(tmpDir, '.charter'), format: 'json', ciMode: false, yes: true };
  logs = [];
  const exit = adfContextCommand(options, ['--files', files, '--ai-dir', aiDir]);
  expect(exit).toBe(0);
  return JSON.parse(logs.join('\n'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-path-tokens-'));
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('filePathToTokens', () => {
  it('splits a path into its own tokens and drops generic segments', () => {
    expect(filePathToTokens(['packages/adf/src/manifest.ts'])).toEqual(['adf', 'manifest']);
  });

  it('splits kebab, snake, dot and camelCase names', () => {
    expect(filePathToTokens(['packages/cli/src/commands/adf-migrate.ts'])).toEqual(['cli', 'commands', 'adf', 'migrate']);
    expect(filePathToTokens(['src/route_extraction/DatePicker.test.tsx'])).toEqual(['route', 'extraction', 'date', 'picker']);
  });

  it('handles Windows separators', () => {
    expect(filePathToTokens(['packages\\blast\\src\\index.ts'])).toEqual(['blast']);
  });

  it('drops generic segments, extensions, test dirs, node_modules and numbers', () => {
    expect(filePathToTokens([
      'packages/lib/src/index.ts',
      'dist/main.js',
      'src/__tests__/fixtures/mock.spec.ts',
      'node_modules/types/index.d.ts',
      'build/v2/out.json',
    ])).toEqual(['types', 'v2']);
  });
});

describe('adf context --files path-token routing (#442)', () => {
  const table: Array<[string, string | null]> = [
    ['packages/adf/src/manifest.ts', 'adf-dev.adf'],
    ['packages/cli/src/commands/adf-migrate.ts', 'adf-dev.adf'],
    ['packages/cli/src/commands/validate.ts', 'governance.adf'],
    ['packages/blast/src/index.ts', 'analysis.adf'],
    ['packages/cli/src/commands/serve.ts', null],
    ['packages/cli/src/commands/context-refresh.ts', null],
    ['.github/workflows/ci.yml', null],
    ['packages/cli/src/commands/tenant-quota.ts', 'typed-data-access.adf'],
  ];

  for (const [file, expected] of table) {
    it(`${file} -> ${expected ?? 'defaults only'}`, () => {
      const out = runContext(CHARTER_MANIFEST, file);
      const onDemand = out.resolvedModules.filter(m => m !== 'core.adf' && m !== 'state.adf');
      expect(out.resolvedModules).toEqual(expect.arrayContaining(['core.adf', 'state.adf']));
      expect(onDemand).toEqual(expected ? [expected] : []);
    });
  }

  it('reports which path token matched which trigger in JSON', () => {
    const out = runContext(CHARTER_MANIFEST, 'packages/adf/src/manifest.ts');
    expect(out.keywords).toEqual(expect.arrayContaining(['adf', 'manifest']));
    const matched = out.triggerMatches.filter(tm => tm.matched);
    expect(matched).toEqual([
      expect.objectContaining({ module: 'adf-dev.adf', trigger: 'ADF', matchedKeywords: ['adf'] }),
    ]);
  });

  it('keeps existing JSON keys', () => {
    const out = runContext(CHARTER_MANIFEST, 'packages/adf/src/manifest.ts');
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['keywords', 'resolvedModules']));
  });

  it('guard: generic path segments never trigger modules', () => {
    const out = runContext(
      GENERIC_TRIGGER_MANIFEST,
      'packages/lib/src/index.ts,dist/main.js,build/index.json,docs/readme.md,config/app.yaml',
    );
    expect(out.resolvedModules).toEqual(['core.adf']);
    expect(out.triggerMatches.filter(tm => tm.matched)).toEqual([]);
  });

  describe('repo under checkout-root directories', () => {
    let repoDir: string;
    beforeEach(() => {
      repoDir = path.join(tmpDir, 'home', 'users', 'projects', 'documents', 'user', 'checkout');
      fs.mkdirSync(repoDir, { recursive: true });
    });

    it('guard: absolute paths do not leak the dirs above the repo', () => {
      const files = [
        path.join(repoDir, 'src', 'index.ts'),
        path.join(repoDir, 'packages', 'core', 'lib', 'main.ts'),
      ].join(',');
      const out = runContext(CHECKOUT_ROOT_MANIFEST, files, repoDir);
      expect(out.resolvedModules).toEqual(['core.adf']);
      expect(out.triggerMatches.filter(tm => tm.matched)).toEqual([]);
      expect(out.keywords).toEqual(['core']);
    });

    it('guard: a path outside the repo contributes no path tokens', () => {
      const outside = path.join(tmpDir, 'home', 'users', 'billing', 'invoice.ts');
      const out = runContext(CHECKOUT_ROOT_MANIFEST, outside, repoDir);
      expect(out.resolvedModules).toEqual(['core.adf']);
      expect(out.keywords).toEqual([]);
    });

    it('still routes from the repo-relative part of an absolute path', () => {
      const files = [
        path.join(repoDir, 'src', 'billing', 'invoice.ts'),
        path.join(repoDir, 'src', 'index.ts'),
      ].join(',');
      const out = runContext(CHECKOUT_ROOT_MANIFEST, files, repoDir);
      expect(out.resolvedModules).toEqual(['core.adf', 'billing.adf']);
      expect(out.triggerMatches.filter(tm => tm.matched).map(tm => tm.module)).toEqual(['billing.adf', 'billing.adf']);
    });
  });
});

describe('relativizeFilePath', () => {
  it('relativizes absolute POSIX paths to the root', () => {
    expect(relativizeFilePath('/home/user/projects/repo/packages/adf/src/manifest.ts', '/home/user/projects/repo'))
      .toBe('packages/adf/src/manifest.ts');
  });

  it('relativizes absolute Windows paths, case-insensitively, with either separator', () => {
    const root = 'C:\\Users\\x\\repo';
    expect(relativizeFilePath('C:\\Users\\x\\repo\\packages\\adf\\src\\manifest.ts', root)).toBe('packages/adf/src/manifest.ts');
    expect(relativizeFilePath('c:/users/X/Repo/packages/adf/src/manifest.ts', root)).toBe('packages/adf/src/manifest.ts');
    expect(relativizeFilePath('C:/Users/x/repo/packages/adf/src/manifest.ts', 'C:/Users/x/repo')).toBe('packages/adf/src/manifest.ts');
  });

  it('returns null for paths outside the root', () => {
    expect(relativizeFilePath('/home/user/other/src/a.ts', '/home/user/repo')).toBeNull();
    expect(relativizeFilePath('D:\\work\\repo\\src\\a.ts', 'C:\\Users\\x\\repo')).toBeNull();
    expect(relativizeFilePath('C:\\Users\\x\\repo-other\\a.ts', 'C:\\Users\\x\\repo')).toBeNull();
    expect(relativizeFilePath('/home/user/repo', '/home/user/repo')).toBeNull();
  });

  it('resolves ./ and ../ against cwd', () => {
    const root = '/home/user/repo';
    expect(relativizeFilePath('./packages/adf/src/manifest.ts', root, root)).toBe('packages/adf/src/manifest.ts');
    expect(relativizeFilePath('src/manifest.ts', root, '/home/user/repo/packages/adf')).toBe('packages/adf/src/manifest.ts');
    expect(relativizeFilePath('../blast/src/index.ts', root, '/home/user/repo/packages/adf')).toBe('packages/blast/src/index.ts');
    expect(relativizeFilePath('../../other/a.ts', root, '/home/user/repo/packages')).toBeNull();
    expect(relativizeFilePath('.\\packages\\adf\\src\\manifest.ts', 'C:\\Users\\x\\repo', 'C:\\Users\\x\\repo')).toBe('packages/adf/src/manifest.ts');
  });

  it('takes relative paths as repo-relative when cwd is outside the root', () => {
    expect(relativizeFilePath('./packages/adf/manifest.ts', '/srv/repo', '/home/user')).toBe('packages/adf/manifest.ts');
    expect(relativizeFilePath('../escape/a.ts', '/srv/repo', '/home/user')).toBeNull();
  });
});

describe('filePathToTokens with a root', () => {
  it('drops checkout-root dirs from absolute POSIX and Windows paths', () => {
    expect(filePathToTokens(['/home/users/projects/repo/packages/adf/src/manifest.ts'], { root: '/home/users/projects/repo' }))
      .toEqual(['adf', 'manifest']);
    expect(filePathToTokens(['C:\\Users\\x\\repo\\packages\\adf\\src\\manifest.ts'], { root: 'C:\\Users\\x\\repo' }))
      .toEqual(['adf', 'manifest']);
  });

  it('handles a mixed set of absolute, relative, dotted and outside paths', () => {
    const root = '/home/users/repo';
    expect(filePathToTokens([
      '/home/users/repo/packages/adf/src/manifest.ts',
      './packages/blast/src/index.ts',
      '../repo/packages/cli/src/commands/validate.ts',
      '/home/users/elsewhere/secret-billing.ts',
      'packages\\classifier\\src\\rules.ts',
    ], { root, cwd: root })).toEqual(['adf', 'manifest', 'blast', 'cli', 'commands', 'validate', 'classifier', 'rules']);
  });
});

// The reviewer's reproduction: a repo that sits under api/, test/ and
// session/ folders, with triggers on the words those folders map to.
const SIGNAL_TRIGGER_MANIFEST = `ADF: 0.1

📦 DEFAULT_LOAD:
  - core.adf

📂 ON_DEMAND:
  - backend.adf (Triggers on: backend, api)
  - qa.adf (Triggers on: qa)
  - sec.adf (Triggers on: security, auth)
`;

describe('directory signals come from the repo-relative path', () => {
  let repoDir: string;
  beforeEach(() => {
    repoDir = path.join(tmpDir, 'api', 'test', 'session', 'repo');
    fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'docs', 'readme.txt'), 'x');
  });

  it('guard: api/test/session dirs above the repo add no signals for an absolute path', () => {
    const out = runContext(SIGNAL_TRIGGER_MANIFEST, path.join(repoDir, 'docs', 'readme.txt'), repoDir);
    expect(out.keywords).toEqual(['docs', 'readme']);
    expect(out.resolvedModules).toEqual(['core.adf']);
  });

  it('gives the same answer for the absolute and the repo-relative spelling', () => {
    const abs = runContext(SIGNAL_TRIGGER_MANIFEST, path.join(repoDir, 'docs', 'readme.txt'), repoDir);
    const rel = runContext(SIGNAL_TRIGGER_MANIFEST, 'docs/readme.txt', repoDir);
    expect(abs.keywords).toEqual(rel.keywords);
    expect(abs.resolvedModules).toEqual(rel.resolvedModules);
  });

  it('guard: a path outside the repo adds no directory signals, only extension ones', () => {
    const outside = path.join(tmpDir, 'api', 'test', 'session', 'Button.tsx');
    const out = runContext(SIGNAL_TRIGGER_MANIFEST, outside, repoDir);
    expect(out.keywords).toEqual(['react', 'ui', 'frontend']);
    expect(out.resolvedModules).toEqual(['core.adf']);
  });

  it('still emits directory signals for dirs inside the repo', () => {
    const out = runContext(SIGNAL_TRIGGER_MANIFEST, path.join(repoDir, 'src', 'api', 'handler.ts'), repoDir);
    expect(out.keywords).toEqual(expect.arrayContaining(['api', 'backend']));
    expect(out.resolvedModules).toEqual(['core.adf', 'backend.adf']);
  });

  it('filePathRoutingKeywords applies the same rule', () => {
    expect(filePathRoutingKeywords(['/srv/api/test/repo/docs/readme.txt'], { root: '/srv/api/test/repo' }))
      .toEqual(['docs', 'readme']);
    expect(filePathRoutingKeywords(['/srv/api/elsewhere.sql'], { root: '/srv/api/test/repo' }))
      .toEqual(['db', 'migration']);
  });
});

describe('symlinked or junctioned checkouts', () => {
  let realRepo: string;
  let linkRepo: string;
  let linked: boolean;
  beforeEach(() => {
    realRepo = path.join(tmpDir, 'real', 'repo');
    linkRepo = path.join(tmpDir, 'link-repo');
    fs.mkdirSync(path.join(realRepo, 'packages', 'adf', 'src'), { recursive: true });
    fs.writeFileSync(path.join(realRepo, 'packages', 'adf', 'src', 'manifest.ts'), 'x');
    try {
      // 'junction' needs no privileges on Windows and is ignored elsewhere.
      fs.symlinkSync(realRepo, linkRepo, 'junction');
      linked = true;
    } catch {
      linked = false;
    }
  });

  it('relativizes a path reached through the link against the real root, and the reverse', (ctx) => {
    if (!linked) ctx.skip();
    const viaLink = path.join(linkRepo, 'packages', 'adf', 'src', 'manifest.ts');
    const viaReal = path.join(realRepo, 'packages', 'adf', 'src', 'manifest.ts');
    expect(relativizeFilePath(viaLink, realRepo)).toBe('packages/adf/src/manifest.ts');
    expect(relativizeFilePath(viaReal, linkRepo)).toBe('packages/adf/src/manifest.ts');
    // A file that does not exist yet still resolves through its existing parent.
    expect(relativizeFilePath(path.join(linkRepo, 'packages', 'adf', 'src', 'new-file.ts'), realRepo))
      .toBe('packages/adf/src/new-file.ts');
  });

  it('routes an absolute real path when the .ai dir is reached through the link', (ctx) => {
    if (!linked) ctx.skip();
    const out = runContext(CHARTER_MANIFEST, path.join(realRepo, 'packages', 'adf', 'src', 'manifest.ts'), linkRepo);
    expect(out.keywords).toEqual(['adf', 'manifest']);
    expect(out.resolvedModules).toContain('adf-dev.adf');
  });
});

describe('repo-relative paths from a subdirectory cwd', () => {
  let repoDir: string;
  let prevCwd: string;
  beforeEach(() => {
    prevCwd = process.cwd();
    repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repoDir, 'packages', 'adf', 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'packages', 'cli', 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'packages', 'adf', 'src', 'manifest.ts'), 'x');
    fs.writeFileSync(path.join(repoDir, 'packages', 'cli', 'src', 'local.ts'), 'x');
    fs.mkdirSync(path.join(repoDir, '.ai'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.ai', 'manifest.adf'), CHARTER_MANIFEST);
    process.chdir(path.join(repoDir, 'packages', 'cli'));
  });
  afterEach(() => {
    process.chdir(prevCwd);
  });

  function runFromCli(files: string): { keywords: string[]; resolvedModules: string[] } {
    const options: CLIOptions = { configPath: path.join(tmpDir, '.charter'), format: 'json', ciMode: false, yes: true };
    logs = [];
    expect(adfContextCommand(options, ['--files', files, '--ai-dir', path.join('..', '..', '.ai')])).toBe(0);
    return JSON.parse(logs.join('\n'));
  }

  it('reads a path that only exists under the repo root as repo-relative (no cwd segments)', () => {
    const out = runFromCli('packages/adf/src/manifest.ts');
    expect(out.keywords).toEqual(['adf', 'manifest']);
    expect(out.resolvedModules).toContain('adf-dev.adf');
  });

  it('keeps cwd-relative resolution when the file exists under the cwd', () => {
    const out = runFromCli('src/local.ts');
    expect(out.keywords).toEqual(['cli', 'local']);
  });
});

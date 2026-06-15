#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirs = [
  'packages/types',
  'packages/core',
  'packages/adf',
  'packages/git',
  'packages/classify',
  'packages/validate',
  'packages/drift',
  'packages/blast',
  'packages/surface',
  'packages/policies',
  'packages/ci',
  'packages/cli',
  'packages/scaffold-core',
];
const tempDir = mkdtempSync(join(tmpdir(), 'charter-install-smoke-'));

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed in ${options.cwd}`,
      combined.trim(),
    ].filter(Boolean).join('\n'));
  }
  if (/\bERESOLVE\b|unmet peer|peer dep missing|Conflicting peer dependency/i.test(combined)) {
    throw new Error([
      `${command} ${args.join(' ')} reported dependency resolution noise in ${options.cwd}`,
      combined.trim(),
    ].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

function packPackage(packageDir) {
  const cwd = join(root, packageDir);
  const output = run('pnpm', ['pack', '--json', '--pack-destination', tempDir], { cwd });
  const parsed = JSON.parse(output);
  if (typeof parsed.filename === 'string') {
    return parsed.filename;
  }
  const tarballs = readdirSync(tempDir).filter((file) => file.endsWith('.tgz'));
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  const expectedPrefix = manifest.name.replace('@', '').replace('/', '-');
  const match = tarballs.find((file) => file.startsWith(expectedPrefix));
  if (!match) throw new Error(`Could not find packed tarball for ${manifest.name}`);
  return join(tempDir, match);
}

try {
  const tarballs = packageDirs.map(packPackage);

  const npmProject = join(tempDir, 'npm-project');
  mkdirSync(npmProject, { recursive: true });
  writeFileSync(join(npmProject, 'package.json'), '{"name":"charter-install-smoke-npm","version":"1.0.0"}\n');
  run('npm', ['install', '--ignore-scripts', ...tarballs], { cwd: npmProject });
  run('npm', ['audit', '--audit-level', 'moderate'], { cwd: npmProject });

  const pnpmProject = join(tempDir, 'pnpm-project');
  mkdirSync(pnpmProject, { recursive: true });
  writeFileSync(join(pnpmProject, 'package.json'), '{"name":"charter-install-smoke-pnpm","version":"1.0.0"}\n');
  run('pnpm', ['add', '--ignore-scripts', ...tarballs], { cwd: pnpmProject });

  console.log('Install smoke passed for npm and pnpm consumers.');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

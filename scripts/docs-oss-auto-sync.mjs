import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const result = {
    configPath: '.docsync.oss.json',
    remote: 'origin',
    message: 'docs(oss): sync charter ecosystem content',
    push: true,
    dryRun: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      result.configPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--remote') {
      result.remote = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--message') {
      result.message = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--no-push') {
      result.push = false;
      continue;
    }
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
  }

  if (!result.configPath) {
    throw new Error('Missing --config value');
  }

  return result;
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    const stderr = res.stderr?.trim();
    const stdout = res.stdout?.trim();
    throw new Error(`${cmd} ${args.join(' ')} failed${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ''}`);
  }
  return (res.stdout ?? '').trim();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceRepoRoot = process.cwd();
  const configPath = path.resolve(sourceRepoRoot, options.configPath);
  const configRaw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(configRaw);
  const configDir = path.dirname(configPath);
  const targetRoot = path.resolve(configDir, config.target?.root ?? '.');

  console.log(`[docs:oss:auto] sync using ${configPath}`);
  run('node', ['scripts/docs-sync.mjs', '--write', '--config', configPath], sourceRepoRoot);

  const docsGitRoot = run('git', ['-C', targetRoot, 'rev-parse', '--show-toplevel'], sourceRepoRoot);
  const docsBranch = run('git', ['-C', docsGitRoot, 'branch', '--show-current'], sourceRepoRoot);
  if (!docsBranch) {
    throw new Error('Could not detect docs branch (detached HEAD?)');
  }

  const changedPaths = Array.from(new Set(config.mappings.map((mapping) => {
    const abs = path.resolve(targetRoot, mapping.targetFile);
    return path.relative(docsGitRoot, abs).replace(/\\/g, '/');
  })));

  if (changedPaths.length === 0) {
    console.log('[docs:oss:auto] no mapped files configured');
    return;
  }

  const statusOutput = run(
    'git',
    ['-C', docsGitRoot, 'status', '--porcelain', '--', ...changedPaths],
    sourceRepoRoot
  );

  if (!statusOutput) {
    console.log('[docs:oss:auto] no mapped file changes to commit');
    return;
  }

  console.log('[docs:oss:auto] changed files:');
  for (const line of statusOutput.split('\n')) {
    console.log(`  ${line}`);
  }

  if (options.dryRun) {
    console.log('[docs:oss:auto] dry-run mode: skipping commit/push');
    return;
  }

  run('git', ['-C', docsGitRoot, 'add', '--', ...changedPaths], sourceRepoRoot);
  run('git', ['-C', docsGitRoot, 'commit', '-m', options.message], sourceRepoRoot);
  console.log(`[docs:oss:auto] committed on ${docsBranch}`);

  if (!options.push) {
    console.log('[docs:oss:auto] push skipped (--no-push)');
    return;
  }

  run('git', ['-C', docsGitRoot, 'push', options.remote, docsBranch], sourceRepoRoot);
  console.log(`[docs:oss:auto] pushed to ${options.remote}/${docsBranch}`);
}

main().catch((error) => {
  console.error(`[docs:oss:auto] ${error.message}`);
  process.exit(1);
});

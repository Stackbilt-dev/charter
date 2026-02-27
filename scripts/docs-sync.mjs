import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const CHECK_MODE = process.argv.includes('--check');
const WRITE_MODE = process.argv.includes('--write');
const CONFIG_FLAG_INDEX = process.argv.indexOf('--config');
const CONFIG_ARG = CONFIG_FLAG_INDEX >= 0 ? process.argv[CONFIG_FLAG_INDEX + 1] : null;

if (CONFIG_FLAG_INDEX >= 0 && (!CONFIG_ARG || CONFIG_ARG.startsWith('--'))) {
  console.error('docs-sync: missing value for --config');
  process.exit(2);
}

if (!CHECK_MODE && !WRITE_MODE) {
  console.error('Usage: node scripts/docs-sync.mjs --check|--write [--config <path>]');
  process.exit(2);
}

const cwd = process.cwd();
const configPath = CONFIG_ARG ? path.resolve(cwd, CONFIG_ARG) : path.join(cwd, '.docsync.json');

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function toEol(text, eol) {
  return text.replace(/\r?\n/g, eol);
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function blockMarkers(blockId) {
  return {
    start: `<!-- DOCSYNC:BEGIN:${blockId} -->`,
    end: `<!-- DOCSYNC:END:${blockId} -->`
  };
}

function mappingMode(mapping) {
  return mapping.targetMode === 'file' ? 'file' : 'block';
}

async function loadSnippet(source, snippetFile) {
  const localPath = path.resolve(source.localRoot, snippetFile);
  try {
    return await fs.readFile(localPath, 'utf8');
  } catch {
    if (!source.remoteBaseUrl) {
      throw new Error(`Snippet missing locally and no remoteBaseUrl configured: ${snippetFile}`);
    }
  }

  const url = `${source.remoteBaseUrl.replace(/\/+$/, '')}/${snippetFile}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch snippet ${snippetFile} from ${url}: HTTP ${res.status}`);
  }
  return await res.text();
}

async function main() {
  const config = await readJson(configPath);
  const configDir = path.dirname(configPath);
  const sourceRoot = path.resolve(configDir, config.source.localRoot);
  const targetRoot = path.resolve(configDir, config.target?.root ?? '.');
  const failures = [];
  const updates = [];

  for (const mapping of config.mappings) {
    const targetPath = path.resolve(targetRoot, mapping.targetFile);
    const targetRaw = await fs.readFile(targetPath, 'utf8');
    const eol = detectEol(targetRaw);
    const snippetRaw = await loadSnippet({ ...config.source, localRoot: sourceRoot }, mapping.snippetFile);
    const snippet = toEol(snippetRaw.trimEnd(), eol);
    const mode = mappingMode(mapping);

    if (mode === 'file') {
      const desiredFile = `${snippet}${eol}`;
      if (targetRaw !== desiredFile) {
        updates.push({ mapping, targetPath });
        if (WRITE_MODE) {
          await fs.writeFile(targetPath, desiredFile, 'utf8');
        } else {
          failures.push(`${mapping.targetFile}: file drift detected`);
        }
      }
      continue;
    }

    if (!mapping.blockId) {
      failures.push(`${mapping.targetFile}: blockId is required for block mappings`);
      continue;
    }

    const { start, end } = blockMarkers(mapping.blockId);
    const startIdx = targetRaw.indexOf(start);
    if (startIdx === -1) {
      failures.push(`${mapping.targetFile}: missing start marker for ${mapping.blockId}`);
      continue;
    }

    const endIdx = targetRaw.indexOf(end, startIdx + start.length);
    if (endIdx === -1) {
      failures.push(`${mapping.targetFile}: missing end marker for ${mapping.blockId}`);
      continue;
    }

    if (targetRaw.indexOf(start, startIdx + start.length) !== -1) {
      failures.push(`${mapping.targetFile}: duplicate start marker for ${mapping.blockId}`);
      continue;
    }

    const blockStart = startIdx;
    const blockEnd = endIdx + end.length;
    const desiredBlock = `${start}${eol}${snippet}${eol}${end}`;
    const existingBlock = targetRaw.slice(blockStart, blockEnd);

    if (existingBlock !== desiredBlock) {
      updates.push({ mapping, targetPath });
      if (WRITE_MODE) {
        const nextRaw = `${targetRaw.slice(0, blockStart)}${desiredBlock}${targetRaw.slice(blockEnd)}`;
        await fs.writeFile(targetPath, nextRaw, 'utf8');
      } else {
        failures.push(`${mapping.targetFile}: drift detected for ${mapping.blockId}`);
      }
    }
  }

  if (WRITE_MODE) {
    if (updates.length === 0) {
      console.log('docs-sync: no updates needed');
    } else {
      console.log(`docs-sync: updated ${updates.length} block(s)`);
      for (const update of updates) {
        console.log(`- ${update.mapping.targetFile} :: ${update.mapping.blockId}`);
      }
    }
    if (failures.length > 0) {
      console.error('docs-sync: errors found');
      for (const failure of failures) {
        console.error(`- ${failure}`);
      }
      process.exit(1);
    }
    return;
  }

  if (failures.length > 0) {
    console.error('docs-sync check failed');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log('docs-sync check passed');
}

main().catch((error) => {
  console.error(`docs-sync fatal: ${error.message}`);
  process.exit(1);
});

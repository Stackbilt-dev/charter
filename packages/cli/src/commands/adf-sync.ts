/**
 * charter adf sync
 *
 * Hash-based sync verification for ADF source files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { parseAdf, parseManifest } from '@stackbilt/adf';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';

interface SyncStatus {
  source: string;
  target: string;
  sourceHash: string;
  lockedHash: string | null;
  inSync: boolean;
}

interface AdfSyncResult {
  aiDir: string;
  lockFile: string;
  entries: SyncStatus[];
  allInSync: boolean;
  written: boolean;
}

export function adfSync(options: CLIOptions, args: string[]): number {
  // --explain: output lockfile schema documentation and exit
  if (args.includes('--explain')) {
    const explanation = {
      format: '.adf.lock',
      description: 'Flat JSON map of ADF source files to SHA-256 hash prefixes (16 hex chars)',
      schema: {
        type: 'object',
        pattern: '{ "<filename>.adf": "<sha256-prefix-16>" }',
        example: {
          'core.adf': '54d5c9a146d6da3c',
          'state.adf': 'a1b2c3d4e5f67890',
        },
      },
      hashAlgorithm: 'SHA-256, first 16 hex characters',
      commands: {
        check: 'charter adf sync --check \u2014 verify sources match locked hashes',
        write: 'charter adf sync --write \u2014 update lock with current hashes',
      },
      location: '.ai/.adf.lock (relative to AI directory)',
      purpose: 'Detect when ADF source files have changed since last sync. Used in CI to enforce governance drift checks.',
    };

    if (options.format === 'json') {
      console.log(JSON.stringify(explanation, null, 2));
    } else {
      console.log('ADF Sync Lock Format (.adf.lock)');
      console.log('================================\n');
      console.log('Format: Flat JSON map of source files to hash prefixes\n');
      console.log('Schema: { "<filename>.adf": "<sha256-prefix-16>" }\n');
      console.log('Hash: SHA-256, first 16 hex characters\n');
      console.log('Location: .ai/.adf.lock\n');
      console.log('Commands:');
      console.log('  sync --check  Verify sources match locked hashes');
      console.log('  sync --write  Update lock with current hashes');
      console.log('  sync --explain  Show this schema documentation\n');
      console.log('Purpose: Detect ADF source drift. Used in CI governance checks.');
    }
    return EXIT_CODE.SUCCESS;
  }

  const aiDir = getFlag(args, '--ai-dir') || '.ai';
  const checkMode = args.includes('--check');
  const writeMode = args.includes('--write');

  if (!checkMode && !writeMode) {
    throw new CLIError('adf sync requires --check, --write, or --explain. Usage: charter adf sync --check');
  }

  const manifestPath = path.join(aiDir, 'manifest.adf');
  if (!fs.existsSync(manifestPath)) {
    throw new CLIError(`manifest.adf not found at ${manifestPath}. Run: charter adf init`);
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  const manifestDoc = parseAdf(manifestContent);
  const manifest = parseManifest(manifestDoc);

  if (manifest.sync.length === 0) {
    const lockFile = path.join(aiDir, '.adf.lock');
    let written = false;
    if (writeMode) {
      fs.writeFileSync(lockFile, '{}\n');
      written = true;
    }
    const result: AdfSyncResult = {
      aiDir,
      lockFile,
      entries: [],
      allInSync: true,
      written,
    };
    if (options.format === 'json') {
      console.log(JSON.stringify({
        ...result,
        trackedSources: 0,
        note: 'No SYNC entries declared in manifest; lock tracks only manifest SYNC sources.',
      }, null, 2));
    } else {
      if (writeMode) {
        console.log(`  [ok] Wrote empty lock file at ${lockFile} (no SYNC entries declared).`);
      } else {
        console.log('  No SYNC entries in manifest. Nothing to check.');
        console.log('  SYNC only tracks manifest entries in the SYNC section.');
      }
    }
    return EXIT_CODE.SUCCESS;
  }

  const lockFile = path.join(aiDir, '.adf.lock');
  const locked = loadLockFile(lockFile);

  const entries: SyncStatus[] = [];
  for (const entry of manifest.sync) {
    const sourcePath = path.join(aiDir, entry.source);
    if (!fs.existsSync(sourcePath)) {
      throw new CLIError(`Sync source not found: ${sourcePath}`);
    }
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
    const sourceHash = hashContent(sourceContent);
    const lockedHash = locked[entry.source] ?? null;

    entries.push({
      source: entry.source,
      target: entry.target,
      sourceHash,
      lockedHash,
      inSync: lockedHash === sourceHash,
    });
  }

  const allInSync = entries.every(e => e.inSync);

  if (writeMode) {
    const newLock: Record<string, string> = {};
    for (const e of entries) {
      newLock[e.source] = e.sourceHash;
    }
    fs.writeFileSync(lockFile, JSON.stringify(newLock, null, 2) + '\n');

    const result: AdfSyncResult = {
      aiDir,
      lockFile,
      entries,
      allInSync: true,
      written: true,
    };
    if (options.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`  [ok] Updated ${lockFile} with ${entries.length} hash${entries.length === 1 ? '' : 'es'}.`);
    }
    return EXIT_CODE.SUCCESS;
  }

  // --check mode
  const result: AdfSyncResult = {
    aiDir,
    lockFile,
    entries,
    allInSync,
    written: false,
  };

  if (options.format === 'json') {
    const syncOut: Record<string, unknown> = { ...result };
    if (!allInSync) {
      syncOut.nextActions = ['Regenerate targets from source .adf files', 'charter adf sync --write'];
    }
    console.log(JSON.stringify(syncOut, null, 2));
  } else {
    for (const e of entries) {
      if (e.inSync) {
        console.log(`  [ok] ${e.source} -> ${e.target} (in sync)`);
      } else if (e.lockedHash === null) {
        console.log(`  [warn] ${e.source} -> ${e.target} (no lock entry — run: charter adf sync --write)`);
      } else {
        console.log(`  [fail] ${e.source} -> ${e.target} (source changed since last sync)`);
      }
    }
    if (!allInSync) {
      console.log('');
      console.log('  Source .adf files have changed. Regenerate targets and run: charter adf sync --write');
    }
  }

  return allInSync ? EXIT_CODE.SUCCESS : EXIT_CODE.POLICY_VIOLATION;
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function loadLockFile(lockFile: string): Record<string, string> {
  if (!fs.existsSync(lockFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
  } catch {
    return {};
  }
}


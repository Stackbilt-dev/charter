/**
 * charter login — API key management for Stackbilt Engine.
 *
 * DEPRECATED: on-disk credential storage moves out of this OSS package in 1.0.
 * Set STACKBILT_API_KEY in the environment instead.
 *
 * Usage:
 *   charter login --key sb_live_xxx   Store API key (deprecated)
 *   charter login --logout            Clear stored credentials
 */

import type { CLIOptions } from '../index';
import { EXIT_CODE, CLIError } from '../index';
import { getFlag } from '../flags';
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  API_KEY_ENV_VAR,
} from '../credentials';
import { EngineClient } from '../http-client';

function printDeprecationNotice(): void {
  process.stderr.write(
    `[deprecated] 'charter login' will be removed in 1.0. ` +
      `Set ${API_KEY_ENV_VAR} in the environment instead.\n`,
  );
}

export async function loginCommand(options: CLIOptions, args: string[]): Promise<number> {
  if (args.includes('--logout')) {
    printDeprecationNotice();
    clearCredentials();
    console.log('Credentials cleared.');
    return EXIT_CODE.SUCCESS;
  }

  const key = getFlag(args, '--key');
  if (!key) {
    printDeprecationNotice();
    const existing = loadCredentials();
    const envKey = process.env[API_KEY_ENV_VAR];
    if (envKey && envKey.trim().length > 0) {
      const masked = envKey.slice(0, 12) + '...' + envKey.slice(-4);
      console.log(`Using ${API_KEY_ENV_VAR} from environment: ${masked}`);
      return EXIT_CODE.SUCCESS;
    }
    if (existing) {
      const masked = existing.apiKey.slice(0, 12) + '...' + existing.apiKey.slice(-4);
      console.log(`Logged in as: ${masked}`);
      if (existing.baseUrl) console.log(`Engine: ${existing.baseUrl}`);
    } else {
      console.log('Not logged in.');
      console.log('');
      console.log(`Preferred: export ${API_KEY_ENV_VAR}=ea_xxx (or sb_live_xxx, sb_test_xxx).`);
      console.log('');
      console.log('Deprecated alternative:');
      console.log('  charter login --key ea_xxx');
      console.log('  charter login --key sb_live_xxx');
      console.log('  charter login --key sb_test_xxx');
      console.log('');
      console.log('Get your API key from auth.stackbilt.dev (ea_) or the Stackbilt dashboard (sb_).');
    }
    return EXIT_CODE.SUCCESS;
  }

  printDeprecationNotice();

  const VALID_PREFIXES = ['ea_', 'sb_live_', 'sb_test_'];
  if (!VALID_PREFIXES.some((p) => key.startsWith(p))) {
    throw new CLIError(
      `Invalid API key format. Keys must start with one of: ${VALID_PREFIXES.join(', ')}.`
    );
  }

  const baseUrl = getFlag(args, '--url');

  // Verify connectivity
  const client = new EngineClient({ baseUrl, apiKey: key });
  try {
    const health = await client.health();
    saveCredentials({ apiKey: key, baseUrl });

    if (options.format === 'json') {
      console.log(JSON.stringify({ status: 'authenticated', engine: health.version, catalog: health.catalog }));
    } else {
      console.log(`Authenticated. Engine v${health.version} (${health.catalog} primitives)`);
      if (key.startsWith('sb_test_')) {
        console.log('Using test mode.');
      }
    }
    return EXIT_CODE.SUCCESS;
  } catch (err) {
    throw new CLIError(`Could not reach engine: ${(err as Error).message}`);
  }
}

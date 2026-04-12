/**
 * charter login — API key management for Stackbilt Engine.
 *
 * Usage:
 *   charter login --key sb_live_xxx   Store API key
 *   charter login --logout            Clear stored credentials
 */

import type { CLIOptions } from '../index';
import { EXIT_CODE, CLIError } from '../index';
import { getFlag } from '../flags';
import { loadCredentials, saveCredentials, clearCredentials } from '../credentials';
import { EngineClient } from '../http-client';

export async function loginCommand(options: CLIOptions, args: string[]): Promise<number> {
  if (args.includes('--logout')) {
    clearCredentials();
    console.log('Credentials cleared.');
    return EXIT_CODE.SUCCESS;
  }

  const key = getFlag(args, '--key');
  if (!key) {
    const existing = loadCredentials();
    if (existing) {
      const masked = existing.apiKey.slice(0, 12) + '...' + existing.apiKey.slice(-4);
      console.log(`Logged in as: ${masked}`);
      if (existing.baseUrl) console.log(`Engine: ${existing.baseUrl}`);
    } else {
      console.log('Not logged in.');
      console.log('');
      console.log('Usage: charter login --key ea_xxx');
      console.log('       charter login --key sb_live_xxx');
      console.log('       charter login --key sb_test_xxx');
      console.log('');
      console.log('Get your API key from auth.stackbilt.dev (ea_) or the Stackbilt dashboard (sb_).');
    }
    return EXIT_CODE.SUCCESS;
  }

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

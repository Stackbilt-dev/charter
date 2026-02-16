#!/usr/bin/env node

/**
 * charter CLI entrypoint
 */

import { CLIError, EXIT_CODE, run } from './index';

run(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((err: unknown) => {
    if (err instanceof CLIError) {
      console.error(`charter: ${err.message}`);
      process.exitCode = err.exitCode;
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    console.error(`charter: ${msg}`);
    process.exitCode = EXIT_CODE.RUNTIME_ERROR;
  });

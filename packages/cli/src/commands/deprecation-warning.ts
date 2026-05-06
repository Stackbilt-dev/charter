const RFC_112_URL = 'https://github.com/Stackbilt-dev/charter/issues/112';
export const DEPRECATION_WARNING_ENV_VAR = 'CHARTER_NO_DEPRECATION_WARNING';
export const DEPRECATION_WARNING_FLAG = '--no-deprecation-warning';

function warningSuppressed(args: string[]): boolean {
  return args.includes(DEPRECATION_WARNING_FLAG) || process.env[DEPRECATION_WARNING_ENV_VAR] === '1';
}

export function printBuildCommandDeprecationWarning(command: string, args: string[]): void {
  if (warningSuppressed(args)) {
    return;
  }

  process.stderr.write(
    `⚠ charter ${command} is deprecated and will be removed in Charter 1.0.\n` +
      '  Install @stackbilt/build for the long-term home of this command:\n' +
      '    npm install -g @stackbilt/build\n' +
      `  See ${RFC_112_URL} for context.\n`,
  );
}

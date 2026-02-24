/**
 * ADF error types.
 *
 * Structured errors for parse, patch, and bundle failures.
 */

export class AdfParseError extends Error {
  public readonly line: number | undefined;

  constructor(message: string, line?: number) {
    super(line !== undefined ? `Parse error at line ${line}: ${message}` : `Parse error: ${message}`);
    this.name = 'AdfParseError';
    this.line = line;
  }
}

export class AdfPatchError extends Error {
  public readonly opName: string;
  public readonly section: string | undefined;
  public readonly index: number | undefined;

  constructor(message: string, opName: string, section?: string, index?: number) {
    super(`Patch error [${opName}]: ${message}`);
    this.name = 'AdfPatchError';
    this.opName = opName;
    this.section = section;
    this.index = index;
  }
}

export class AdfBundleError extends Error {
  public readonly modulePath: string | undefined;

  constructor(message: string, modulePath?: string) {
    super(modulePath ? `Bundle error (${modulePath}): ${message}` : `Bundle error: ${message}`);
    this.name = 'AdfBundleError';
    this.modulePath = modulePath;
  }
}

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// Resolve the actual MCP dependency graph: a hoisted development copy must not
// hide an unpatched runtime copy used by the server.
const cliRequire = createRequire(path.resolve(__dirname, '../../package.json'));
const sdkRequire = createRequire(cliRequire.resolve('@modelcontextprotocol/sdk/server/index.js'));
const ajvRequire = createRequire(sdkRequire.resolve('ajv'));
const expressRequire = createRequire(sdkRequire.resolve('express'));
const uri = ajvRequire('fast-uri') as {
  parse(value: string): { scheme?: string; error?: string };
  equal(left: string, right: string): boolean;
};
const qs = expressRequire('qs') as {
  stringify(value: unknown, options: { arrayFormat: string; encodeValuesOnly?: boolean }): string;
};

describe('MCP runtime dependency security regressions', () => {
  // https://github.com/advisories/GHSA-w74x-v6f9-j3xg
  it.each(['%6Aavascript:alert(1)', '%u006Aavascript:alert(1)'])(
    'does not decode an encoded scheme into an executable URL: %s',
    (input) => {
      const parsed = uri.parse(input);
      expect(parsed.scheme).not.toBe('javascript');
      expect(parsed.error).toBeDefined();
      expect(uri.parse('https://example.com').scheme).toBe('https');
      expect(uri.equal('%68ttp://example.com/', 'http://example.com/')).toBe(false);
    },
  );

  // https://github.com/advisories/GHSA-6pq8-jhm2-2vcw
  it.each([false, true])('serializes hostile comma-array elements without throwing (encodeValuesOnly=%s)', (encodeValuesOnly) => {
    const options = { arrayFormat: 'comma', encodeValuesOnly };
    const hostile = JSON.parse('{"items":[{"toString":"not callable"}]}');
    expect(() => qs.stringify(hostile, options)).not.toThrow();
    expect(qs.stringify({ items: ['one', 'two'] }, options)).toBe(encodeValuesOnly ? 'items=one,two' : 'items=one%2Ctwo');
  });
});

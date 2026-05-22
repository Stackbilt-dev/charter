---
title: "Agent DX Feedback: charter serve hangs indefinitely on startup errors"
feedback-id: ADX-008
date: 2026-05-22
source: "Claude Code dogfooding v0.15.1 release validation"
severity: high
bucket: reliability-trust
status: new
related: []
tracked-issues: [157]
tracked-prs: []
---

# Agent DX Feedback: charter serve hangs indefinitely on startup errors

## Observation

When `charter serve` is invoked with a missing or invalid `--ai-dir`, the process hangs indefinitely instead of exiting with an error.

```
$ charter serve --ai-dir /tmp/nonexistent
# (hangs, no output, no exit — must be killed)
```

The error-guard code in `serve.ts` correctly detects the missing directory, writes a JSON-RPC error to stdout, and throws `CLIError`. However, the process never exits. Tested with:
- `charter serve --ai-dir /tmp/nonexistent` (missing path)
- `node packages/cli/dist/bin.js serve --ai-dir /tmp/nonexistent` (local binary)
- Direct `require()` of `packages/cli/dist/commands/serve.js` followed by `process.exit(0)` — also hangs

Root confirmation: importing `@modelcontextprotocol/sdk/server/stdio.js` alone (no commands run) is sufficient to keep the process alive past `process.exit()`.

## Root Cause

`serve.ts` imports `StdioServerTransport` at the top of the file:

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
```

The MCP SDK's `StdioServerTransport` puts `process.stdin` into flowing/raw mode and attaches event listeners at **module load time** (i.e., at `require()` / `import`). This registers stdin as an active handle in Node's event loop, preventing the process from exiting naturally.

Because `serve.ts` is imported unconditionally by `index.ts` (it's in the command switch), every `charter` invocation loads the MCP SDK and hooks stdin — not just `charter serve`. The error guards in `serveCommand()` fire correctly and throw, but the stdin handle outlives the thrown error and the process cannot exit.

## Impact

- **Agents (high impact)**: Claude Code and any agent that runs `charter serve` for validation or health-checks will hang on startup errors. The only recovery is a timeout or SIGKILL.
- **Humans (medium impact)**: A developer running `charter serve` in a repo without `.ai/` initialized will get a hung terminal. No error message is visible (stdout JSON-RPC message is buffered/flushed but stdin keeps process alive).
- **Reliability**: The v0.15.1 release notes say serve startup errors are "discriminated" — they are detected correctly, but the process still cannot exit.

## Recommended Charter Improvements

### P0: Lazy-import StdioServerTransport inside serveCommand()

Replace the top-level import with a dynamic import inside `serveCommand()`, after all path/manifest guards have passed:

```ts
// serve.ts — before connecting
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const stdioTransport = new StdioServerTransport();
await server.connect(stdioTransport);
```

This way stdin is only touched on the happy path. All existing error-guard throws will exit cleanly because stdin was never acquired.

### P1: Add a serve-startup integration test that asserts non-zero exit on bad path

The current test suite (476 tests pass) does not catch this regression. A test that spawns `charter serve --ai-dir /tmp/nonexistent` as a child process and asserts it exits within 1 second with a non-zero code would have caught it:

```ts
const cp = spawnSync('node', ['dist/bin.js', 'serve', '--ai-dir', '/tmp/nonexistent'], { timeout: 2000 });
expect(cp.status).not.toBe(null); // null = timed out
expect(cp.status).not.toBe(0);
```

### P2: Move serve.ts imports to an isolated sub-module

Consider splitting `serve.ts` into `serve-core.ts` (path/manifest helpers, no MCP SDK) and `serve-mcp.ts` (MCP wiring). This makes the startup-guard path importable in tests without pulling in the SDK.

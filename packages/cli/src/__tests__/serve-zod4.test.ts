import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('MCP SDK with Zod 4 (#310)', () => {
  it('advertises record schemas and validates tool inputs over stdio', { timeout: 30000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-zod4-mcp-'));
    const aiDir = path.join(dir, '.ai');
    fs.mkdirSync(aiDir);
    fs.writeFileSync(path.join(aiDir, 'manifest.adf'), 'ADF: 0.1\n\nDEFAULT_LOAD:\n  - core.adf\n');
    fs.writeFileSync(path.join(aiDir, 'core.adf'), 'ADF: 0.1\n\nTASK: Test project\n');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const example = 1;\n');
    const client = new Client({ name: 'charter-zod4-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(__dirname, '../../dist/bin.js'), 'serve', '--ai-dir', aiDir, '--format', 'json'],
      cwd: dir,
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const blast = tools.tools.find(tool => tool.name === 'charter_blast');
      expect(blast?.inputSchema.properties?.aliases).toMatchObject({
        type: 'object', additionalProperties: { type: 'string' },
      });
      const valid = await client.callTool({
        name: 'charter_blast', arguments: { seeds: [path.join(dir, 'a.ts')], root: dir, aliases: { '@/': 'src/' } },
      });
      expect(valid.isError).not.toBe(true);
      expect(valid.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('"seedCount": 1') })]);
      const invalid = await client.callTool({
        name: 'charter_blast', arguments: { seeds: ['a.ts'], aliases: { '@/': 42 } },
      });
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close();
      await transport.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect, vi } from 'vitest';
import { classifyCommand } from '../commands/classify';
import type { CLIOptions } from '../index';

const baseOptions: CLIOptions = {
  configPath: '.charter',
  format: 'text',
  ciMode: false,
  yes: false,
};

describe('classifyCommand', () => {
  it('returns 0 (SUCCESS) for valid subject', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await classifyCommand(baseOptions, ['fix', 'button', 'color']);
    expect(exitCode).toBe(0);
    vi.restoreAllMocks();
  });

  it('throws CLIError when no subject provided', async () => {
    await expect(classifyCommand(baseOptions, [])).rejects.toThrow('Usage:');
  });

  it('outputs valid JSON in json format', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    await classifyCommand({ ...baseOptions, format: 'json' }, ['OAuth', 'integration']);

    const output = JSON.parse(logs[0]);
    expect(output).toHaveProperty('suggestedClass');
    expect(output).toHaveProperty('confidence');
    expect(output).toHaveProperty('signals');
    expect(output).toHaveProperty('recommendation');

    vi.restoreAllMocks();
  });

  it('filters out flag arguments from subject', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    await classifyCommand({ ...baseOptions, format: 'json' }, ['--format', 'json', 'readme', 'update']);

    const output = JSON.parse(logs[0]);
    expect(output.suggestedClass).toBe('SURFACE');

    vi.restoreAllMocks();
  });
});

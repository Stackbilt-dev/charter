/**
 * Integration tests: `charter doctor` adf required wiring names its fix (#241).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIOptions } from '../../index';
import { doctorCommand } from '../../commands/doctor';

const originalCwd = process.cwd();
const tempDirs: string[] = [];
const options: CLIOptions = { configPath: '.charter', format: 'json', ciMode: false, yes: false };

interface DoctorOutput {
  checks: Array<{ name: string; status: string; details: string }>;
}

async function wiringCheck(manifest: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-doctor-wiring-'));
  tempDirs.push(tmp);
  process.chdir(tmp);
  fs.mkdirSync('.ai');
  fs.writeFileSync(path.join('.ai', 'manifest.adf'), manifest);
  fs.writeFileSync(path.join('.ai', 'core.adf'), 'ADF: 0.1\n\n📐 RULES:\n  - Example\n');
  fs.writeFileSync(path.join('.ai', 'state.adf'), 'ADF: 0.1\n\n📋 STATE:\n  - CURRENT: test\n');

  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.map(String).join(' ')));
  await doctorCommand(options, ['--adf-only']);
  const output = JSON.parse(logs.join('\n')) as DoctorOutput;
  return output.checks.find(check => check.name === 'adf required wiring');
}

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('charter doctor adf required wiring', () => {
  it('passes when core.adf and state.adf are DEFAULT_LOAD', async () => {
    const check = await wiringCheck('ADF: 0.1\n\n📦 DEFAULT_LOAD:\n  - core.adf\n  - state.adf\n');
    expect(check?.status).toBe('PASS');
  });

  it('tells the user to move a module registered under ON_DEMAND', async () => {
    const check = await wiringCheck(
      'ADF: 0.1\n\n📦 DEFAULT_LOAD:\n  - state.adf\n\n📂 ON_DEMAND:\n  - core.adf (Triggers on: core)\n',
    );
    expect(check?.status).toBe('WARN');
    expect(check?.details).toBe(
      'Missing from DEFAULT_LOAD: core.adf — move core.adf from ON_DEMAND to DEFAULT_LOAD in .ai/manifest.adf',
    );
  });

  it('tells the user how to add an unregistered module', async () => {
    const check = await wiringCheck('ADF: 0.1\n\n📦 DEFAULT_LOAD:\n  - core.adf\n');
    expect(check?.status).toBe('WARN');
    expect(check?.details).toBe(
      'Missing from DEFAULT_LOAD: state.adf — add state.adf to DEFAULT_LOAD in .ai/manifest.adf '
      + '(or run: charter adf create state.adf --load default)',
    );
  });
});

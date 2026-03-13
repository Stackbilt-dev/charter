/**
 * Credential storage for Stackbilt API key.
 *
 * Persists to ~/.charter/credentials.json (mode 0o600).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface Credentials {
  apiKey: string;
  baseUrl?: string;
}

const CRED_DIR = path.join(os.homedir(), '.charter');
const CRED_FILE = path.join(CRED_DIR, 'credentials.json');

export function loadCredentials(): Credentials | null {
  if (!fs.existsSync(CRED_FILE)) return null;
  try {
    const raw = fs.readFileSync(CRED_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.apiKey || typeof parsed.apiKey !== 'string') return null;
    return parsed as Credentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  if (!fs.existsSync(CRED_DIR)) {
    fs.mkdirSync(CRED_DIR, { recursive: true });
  }
  fs.writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function clearCredentials(): void {
  if (fs.existsSync(CRED_FILE)) {
    fs.unlinkSync(CRED_FILE);
  }
}

/**
 * Credential storage for Stackbilt API key.
 *
 * Two auth sources are supported:
 *   1. STACKBILT_API_KEY environment variable (preferred; no on-disk state).
 *   2. ~/.charter/credentials.json (mode 0o600; populated by `charter login`).
 *
 * `charter login` will be removed in 1.0 — on-disk credential storage moves
 * out of this OSS package. New integrations should use the env var.
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
const API_KEY_ENV_VAR = 'STACKBILT_API_KEY';

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

export interface ResolvedApiKey {
  apiKey: string;
  source: 'env' | 'credentials';
  baseUrl?: string;
}

/**
 * Resolve the Stackbilt API key from env var (preferred) or stored credentials.
 * Returns null when neither source has a key.
 */
export function resolveApiKey(): ResolvedApiKey | null {
  const fromEnv = process.env[API_KEY_ENV_VAR];
  if (fromEnv && fromEnv.trim().length > 0) {
    return { apiKey: fromEnv.trim(), source: 'env' };
  }
  const stored = loadCredentials();
  if (stored) {
    return { apiKey: stored.apiKey, source: 'credentials', baseUrl: stored.baseUrl };
  }
  return null;
}

export { API_KEY_ENV_VAR };

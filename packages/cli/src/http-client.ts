/**
 * HTTP client for the Stackbilt Engine API.
 *
 * Uses native fetch() (Node 18+). Zero external dependencies.
 */

const DEFAULT_BASE_URL = 'https://stackbilt-engine.blue-pine-edf6.workers.dev';

export interface BuildRequest {
  description: string;
  constraints?: {
    cloudflareOnly?: boolean;
    framework?: string;
    database?: string;
    needsAuth?: boolean;
    needsRealtime?: boolean;
    needsQueue?: boolean;
    needsStorage?: boolean;
  };
  seed?: number;
  tier?: 'blessed' | 'all';
}

export interface DrawnTech {
  id: number;
  name: string;
  category: string;
  element: string;
  maturity: string;
  tier: string;
  cloudflareNative: boolean;
  traits: string[];
  keywords: { upright: string[]; reversed: string[] };
  orientation: 'upright' | 'reversed';
  position: string;
}

export interface CompatPair {
  positions: [string, string];
  techs: [string, string];
  elements: [string, string];
  relationship: string;
  score: number;
  description: string;
}

export interface BuildResult {
  stack: DrawnTech[];
  compatibility: {
    pairs: CompatPair[];
    totalScore: number;
    normalizedScore: number;
    dominant: string;
    tensions: { elements: [string, string]; description: string }[];
  };
  scaffold: Record<string, string>;
  seed: number;
  receipt: string;
  requirements: {
    description: string;
    keywords: string[];
    constraints: Record<string, unknown>;
    complexity: string;
  };
}

export interface HealthResponse {
  status: string;
  version: string;
  engine: string;
  catalog: number;
  positions: string[];
}

export class EngineClient {
  private baseUrl: string;
  private apiKey: string | null;

  constructor(options: { baseUrl?: string; apiKey?: string | null }) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = options.apiKey ?? null;
  }

  async health(): Promise<HealthResponse> {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`Engine health check failed: ${res.status}`);
    return res.json() as Promise<HealthResponse>;
  }

  async build(request: BuildRequest): Promise<BuildResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseUrl}/build`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Engine build failed (${res.status}): ${text}`);
    }

    return res.json() as Promise<BuildResult>;
  }

  async catalog(category?: string): Promise<{ primitives: DrawnTech[]; total: number }> {
    const url = new URL(`${this.baseUrl}/catalog`);
    if (category) url.searchParams.set('category', category);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Engine catalog failed: ${res.status}`);
    return res.json() as Promise<{ primitives: DrawnTech[]; total: number }>;
  }
}

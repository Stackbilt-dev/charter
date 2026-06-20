/**
 * classify/bindings — inferBindings
 *
 * Infers required Cloudflare Worker binding declarations from an intention
 * string and pattern traits. Returns ScaffoldBinding[] so callers have
 * typed, named binding descriptors rather than raw string IDs.
 */

import type { ScaffoldBinding } from '../types';

/**
 * Infer required Cloudflare Worker bindings from the intention string and
 * pattern traits.
 *
 * Defaults to D1 + KV when no binding signal is detected. Callers may pass
 * additional traits (e.g. 'streaming', 'scheduled-handler') to influence
 * inference.
 */
export function inferBindings(intention: string, traits: string[] = []): ScaffoldBinding[] {
  const text = intention.toLowerCase();
  const traitsStr = traits.join(' ').toLowerCase();
  const bindings: ScaffoldBinding[] = [];

  const hasD1 = text.includes('d1') || text.includes('database') || text.includes('sql');
  const hasKv = text.includes('kv') || text.includes('cache') || text.includes('rate limit');
  const hasR2 = text.includes('r2') || text.includes('storage') || text.includes('upload') || text.includes('file');
  const hasDo = text.includes('durable object') || text.includes('durable') || text.includes('websocket')
    || traitsStr.includes('do-stub-router') || traitsStr.includes('ws-and-rest');
  const hasAi = /txt2img|text[- ]to[- ]image|image.gen(?:eration)?|stable.diffusion|ai.image|generat\w+.image|llm|workers.ai/i.test(intention)
    || traitsStr.includes('conversation-router');

  if (hasD1) {
    bindings.push({ type: 'D1', name: 'DB', binding: 'DB' });
  }
  if (hasKv) {
    bindings.push({ type: 'KV', name: 'CACHE', binding: 'CACHE' });
  }
  if (hasR2) {
    bindings.push({ type: 'R2', name: 'STORAGE', binding: 'STORAGE' });
  }
  if (hasDo) {
    bindings.push({ type: 'DO', name: 'ROOM', binding: 'ROOM' });
  }
  if (hasAi) {
    bindings.push({ type: 'AI', name: 'AI', binding: 'AI' });
  }

  // Library patterns (e.g. rust-wasm) have no CF Worker runtime and need no bindings.
  // The 'no-server' trait is the canonical signal for this class of patterns.
  if (bindings.length === 0 && !traitsStr.includes('no-server')) {
    bindings.push({ type: 'D1', name: 'DB', binding: 'DB' });
    bindings.push({ type: 'KV', name: 'CACHE', binding: 'CACHE' });
  }

  return bindings;
}

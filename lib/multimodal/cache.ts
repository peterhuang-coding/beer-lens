/**
 * Vision call cache.
 *
 * Keys are sha256(capability_id + prompt + schema + image_base64 + mime),
 * truncated to 32 hex chars (still 128 bits of entropy — collision-proof at
 * any plausible scale). Values are the raw provider response string.
 *
 * TTL defaults to 60s — a menu photo is unlikely to reappear with the same
 * prompt inside a minute, and we don't want stale OCR bleeding through after
 * the user takes a fresh shot. Tests can override via setCacheTtl().
 *
 * Capacity: 32 entries (LRU via Map insertion order; oldest is evicted).
 */

import { createHash } from "node:crypto";
import type { CapabilityInput } from "./types.ts";

const MAX_ENTRIES = 32;
const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  raw: string;
  expiresAt: number;
}

const _store = new Map<string, CacheEntry>();
let _ttlMs = DEFAULT_TTL_MS;

export function setCacheTtl(ms: number): void {
  _ttlMs = Math.max(0, ms);
}

export function getCacheTtl(): number {
  return _ttlMs;
}

/**
 * Compute a cache key from capability id + input.
 * If a schema is provided, the schema JSON is mixed in so two different
 * capability calls with the same image don't collide.
 */
export function computeKey(capabilityId: string, input: CapabilityInput): string {
  const h = createHash("sha256");
  h.update(capabilityId);
  h.update("\x00prompt\x00");
  h.update(input.prompt);
  if (input.schema) {
    h.update("\x00schema\x00");
    h.update(JSON.stringify(input.schema));
  }
  h.update("\x00mime\x00");
  h.update(input.image.mime);
  h.update("\x00img\x00");
  h.update(input.image.base64);
  return h.digest("hex").slice(0, 32);
}

export function getCache(key: string): string | null {
  const entry = _store.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    _store.delete(key);
    return null;
  }
  // Touch: re-insert to refresh LRU position
  _store.delete(key);
  _store.set(key, entry);
  return entry.raw;
}

export function setCache(key: string, raw: string, ttlMs: number = _ttlMs): void {
  if (ttlMs <= 0) return;
  if (_store.size >= MAX_ENTRIES) {
    // Evict oldest
    const oldest = _store.keys().next().value;
    if (oldest !== undefined) _store.delete(oldest);
  }
  _store.set(key, { raw, expiresAt: Date.now() + ttlMs });
}

export function invalidateCache(): void {
  _store.clear();
}

export function _cacheSize(): number {
  return _store.size;
}
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type BeerCacheEntry = {
  id: string;                     // Untappd beer id (string from URL)
  beerName: string;
  breweryName: string;
  breweryCountry: string | null;
  style: string;
  abv: number;
  ibu: number | null;
  ratingScore: number;
  ratingCount: number;
  untappdUrl: string;
  labelImage: string | null;
  verified: boolean;              // true if verified via web search (not just LLM)
  cachedAt: number;
};

type CacheFile = {
  version: number;
  beers: Record<string, BeerCacheEntry>;
};

const cachePath = path.join(process.cwd(), "data", "beer_cache.json");
const ttlMs = 365 * 24 * 60 * 60 * 1000; // 1 year

let memoryCache: Map<string, BeerCacheEntry> | null = null;

async function readCache(): Promise<Map<string, BeerCacheEntry>> {
  if (memoryCache) return memoryCache;

  try {
    const raw = await readFile(cachePath, "utf8");
    const file = JSON.parse(raw) as CacheFile;
    memoryCache = new Map(Object.entries(file.beers));
  } catch {
    memoryCache = new Map();
  }

  return memoryCache;
}

async function writeCache(cache: Map<string, BeerCacheEntry>) {
  const file: CacheFile = {
    version: 2,
    beers: Object.fromEntries(cache)
  };
  await writeFile(cachePath, `${JSON.stringify(file, null, 2)}\n`);
  memoryCache = cache;
}

export async function getFromCache(id: string): Promise<BeerCacheEntry | null> {
  const cache = await readCache();
  const entry = cache.get(id);
  if (!entry) return null;

  if (Date.now() - entry.cachedAt > ttlMs) {
    return null;
  }

  return entry;
}

export async function putToCache(entry: BeerCacheEntry): Promise<void> {
  const cache = await readCache();
  cache.set(entry.id, entry);
  await writeCache(cache);
}

export async function searchCacheByName(query: string): Promise<BeerCacheEntry[]> {
  const cache = await readCache();
  const lower = query.toLowerCase();

  return Array.from(cache.values())
    .filter((entry) => {
      if (Date.now() - entry.cachedAt > ttlMs) return false;
      return (
        entry.beerName.toLowerCase().includes(lower) ||
        entry.breweryName.toLowerCase().includes(lower)
      );
    })
    .slice(0, 10);
}

// ── Exact verified batch reads (image-first path) ──
//
// Unlike searchCacheByName's discovery-oriented substring scan (capped at ten
// hits), this entry point attaches cache data ONLY to an exact, unique, fresh,
// verified identity. It performs a single cache snapshot per call, never
// mutates or writes the cache, and returns one slot per input (same order and
// cardinality). Anything short of an exact identity yields null.

export type VerifiedCacheInput = { beerName: string; brewery?: string };

/** NFKC + lowercase + letters/numbers only, matching the grounding strict keys. */
function strictKey(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Structural + freshness guard: malformed/stale/future/unverified rows never qualify. */
function isFreshVerifiedEntry(value: unknown, now: number): value is BeerCacheEntry {
  if (value === null || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  if (e.verified !== true) return false;
  if (typeof e.id !== "string" || e.id.trim() === "") return false;
  if (typeof e.beerName !== "string" || e.beerName.trim() === "") return false;
  if (typeof e.breweryName !== "string") return false;
  if (typeof e.style !== "string") return false;
  if (typeof e.untappdUrl !== "string") return false;
  if (!finiteNumber(e.abv) || e.abv < 0) return false;
  if (!finiteNumber(e.ratingScore) || e.ratingScore < 0 || e.ratingScore > 5) return false;
  if (!finiteNumber(e.ratingCount) || !Number.isInteger(e.ratingCount) || e.ratingCount < 0) return false;
  if (e.ibu != null && !finiteNumber(e.ibu)) return false;
  if (e.breweryCountry != null && typeof e.breweryCountry !== "string") return false;
  if (e.labelImage != null && typeof e.labelImage !== "string") return false;
  const ts = e.cachedAt;
  if (!finiteNumber(ts) || ts < 0 || ts > now) return false;
  if (now - ts > ttlMs) return false;
  return true;
}

function resolveVerified(
  input: VerifiedCacheInput,
  snapshot: Map<string, BeerCacheEntry>,
  now: number,
): BeerCacheEntry | null {
  const nameKey = strictKey(input?.beerName);
  if (!nameKey) return null;
  const breweryKey = strictKey(input?.brewery ?? "");

  const matches: BeerCacheEntry[] = [];
  for (const entry of snapshot.values()) {
    if (!isFreshVerifiedEntry(entry, now)) continue;
    if (strictKey(entry.beerName) !== nameKey) continue; // exact full title only
    if (breweryKey && strictKey(entry.breweryName) !== breweryKey) continue; // wrong brewery
    matches.push(entry);
  }
  if (matches.length === 0) return null;

  // Unique identity/variant only. Same title from another brewery, an
  // unresolved same-name ambiguity, or conflicting duplicate ids stay null.
  if (breweryKey) {
    const ids = new Set(matches.map(e => e.id));
    return ids.size === 1 ? matches[0] : null;
  }
  const byBrewery = new Map<string, Set<string>>();
  for (const e2 of matches) {
    const key = strictKey(e2.breweryName);
    const ids = byBrewery.get(key) ?? new Set<string>();
    ids.add(e2.id);
    byBrewery.set(key, ids);
  }
  if (byBrewery.size !== 1) return null;
  const onlyIds = byBrewery.values().next().value as Set<string>;
  return onlyIds.size === 1 ? matches[0] : null;
}

/**
 * Read fresh verified cache rows for a batch of exact identities.
 * One local snapshot for the whole batch; same order/cardinality as inputs;
 * null for every input without a unique exact fresh verified match. Pure read:
 * no search, no verification, no network, and no cache writes/side effects.
 */
export async function batchReadVerifiedCache(
  inputs: ReadonlyArray<VerifiedCacheInput>,
  nowMs?: number,
): Promise<Array<BeerCacheEntry | null>> {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const snapshot = await readCache();
  const now = finiteNumber(nowMs) ? (nowMs as number) : Date.now();
  return inputs.map(input => resolveVerified(input, snapshot, now));
}

export async function getStaleIds(): Promise<string[]> {
  const cache = await readCache();
  return Array.from(cache.entries())
    .filter(([, entry]) => Date.now() - entry.cachedAt > ttlMs)
    .map(([id]) => id);
}

export async function getCacheStats() {
  const cache = await readCache();
  const entries = Array.from(cache.values());
  const fresh = entries.filter((e) => Date.now() - e.cachedAt <= ttlMs).length;
  return { total: entries.length, fresh, stale: entries.length - fresh };
}

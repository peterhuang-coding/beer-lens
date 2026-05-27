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

/**
 * Beer DB Pipeline — unified entry point for all beer database operations.
 *
 * This is the ONLY module that external code should import from beer-db/.
 * It wraps:
 *   - data-layer.ts   → SQLite lookup (Python child_process)
 *   - enricher.ts     → Untappd enrichment + pricing
 *   - cache.ts        → Local JSON cache (hot data)
 *   - value-calc.ts   → Origin-country pricing benchmarks
 *   - untappd-verify.ts → Brave Search rating verification
 *
 * Future extension points (not yet implemented):
 *   - refreshCache()      → scheduled incremental cache refresh
 *   - updateDatabase()    → upsert new beers into SQLite
 *   - hotReload()         → reload cache without server restart
 *   - multiSource()       → RateBeer / Untappd / custom source switching
 */

import { batchLookupBeers, getBeerDbStats } from "./data-layer";
import type { BeerResult } from "./data-layer";
import { enrichBeer, enrichBeers } from "./enricher";
import type { EnrichedBeer } from "./enricher";
import { searchCacheByName, getCacheStats } from "./cache";
import type { BeerCacheEntry } from "./cache";
import { calcValueScore } from "./value-calc";
import type { PriceInfo, ValueResult } from "./value-calc";

// ── Public types ──

export type { BeerResult, EnrichedBeer, BeerCacheEntry, PriceInfo, ValueResult };

export type BeerLookupResult = {
  /** The query that was searched */
  query: string;
  /** Whether any beer was found */
  found: boolean;
  /** The matched beer data (if found) */
  data: BeerResult | null;
};

export type DbStats = {
  db: Record<string, unknown>;
  cache: ReturnType<typeof getCacheStats> extends Promise<infer T> ? T : never;
};

export type EnrichInput = {
  beerName: string;
  brewery?: string;
  style?: string;
  abv?: number;
  hops?: string[];
  price?: number;
  volumeMl?: number;
  confidence?: number;
};

// ── Lookup: search the SQLite database ──

/**
 * Batch lookup beers from the SQLite database.
 * Each query can be "BeerName" or "BeerName Brewery".
 * Results are returned in the same order as queries.
 */
export async function lookupBeers(queries: string[]): Promise<BeerLookupResult[]> {
  if (queries.length === 0) return [];

  const results = await batchLookupBeers(queries);

  return queries.map((query, i) => {
    const result = results[i];
    const found = result?.found === true;
    return {
      query,
      found,
      data: found ? result : null,
    };
  });
}

/**
 * Single beer lookup — convenience wrapper.
 */
export async function lookupBeer(query: string): Promise<BeerLookupResult> {
  const results = await lookupBeers([query]);
  return results[0];
}

// ── Enrich: add Untappd data + pricing ──

/**
 * Enrich a single beer candidate with Untappd ratings, brewery country,
 * and origin-country pricing benchmarks.
 *
 * Strategy:
 *   1. Check local cache (fast, verified data)
 *   2. Fall back to batch search (database + web)
 *   3. Calculate value score (price vs origin country benchmark)
 */
export async function enrichCandidate(input: EnrichInput): Promise<EnrichedBeer> {
  return enrichBeer(input);
}

/**
 * Batch enrich — one call for all candidates.
 * Efficient: parallel lookups + single cache write pass.
 */
export async function enrichCandidates(inputs: EnrichInput[]): Promise<EnrichedBeer[]> {
  return enrichBeers(inputs);
}

// ── Stats: database health ──

/**
 * Get combined database statistics (SQLite + cache).
 */
export async function getStats(): Promise<DbStats> {
  const [dbStats, cacheStats] = await Promise.all([
    getBeerDbStats().catch(() => ({ error: "Database unavailable" })),
    getCacheStats(),
  ]);
  return { db: dbStats, cache: cacheStats };
}

/**
 * Get cache-only stats (hot data).
 */
export async function getHotCacheStats() {
  return getCacheStats();
}

/**
 * Search local cache by beer name (fast, no DB lookup).
 */
export async function searchHotCache(name: string): Promise<BeerCacheEntry[]> {
  return searchCacheByName(name);
}

// ── Refresh (placeholder for future implementation) ──

/**
 * Refresh the beer database cache.
 * Currently a no-op — cache entries live for 1 year.
 * Future: pull new Untappd ratings for stale entries.
 */
export async function refreshCache(): Promise<{ refreshed: number; errors: number }> {
  // Placeholder for future cron-based refresh
  return { refreshed: 0, errors: 0 };
}

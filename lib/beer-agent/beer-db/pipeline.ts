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

/**
 * Try to extract candidate English beer names from a Chinese OCR query.
 * OCR rawText often contains the original English name, e.g.:
 *   "双倍干投暴龙苏 双倍干投浑浊淡色艾尔 DDH Pseudo Sue Toppling Goliath"
 * → extracts ["Pseudo Sue", "DDH Pseudo Sue"]
 */
function extractEnglishAliases(query: string): string[] {
  // If the query is purely ASCII, no alias extraction needed
  if (!/[^\x00-\x7F]/.test(query)) return [];

  // Extract sequences of 2+ ASCII words (potential English beer names)
  // from the raw query. This handles cases where OCR output is passed
  // as query with embedded English text.
  const asciiWords = query.match(/[A-Za-z][A-Za-z'.\-]+/g) || [];
  if (asciiWords.length < 2) return [];

  // Build candidate names by taking longer subsequences first
  const candidates: string[] = [];
  for (let len = Math.min(asciiWords.length, 4); len >= 2; len--) {
    for (let i = 0; i <= asciiWords.length - len; i++) {
      const phrase = asciiWords.slice(i, i + len).join(" ");
      if (phrase.length > 3) candidates.push(phrase);
    }
  }
  return [...new Set(candidates)].slice(0, 3);
}

/**
 * Known Chinese → English beer name mapping, built from OCR trace data.
 * Gemini Flash OCR outputs Chinese names for beers, but the SQLite DB stores
 * English names. This map bridges the gap.
 *
 * Sources: OCR trace data from 2026-07-08 bar menu image.
 * Format: Chinese OCR name → English DB name (or search prefix)
 */
const CN_TO_EN_BEER_MAP: Record<string, string[]> = {
  // ── Toppling Goliath ──
  "暴龙苏": ["Pseudo Sue"],
  "双倍干投暴龙苏": ["Pseudo Sue"],
  "赛博暴龙": ["Cyber Sue"],

  // ── Stamm ──
  "年轻领主": ["Young Lordship"],

  // ── Gaffel ──
  "科隆": ["Kölsch", "Kolsch", "Gaffel"],

  // ── RaR ──
  "棱镜之外": ["Out of the Prysm"],

  // ── Duckpond ──
  "奢华冰冻池塘": ["Frozen Pond"],

  // ── Tripping Animals ──
  "罗萨达": ["Limonada Rosada"],

  // ── Suntory ──
  "黑啤": ["Schwarzbiier", "Premium Malt"],

  // ── Cloudwater ──
  "查博斯": ["Chubbles"],

  // ── Lolev ──
  "黑豹": ["Panther"],

  // ── Mortalis ──
  "德米海德拉10号": ["DemiHydra"],
  "德米海德拉": ["DemiHydra"],

  // ── Side Project ──
  "蜂巢-第6批次": ["La Ruche"],
  "蜂巢": ["La Ruche"],

  // ── Moonraker ──
  "酷酷": ["Cool Cool"],
  "电光酒花": ["Electric Lettuce"],

  // ── HOMES ──
  "一样一样的": ["SAME SAME SAME"],

  // ── Frequentem ──
  "果味满满34号": ["Just Fruit"],

  // ── Amundsen ──
  "甜甜圈波士顿奶油": ["Donut Series", "DONUT SERIES"],

  // ── Common Chinese names for styles/descriptors ──
  "浑浊": ["Hazy IPA"],
  "西海岸": ["West Coast IPA"],
  "双倍浑浊": ["Double Hazy IPA"],
  "三倍浑浊": ["Triple Hazy IPA"],
  "帝国": ["Imperial"],
  "水果酸艾尔": ["Fruited Sour"],
  "农舍塞松": ["Farmhouse Saison"],
  "帝国甜点世涛": ["Imperial Pastry Stout"],
  "帝国水果古斯": ["Imperial Fruited Gose"],
  "捷克皮尔森": ["Czech Pilsner"],
  "德式黑啤": ["Schwarzbiier", "German Black"],
};

function lookupChineseBeerName(chineseName: string): string | null {
  // Try exact match first
  if (CN_TO_EN_BEER_MAP[chineseName]?.length > 0) {
    return CN_TO_EN_BEER_MAP[chineseName][0];
  }
  // Try prefix match (shorter Chinese name may be prefix of a known entry)
  for (const [cn, eng] of Object.entries(CN_TO_EN_BEER_MAP)) {
    if (chineseName.includes(cn) || cn.includes(chineseName)) {
      return eng[0];
    }
  }
  return null;
}

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

  // Phase 1: batch lookup all queries directly
  const results = await batchLookupBeers(queries);

  // Phase 2: for queries that didn't hit, try fallback strategies
  //   Strategy A: Chinese→English name mapping (from OCR trace data)
  //   Strategy B: English alias extraction from embedded ASCII text
  const fallbackQueries: { idx: number; alias: string }[] = [];
  for (let i = 0; i < queries.length; i++) {
    if (results[i]?.found) continue;
    const query = queries[i];
    if (!/[^\x00-\x7F]/.test(query)) continue; // only for Chinese queries

    // Strategy A: lookup known Chinese→English mapping
    const mapped = lookupChineseBeerName(query);
    if (mapped) {
      fallbackQueries.push({ idx: i, alias: mapped });
      continue;
    }

    // Strategy B: extract English aliases from embedded ASCII text
    const aliases = extractEnglishAliases(query);
    if (aliases.length > 0) {
      fallbackQueries.push({ idx: i, alias: aliases[0] });
    }
  }

  // Phase 3: batch lookup all fallback aliases
  if (fallbackQueries.length > 0) {
    const fallbackResults = await batchLookupBeers(
      fallbackQueries.map((f) => f.alias),
    );
    for (let fi = 0; fi < fallbackQueries.length; fi++) {
      const { idx } = fallbackQueries[fi];
      const fallbackResult = fallbackResults[fi];
      if (fallbackResult?.found === true) {
        results[idx] = fallbackResult;
      }
    }
  }

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

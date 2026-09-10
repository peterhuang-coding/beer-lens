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

import { batchLookupBeers, getBeerDbStats, lookupBrewery } from "./data-layer";
import type { BeerResult, BreweryLookupResult } from "./data-layer";
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
export function extractEnglishAliases(query: string): string[] {
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
export { lookupChineseBeerName } from "./aliases.ts";
import { resolveChineseAlias } from "./aliases.ts";

/** Explicit brewery constraints must match the brewery field, never the title. */
export function matchesBeerIdentity(
  query: string,
  beer: { name: string; brewery: string },
  expectedBrewery?: string,
): boolean {
  const identities = [query, resolveChineseAlias(query)?.query].filter((value): value is string => Boolean(value));
  const norm = (value: string) => value.toLowerCase().replace(/['’]/g, "");
  const name = norm(beer.name);
  const brewery = norm(beer.brewery);
  const allWordsMatch = (value: string, fields: string[]) => {
    const words = norm(value).split(/\s+/).filter(Boolean);
    return words.length > 0 && words.every(word => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const boundary = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu");
      return fields.some(field => boundary.test(field));
    });
  };
  if (expectedBrewery?.trim() && !allWordsMatch(expectedBrewery, [brewery])) return false;
  // Legacy combined string queries have no field boundary. Structured callers
  // pass expectedBrewery (possibly empty) to keep beer-name words in the title.
  return identities.some(identity => allWordsMatch(identity, expectedBrewery === undefined ? [name, brewery] : [name]));
}

/** Discovery may accept a partial name; attaching a rating requires the full name. */
export function matchesExactBeerIdentity(query:string, beer:{name:string;brewery:string}, brewery=''):boolean {
  if(!matchesBeerIdentity(query,beer,brewery)) return false;
  const norm=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const resolved=resolveChineseAlias(query);
  const names=[query,resolved?.exact ? resolved.query : ''];
  // Bilingual OCR headings can repeat the same name after its known alias.
  if(resolved?.exact && norm(resolved.query)===norm(resolved.name).repeat(2)) names.push(resolved.name);
  return names.some(name=>norm(name)===norm(beer.name));
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
 * Pass separate breweries when available to validate each field independently.
 * Results are returned in the same order as queries.
 */
export async function lookupBeers(queries: string[], breweries?: string[]): Promise<BeerLookupResult[]> {
  if (queries.length === 0) return [];

  // Phase 1: batch lookup all queries directly
  const searchQueries = queries.map((query, i) => [query, breweries?.[i]].filter(Boolean).join(" "));
  const results = await batchLookupBeers(searchQueries);

  // Phase 2: for queries that didn't hit, try fallback strategies
  //   Strategy A: Chinese→English name mapping (from OCR trace data)
  const fallbackQueries: { idx: number; alias: string }[] = [];
  for (let i = 0; i < queries.length; i++) {
    if (results[i]?.found) continue;
    const query = queries[i];
    if (!/[^\x00-\x7F]/.test(query)) continue; // only for Chinese queries

    const mapped = resolveChineseAlias(query);
    if (mapped) fallbackQueries.push({ idx: i, alias: [mapped.query, breweries?.[i]].filter(Boolean).join(" ") });
    // Do not drop unknown Chinese fragments to search an arbitrary English
    // substring: that could turn an unrecognized variant into a different beer.
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

  // 统一强吻合门(所有结果,含第一阶段直接命中):
  // 查询的每个词都必须以词边界匹配出现在 酒名或酒厂 里(防 raft→draft、
  // stamm→Stammtisch 类子串假命中),并防止 lookup.py 的逐级缩短查询
  // 把 "Moon Lark" 缩成 "Moon" 命中,给推荐灌假数据。(2026-08-25 实测暴露)
  return queries.map((query, i) => {
    const result = results[i];
    if (result?.found !== true) return { query, found: false, data: null };
    const ok = matchesBeerIdentity(query, {
      name: String(result.name ?? ""), brewery: String(result.brewery ?? ""),
    }, breweries ? breweries[i] ?? "" : undefined);
    return {
      query,
      found: ok,
      data: ok ? result : null,
    };
  });
}

/**
 * Brewery-level lookup — 具体酒款查不到时的兜底:返回厂级统计 + 代表款。
 */
export async function lookupBreweryStats(query: string): Promise<BreweryLookupResult> {
  return lookupBrewery(query);
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

// ── Refresh (delegates to updater.ts) ──

import { refreshDatabase as _refreshDatabase } from "./updater";
import type { RefreshParams as _RefreshParams, RefreshResult as _RefreshResult } from "./updater";

export type RefreshParams = _RefreshParams;
export type RefreshResult = _RefreshResult;

/**
 * Refresh the beer database.
 *
 * Delegates to updater.refreshDatabase. Pass `params.source` to pick
 * the upstream crawler, `forceUpsert: true` to bypass DB-side dedup,
 * `includeImages: true` to also crawl Wikimedia/Flickr.
 *
 * Backwards compatible: returns the same shape as before when nothing
 * crawled (so old callers don't break).
 */
export async function refreshCache(
  params: RefreshParams = { source: "all" },
): Promise<{ refreshed: number; errors: number; details?: RefreshResult["details"] }> {
  const result = await _refreshDatabase(params);
  return {
    refreshed: result.added + result.updated,
    errors: result.errors,
    details: result.details,
  };
}

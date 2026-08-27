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
  "黑啤": ["Schwarzbier", "Premium Malt"],

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

  // ── 注:风格描述词(浑浊/西海岸/帝国/德式黑啤…)不再映射——
  // 通用风格名命中酒名检索会产生假阳性(如「午餐 西海岸IPA」错配智利 West Coast IPA)。
  // 风格探测走 genericRecommendationQueries,不走本表。(2026-08-25 实测移除)

  // ── Chinese Craft Breweries (高大师) ──
  "婴儿肥": ["Baby IPA"],
  "婴儿肥IPA": ["Baby IPA"],
  "茉莉花茶拉格": ["Jasmine Tea Lager"],
  "烤地瓜艾尔": ["Roasted Sweet Potato Ale"],
  "熊猫王": ["Panda King IPA"],
  "高大师": ["Baby IPA", "Jasmine Tea Lager"],

  // ── Chinese Craft Breweries (京A) ──
  "工人淡色艾尔": ["Workers Pale Ale"],
  "飞拳": ["Flying Fist IPA"],
  "飞拳IPA": ["Flying Fist IPA"],
  "空气大爆表": ["Airpocalypse"],
  "陈皮小麦": ["Mandarin Wheat"],
  "帝都浑浊": ["Beijing Haze"],
  "京A": ["Flying Fist IPA", "Workers Pale Ale"],

  // ── Chinese Craft Breweries (牛啤堂) ──
  "帝都海盐": ["Imperial Sea Salt Gose"],
  "树莓酸小麦": ["Raspberry Sour Wheat"],
  "芒果酸小麦": ["Mango Sour Wheat"],
  "牛啤堂": ["Imperial Sea Salt Gose"],

  // ── Chinese Craft Breweries (18号酒馆) ──
  "跳东湖": ["Jump East Lake IPA"],
  "跳东湖IPA": ["Jump East Lake IPA"],
  "胶片机": ["Film Camera"],
  "不在湖": ["Not Here Lake"],
  "胶片机奶昔": ["Cinema Milk IPA"],
  "18号": ["Jump East Lake IPA"],

  // ── Chinese Craft Breweries (大跃) ──
  "蜂蜜艾尔": ["Honey Ale"],
  "帝都艾尔": ["Imperial City Ale"],
  "香蕉小麦": ["Banana Wheat"],
  "大跃": ["Honey Ale", "Imperial City Ale"],

  // ── Chinese Craft Breweries (悠航) ──
  "猴拳": ["Monkey Fist IPA"],
  "猴拳IPA": ["Monkey Fist IPA"],
  "京华烟云": ["Hazy Dream"],
  "悠航": ["Monkey Fist IPA"],

  // ── Chinese Craft Breweries (拾捌) ──
  "不接受批评": ["No Criticism"],
  "血滴子": ["Blood Dropper"],
  "拾捌": ["No Criticism"],

  // ── Chinese Craft Breweries (拳击猫) ──
  "琥珀拉格": ["Amber Lager"],
  "TKO IPA": ["TKO IPA"],
  "荔枝猫": ["Lychee Cat"],
  "拳击猫": ["Amber Lager", "TKO IPA"],

  // ── Chinese Craft Breweries (道酿) ──
  "伏魔": ["Demon Tamer IPA"],
  "伏魔IPA": ["Demon Tamer IPA"],
  "马赛克": ["Mosaic IPA"],
  "春分": ["Spring Equinox"],
  "道酿": ["Demon Tamer IPA"],

  // ── Chinese Craft Breweries (或不凡) ──
  "黄河水": ["Yellow River Water"],
  "君不见": ["Cannot See"],
  "将进酒": ["Will Drink"],
  "或不凡": ["Yellow River Water"],

  // ── More Chinese Craft Breweries ──
  "远山": ["Cloudy Mountain"],
  "气泡IPA": ["Bubble Lab IPA"],
  "当歌": ["Song of the Moment"],
  "野鹅IPA": ["Wild Goose IPA"],
  "北平IPA": ["Beijing Machine"],
  "楚门小麦": ["Truman Wheat"],
  "美西西海岸": ["West Coast IPA"],
  "忒斯特IPA": ["Taste Test IPA"],
  "功夫IPA": ["Kung Fu IPA"],
  "红灯笼": ["Red Lantern"],
  "熊猫蜂蜜": ["Panda Honey Ale"],
  "藏式青稞": ["Tibet Barley"],
  "绿城拉格": ["Green City Lager"],

  // ── Chinese Macro Breweries ──
  "青岛黑啤": ["Tsingtao Stout"],
  "青岛IPA": ["Tsingtao IPA"],
  "青岛啤酒": ["Tsingtao Stout", "Tsingtao IPA"],
  "燕京原浆": ["Yanjing Original"],
  "燕京": ["Yanjing Original"],
  "雪花": ["Snow Beer"],
  "哈尔滨啤酒": ["Harbin Beer"],
  "珠江纯生": ["Pearl River Draft"],
  "乌苏": ["Wusu Beer"],
  "千岛湖": ["West Lake Lager"],

  // ── El Nido 酒单 (2026-08-24 OCR 实测, 2026-08-25 入库验证) ──
  "黑比考黑": ["Sapporo Premium Black Beer"],
  "午餐": ["Lunch"],
};

export function lookupChineseBeerName(chineseName: string): string | null {
  // Try exact match first
  if (CN_TO_EN_BEER_MAP[chineseName]?.length > 0) {
    return CN_TO_EN_BEER_MAP[chineseName][0];
  }
  // Substring match with scoring: start-anchored keys win over embedded ones,
  // longer keys win over shorter — 防止「午餐 西海岸IPA」被通用键「西海岸」抢走。
  let best: { score: number; eng: string } | null = null;
  for (const [cn, eng] of Object.entries(CN_TO_EN_BEER_MAP)) {
    if (!eng.length) continue;
    if (!chineseName.includes(cn) && !cn.includes(chineseName)) continue;
    const startsWith = chineseName.startsWith(cn) ? 1 : 0;
    const score = startsWith * 1000 + cn.length;
    if (!best || score > best.score) best = { score, eng: eng[0] };
  }
  return best ? best.eng : null;
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

  // 统一强吻合门(所有结果,含第一阶段直接命中):
  // 查询的每个词都必须以词边界匹配出现在 酒名或酒厂 里(防 raft→draft、
  // stamm→Stammtisch 类子串假命中),并防止 lookup.py 的逐级缩短查询
  // 把 "Moon Lark" 缩成 "Moon" 命中,给推荐灌假数据。(2026-08-25 实测暴露)
  return queries.map((query, i) => {
    const result = results[i];
    if (result?.found !== true) return { query, found: false, data: null };
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    // 撇号归一:Becks 与 Beck's 视为同一词(2026-08-28 实测暴露)
    const norm = (s: string) => s.toLowerCase().replace(/['’]/g, "");
    const name = norm(String(result.name ?? ""));
    const brewery = norm(String(result.brewery ?? ""));
    const ok =
      words.length > 0 &&
      words.every((w) => {
        const re = new RegExp(`\\b${norm(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        return re.test(name) || re.test(brewery);
      });
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

import { readFile } from "node:fs/promises";

// ── Public types ──────────────────────────────────────────────────────────

export type SampledBeer = {
  source_id: string;
  name: string;
  style: string | null;
  abv: number | null;
  rating: number | null;
  rating_count: number | null;
  country: string | null;
  brewery_name: string | null;
  label_image: string | null;
  url: string;
};

// ── Module-level cache ────────────────────────────────────────────────────
//
// `untappd-csv-input.jsonl` is 18 MB. Parsing on every request is wasteful,
// so we keep a 5-minute in-memory cache keyed by file mtime. force-dynamic
// pages re-render on every GET but they all share this cache.

type CacheEntry = { beers: SampledBeer[]; loadedAt: number; mtimeMs: number };

const CACHE_TTL_MS = 5 * 60 * 1000;

let _cache: CacheEntry | null = null;

// ── Pure helpers (exported for testing) ───────────────────────────────────

/**
 * Parse a JSONL stream into (BeerRecord lines, __meta lines).
 *
 * Format from scripts/import-untappd-csv.mjs:
 *   line 0 → BeerRecord
 *   line 1 → __meta
 *   line 2 → BeerRecord
 *   line 3 → __meta
 *   ...
 */
export type ParsedLine = { kind: "record" | "meta"; data: Record<string, unknown> };

export function parseJsonlLines(txt: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const kind: "record" | "meta" = obj.__meta === true ? "meta" : "record";
      out.push({ kind, data: obj });
    } catch {
      // skip malformed lines — never throw on partial data
    }
  }
  return out;
}

/**
 * Pair BeerRecord + __meta lines by source_id.
 *
 * Input order is enforced: even index = record, odd index = meta.
 * If the order is mixed (e.g. legacy export), the function still merges
 * correctly via Map lookup.
 */
export function mergeRecordMeta(lines: ParsedLine[]): SampledBeer[] {
  const metaById = new Map<string, Record<string, unknown>>();
  const records: Record<string, unknown>[] = [];

  for (const { kind, data } of lines) {
    if (kind === "meta") {
      const id = String(data.source_id ?? "");
      if (id) metaById.set(id, data);
    } else {
      records.push(data);
    }
  }

  const out: SampledBeer[] = [];
  for (const r of records) {
    const id = String(r.source_id ?? "");
    const m = metaById.get(id) ?? {};
    out.push({
      source_id: id,
      name: String(r.name ?? "(unnamed)"),
      style: r.style === undefined ? null : (r.style as string | null),
      abv: typeof r.abv === "number" ? r.abv : null,
      rating: typeof r.rating === "number" ? r.rating : null,
      rating_count: typeof r.rating_count === "number" ? r.rating_count : null,
      country: (m.country as string | undefined) ?? null,
      brewery_name: (m.brewery_name as string | undefined) ?? null,
      label_image: (m.label_image as string | undefined) ?? null,
      url: String(r.url ?? ""),
    });
  }
  return out;
}

/**
 * Pick `n` unique random elements from `arr` using a Fisher-Yates partial
 * shuffle on a copy. Pure — does not mutate input.
 *
 * Returns at most min(n, arr.length) elements.
 */
export function pickRandom<T>(arr: readonly T[], n: number): T[] {
  if (n <= 0 || arr.length === 0) return [];
  const copy = arr.slice();
  const k = Math.min(n, copy.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, k);
}

// ── Cached loader ────────────────────────────────────────────────────────

async function loadBeers(jsonlPath: string): Promise<SampledBeer[]> {
  const stat = await import("node:fs/promises").then((m) => m.stat(jsonlPath));
  const mtimeMs = stat.mtimeMs;

  if (_cache && _cache.mtimeMs === mtimeMs && Date.now() - _cache.loadedAt < CACHE_TTL_MS) {
    return _cache.beers;
  }

  const txt = await readFile(jsonlPath, "utf8");
  const lines = parseJsonlLines(txt);
  const beers = mergeRecordMeta(lines);
  _cache = { beers, loadedAt: Date.now(), mtimeMs };
  return beers;
}

/**
 * Public entry — pick N random beers from the Untappd CSV jsonl.
 * Uses module-level cache (5-min TTL, mtime-keyed).
 */
export async function pickRandomBeers(jsonlPath: string, n: number): Promise<SampledBeer[]> {
  const beers = await loadBeers(jsonlPath);
  return pickRandom(beers, n);
}

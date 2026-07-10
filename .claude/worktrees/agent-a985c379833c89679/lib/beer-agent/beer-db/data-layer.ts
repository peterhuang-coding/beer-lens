/**
 * Data layer — calls Python lookup.py (SQLite beer database).
 * Replaces LLM-based "Untappd lookup" with real beer data.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const PYTHON = "python3";
const LOOKUP_SCRIPT = path.join(process.cwd(), ".beer-data", "lookup.py");

export type BeerResult = {
  id: string | number;
  name: string;
  brewery: string;
  style: string;
  abv: number | null;
  rating: number;
  ratings_count: number;
  source: "untappd" | "ratebeer";
  found: boolean;
  confidence: "exact" | "high" | "medium" | "none";
  // Untappd extras
  untappd_url?: string;
  country?: string;
  label_image?: string;
  // RateBeer extras
  review_aroma?: number;
  review_appearance?: number;
  review_palate?: number;
  review_taste?: number;
};

// ── Single beer lookup ──

export async function lookupBeer(query: string): Promise<BeerResult[]> {
  const result = await callLookup(query);
  return result.results ?? [];
}

// ── Batch lookup (best for menus) ──

export async function batchLookupBeers(queries: string[]): Promise<BeerResult[]> {
  if (queries.length === 0) return [];
  const pipeQuery = queries.join("|");
  const results = await callLookup("--batch", pipeQuery);
  // Results come back in same order; found:false items are misses
  return Array.isArray(results) ? results : [];
}

// ── Database stats ──

export async function getBeerDbStats(): Promise<Record<string, unknown>> {
  return callLookup("--stats");
}

// ── Common interface (compatible with old SearchResult) ──

export type SearchResult = {
  id: string;
  name: string;
  brewery: string;
  style: string;
  abv: number;
  rating: number;
  url: string;
  numRatings?: number;
};

export type BeerDetails = {
  id: string;
  name: string;
  brewery: string;
  style: string;
  abv: number;
  ibu: number | null;
  rating: number;
  numRatings: number;
  image: string | null;
  url: string;
};

/**
 * Search for a single beer (legacy API compat).
 * Returns list of matches — first is best.
 */
export async function searchBeer(query: string): Promise<SearchResult[]> {
  const results = await lookupBeer(query);
  return results.map(toSearchResult);
}

/**
 * Get beer detail by ID (legacy API compat).
 * Not fully supported by SQLite lookup — returns null.
 * Use searchBeer() instead.
 */
export async function getBeerInfo(_id: string): Promise<BeerDetails | null> {
  return null; // SQLite lookup uses names, not IDs
}

/**
 * Batch search (legacy API compat).
 * Returns one result per query in same order.
 */
export async function batchSearchBeers(queries: string[]): Promise<SearchResult[]> {
  const results = await batchLookupBeers(queries);
  return results.map(r => {
    if (r.found) return toSearchResult(r);
    return emptyResult(queries[0] ?? "Unknown");
  });
}

// ── Helpers ──

async function callLookup(...args: string[]): Promise<any> {
  try {
    const { stdout } = await execFileAsync(PYTHON, [LOOKUP_SCRIPT, ...args], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout.trim());
  } catch (err: any) {
    if (err.killed) {
      console.warn("[data-layer] lookup timed out");
      return { results: [] };
    }
    console.warn(`[data-layer] lookup failed: ${err.message}`);
    return { results: [] };
  }
}

function toSearchResult(r: BeerResult): SearchResult {
  return {
    id: String(r.id),
    name: r.name,
    brewery: r.brewery,
    style: r.style,
    abv: r.abv ?? 0,
    rating: r.rating,
    url: r.untappd_url ?? "",
    numRatings: r.ratings_count,
  };
}

function emptyResult(query: string): SearchResult {
  return {
    id: "",
    name: query,
    brewery: "",
    style: "",
    abv: 0,
    rating: 0,
    url: "",
  };
}

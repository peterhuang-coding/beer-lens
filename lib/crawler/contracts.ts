/**
 * lib/crawler/contracts.ts
 *
 * Shared TypeScript types from lib/crawler/CONTRACT.md.
 * All 4 agents (puppeteer / http / untappd / ratebeer / cli) must import from here.
 *
 * NOTE: do not modify — authoritative types live in CONTRACT.md.
 */

export type Source = "untappd" | "ratebeer";
export type CrawlMode = "live" | "dry-run" | "replay";

export interface BeerRecord {
  source: Source;
  source_id: string;            // untappd beer_id or ratebeer beer_id
  name: string;
  brewery_id: string | null;
  style: string | null;
  abv: number | null;
  ibu: number | null;
  rating: number | null;        // 0-5
  rating_count: number | null;
  description: string | null;
  labels: string[];              // tags
  food_pairing: string[];
  similar_ids: string[];
  url: string;
  fetched_at: string;            // ISO
}

export interface CrawlProgress {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  eta_seconds: number | null;
}

export interface CrawlOptions {
  source: Source;
  concurrency: number;          // default 2, hard cap 4
  limit: number | null;          // null = no limit
  dry_run: boolean;
  resume: boolean;
  tag: string | null;            // "china" | "craft" | null
  cookies: CookieRef[];          // dev-mode: file://refs
  retry_budget: number;          // default 5
  output_dir: string;            // "data/crawler/untappd" | "ratebeer"
}

export interface CookieRef {
  name: string;
  file: string;                  // local fixture path (NEVER prod)
  qps_per_cookie: number;        // default 1
}

export interface CrawlDriver {
  readonly mode: "puppeteer" | "http";
  fetchPage(url: string, opts: FetchOpts): Promise<PageSnapshot>;
  close(): Promise<void>;
}

export interface PageSnapshot {
  url: string;
  html: string;
  status: number;
  retry_after_ms: number | null;
}

export interface FetchOpts {
  cookie: CookieRef;
  jitter_ms: number;
  timeout_ms: number;
}

export interface BackoffPolicy {
  initial_ms: number;            // 1000
  max_ms: number;                // 60000
  multiplier: number;            // 2
  jitter_ratio: number;          // 0.3
}

/**
 * lib/crawler/contracts.ts
 *
 * Shared TypeScript types from lib/crawler/CONTRACT.md, plus CLI-side
 * error/state constants added by the CLI harness agent.
 *
 * NOTE: do not modify without updating CONTRACT.md first.
 */

// ── Core types (CONTRACT.md) ──────────────────────────────────────────────

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

// ── CLI extensions (added by CLI harness agent) ───────────────────────────

/** CLI-arg shape — narrow subset of CrawlOptions. */
export interface CliArgs {
  source: Source;
  concurrency: number;
  dry_run: boolean;
  limit: number | null;
  tag: string | null;
  resume: boolean;
  help: boolean;
}

/** Error category — used by error-aggregator.ts. */
export type CrawlErrorKind =
  | "http_4xx"
  | "http_5xx"
  | "timeout"
  | "parser"
  | "cookie_ban";

export interface CrawlError {
  kind: CrawlErrorKind;
  url: string;
  message: string;
  status?: number;
  ts: string;
}

export interface AggregatedErrors {
  groups: Record<CrawlErrorKind, CrawlError[]>;
  totals: Record<CrawlErrorKind, number>;
}

/** On-disk resume state — written by signal.ts on SIGINT/SIGTERM. */
export interface CrawlState {
  source: Source;
  started_at: string;
  updated_at: string;
  cursor: string | null;
  processed_ids: string[];
  failed_ids: string[];
  opts: {
    concurrency: number;
    limit: number | null;
    tag: string | null;
  };
}

export const MAX_CONCURRENCY = 4;
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_RETRY_BUDGET = 5;
export const STATE_FILENAME = ".state.json";
export const PROGRESS_TICK_MS = 200;
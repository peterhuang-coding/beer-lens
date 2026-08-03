/**
 * lib/crawler/contracts.ts
 *
 * Shared TypeScript types for the beer-lens crawler CLI harness.
 * Mirrors `lib/crawler/CONTRACT.md` (authoritative source of truth across agents).
 * All four crawler agents MUST keep these signatures identical.
 */

export type Source = "untappd" | "ratebeer";
export type CrawlMode = "live" | "dry-run" | "replay";

export interface BeerRecord {
  source: Source;
  source_id: string;
  name: string;
  brewery_id: string | null;
  style: string | null;
  abv: number | null;
  ibu: number | null;
  rating: number | null;
  rating_count: number | null;
  description: string | null;
  labels: string[];
  food_pairing: string[];
  similar_ids: string[];
  url: string;
  fetched_at: string;
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
  concurrency: number;
  limit: number | null;
  dry_run: boolean;
  resume: boolean;
  tag: string | null;
  cookies: CookieRef[];
  retry_budget: number;
  output_dir: string;
}

export interface CookieRef {
  name: string;
  file: string;
  qps_per_cookie: number;
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
  initial_ms: number;
  max_ms: number;
  multiplier: number;
  jitter_ratio: number;
}

/** CliArgs — raw argv shape produced by parseArgs(). */
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

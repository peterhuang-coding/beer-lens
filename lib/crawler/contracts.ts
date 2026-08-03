export type Source = "untappd" | "ratebeer";
export type CrawlMode = "live" | "dry-run" | "replay";
export interface BeerRecord { source: Source; source_id: string; name: string; brewery_id: string | null; style: string | null; abv: number | null; ibu: number | null; rating: number | null; rating_count: number | null; description: string | null; labels: string[]; food_pairing: string[]; similar_ids: string[]; url: string; fetched_at: string; }
export interface CrawlProgress { total: number; done: number; failed: number; skipped: number; eta_seconds: number | null; }
export interface CrawlOptions { source: Source; concurrency: number; limit: number | null; dry_run: boolean; resume: boolean; tag: string | null; cookies: CookieRef[]; retry_budget: number; output_dir: string; }
export interface CookieRef { name: string; file: string; qps_per_cookie: number; }
export interface CrawlDriver { readonly mode: "puppeteer" | "http"; fetchPage(url: string, opts: FetchOpts): Promise<PageSnapshot>; close(): Promise<void>; }
export interface PageSnapshot { url: string; html: string; status: number; retry_after_ms: number | null; }
export interface FetchOpts { cookie: CookieRef; jitter_ms: number; timeout_ms: number; }
export interface BackoffPolicy { initial_ms: number; max_ms: number; multiplier: number; jitter_ratio: number; }

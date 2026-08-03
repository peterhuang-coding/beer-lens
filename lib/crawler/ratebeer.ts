/**
 * RateBeer crawler (China-only).
 *
 * Goal G-20260804-beer-lens-crawler-harness-98566.
 *
 *   - Discovers:  /beer/country/46/  (46 = China)
 *   - Extracts:   rating / style / ABV / brewery / number-of-ratings
 *   - Streams:    AsyncIterable<BeerRecord>
 *   - Respects:   concurrency (default 2, hard cap 4) / limit / dry_run
 *   - Fails-soft: a single detail-page error is logged and skipped
 *
 * Tests inject a fake `Fetcher` (or, more conveniently, a list+detail
 * fixture map) via the constructor so we never need real network. The
 * "live" code path is the same shape — swap the fake for an HTTP
 * driver that obeys the contract in lib/crawler/contracts.ts.
 */
import type { BeerRecord, CrawlOptions, PageSnapshot } from "./contracts.ts";
import {
  RATEBEER_CHINA_LIST_URL,
  RATEBEER_DEFAULT_CONCURRENCY,
  RATEBEER_MAX_CONCURRENCY,
} from "./ratebeer-selectors.ts";
import {
  parseRatebeerDetail,
  parseRatebeerList,
  type RatebeerListEntry,
} from "./ratebeer-parser.ts";

// Re-export parser entry points so the test (and the CLI) can import
// them from a single module without reaching into ratebeer-parser.ts.
export { parseRatebeerList, parseRatebeerDetail };
export type { RatebeerListEntry } from "./ratebeer-parser.ts";

/** Minimal fetcher surface — anything that can hand us HTML. */
export interface RatebeerFetcher {
  fetch(url: string): Promise<PageSnapshot>;
}

/** Default fetcher throws; production wires an HTTP driver here. */
class DefaultThrowFetcher implements RatebeerFetcher {
  fetch(_url: string): Promise<PageSnapshot> {
    return Promise.reject(
      new Error(
        "RatebeerCrawler: no fetcher supplied. Pass a fixture-based " +
          "fetcher in tests, or wire an HTTP driver in production. " +
          "Real RateBeer requests are forbidden under the harness.",
      ),
    );
  }
}

const HARD_CONCURRENCY_CAP = RATEBEER_MAX_CONCURRENCY; // 4

/**
 * Clamp a user-supplied concurrency value into the [1, 4] band and
 * fall back to the default when invalid.
 */
export function normaliseConcurrency(value: number | undefined): number {
  const fallback = RATEBEER_DEFAULT_CONCURRENCY;
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return fallback;
  }
  const n = Math.trunc(value);
  if (n < 1) return 1;
  if (n > HARD_CONCURRENCY_CAP) return HARD_CONCURRENCY_CAP;
  return n;
}

/** Thrown when the caller asks for an unsupported source. */
export class UnsupportedSourceError extends Error {
  constructor(source: string) {
    super(
      `RatebeerCrawler only handles source="ratebeer"; got "${source}"`,
    );
    this.name = "UnsupportedSourceError";
  }
}

/** Public surface of the ratebeer module. */
export interface RatebeerCrawlerOptions {
  /** Inject a fixture-based fetcher (tests, dev-mode replay). */
  fetcher?: RatebeerFetcher;
  /** Override the list URL — useful when replaying a paginated archive. */
  listUrl?: string;
  /** Capture the failure log for assertions in tests. */
  onError?: (err: unknown, context: { stage: "list" | "detail"; url: string }) => void;
}

export class RatebeerCrawler {
  private readonly fetcher: RatebeerFetcher;
  private readonly listUrl: string;
  private readonly onError:
    | ((err: unknown, context: { stage: "list" | "detail"; url: string }) => void)
    | undefined;

  constructor(opts: RatebeerCrawlerOptions = {}) {
    this.fetcher = opts.fetcher ?? new DefaultThrowFetcher();
    this.listUrl = opts.listUrl ?? RATEBEER_CHINA_LIST_URL;
    this.onError = opts.onError;
  }

  /**
   * The headline entry point. Yields parsed BeerRecord values, one per
   * detail page, in (approximately) the order they appeared on the
   * list page. The iterator is single-pass.
   */
  async *crawl(opts: CrawlOptions): AsyncIterable<BeerRecord> {
    if (opts.source !== "ratebeer") {
      throw new UnsupportedSourceError(opts.source);
    }

    const concurrency = normaliseConcurrency(opts.concurrency);
    const limit = opts.limit ?? null;

    // ── Stage 1: fetch the list page ───────────────────────────────
    let listSnapshot: PageSnapshot;
    try {
      listSnapshot = await this.fetcher.fetch(this.listUrl);
    } catch (err) {
      this.fail(err, { stage: "list", url: this.listUrl });
      return; // can't continue without the list
    }
    const entries: RatebeerListEntry[] = parseRatebeerList(listSnapshot.html);

    // Apply the --limit cap (no other filter makes sense for ratebeer
    // since the list URL already filters by country=46=China).
    const bounded = limit === null ? entries : entries.slice(0, limit);

    // ── Stage 2: bounded-parallel detail fetch + parse ────────────
    yield* this.streamDetails(bounded, concurrency, opts);
  }

  /** Bounded-parallel detail fetcher. Fails-soft per record. */
  private async *streamDetails(
    entries: RatebeerListEntry[],
    concurrency: number,
    _opts: CrawlOptions,
  ): AsyncIterable<BeerRecord> {
    if (entries.length === 0) return;

    // We keep an index cursor + N workers. Each worker advances
    // cursor++ and yields the parsed record into a shared output
    // buffer. A supervisor pulls in arrival order so output stays
    // roughly stable for the consumer.
    let cursor = 0;
    let failed = 0;

    const queue: Array<{ index: number; record: BeerRecord | null; err: unknown | null }> = [];
    let nextExpected = 0;
    const resolvers: Array<() => void> = [];

    const take = async (): Promise<void> => {
      while (cursor < entries.length) {
        const myIndex = cursor++;
        const entry = entries[myIndex]!;
        try {
          if (_opts.dry_run) {
            // dry-run never hits the network — synthesise a stub
            const rec = this.buildDryRunRecord(entry);
            queue.push({ index: myIndex, record: rec, err: null });
          } else {
            const snap = await this.fetcher.fetch(entry.url);
            const partial = parseRatebeerDetail(snap.html, entry);
            const rec: BeerRecord = {
              source: "ratebeer",
              source_id: entry.source_id,
              url: entry.url,
              fetched_at: new Date().toISOString(),
              ...partial,
            };
            queue.push({ index: myIndex, record: rec, err: null });
          }
        } catch (err) {
          failed++;
          this.fail(err, { stage: "detail", url: entry.url });
          queue.push({ index: myIndex, record: null, err });
        }
        // Wake the consumer if it's waiting for *this* index.
        if (queue.find((q) => q.index === nextExpected)) {
          const r = resolvers.shift();
          if (r) r();
        }
      }
    };

    // Spawn up to `concurrency` workers.
    const workers: Array<Promise<void>> = [];
    const workerCount = Math.min(concurrency, entries.length);
    for (let i = 0; i < workerCount; i++) {
      workers.push(take());
    }

    // Consumer: pull in arrival order (by index).
    let pulled = 0;
    while (pulled < entries.length) {
      while (!queue.find((q) => q.index === nextExpected)) {
        await new Promise<void>((resolve) => resolvers.push(resolve));
      }
      const item = queue.shift()!;
      nextExpected++;
      pulled++;
      if (item.record !== null) {
        yield item.record;
      }
    }

    await Promise.all(workers);
    // `failed` is exposed for the runner; nothing to do with it here
    // (single record failures don't abort the stream by design).
    void failed;
  }

  /** Synthesise a record for dry-run without ever touching the network. */
  private buildDryRunRecord(entry: RatebeerListEntry): BeerRecord {
    return {
      source: "ratebeer",
      source_id: entry.source_id,
      name: entry.name,
      brewery_id: null,
      style: null,
      abv: null,
      ibu: null,
      rating: null,
      rating_count: null,
      description: null,
      labels: [],
      food_pairing: [],
      similar_ids: [],
      url: entry.url,
      fetched_at: new Date().toISOString(),
    };
  }

  private fail(
    err: unknown,
    context: { stage: "list" | "detail"; url: string },
  ): void {
    if (this.onError) {
      try {
        this.onError(err, context);
      } catch {
        // never let the error hook itself kill the crawl
      }
    }
  }
}

/* ── module-level exports for the CLI / runner ─────────────────── */
export {
  RATEBEER_CHINA_LIST_URL,
  RATEBEER_MAX_CONCURRENCY,
  RATEBEER_DEFAULT_CONCURRENCY,
};

/** Aggregated export object for the CLI / runner. */
export const RATEBEER_PUBLIC_API = {
  RatebeerCrawler,
  RATEBEER_CHINA_LIST_URL,
  RATEBEER_MAX_CONCURRENCY,
  RATEBEER_DEFAULT_CONCURRENCY,
  normaliseConcurrency,
  parseRatebeerList,
  parseRatebeerDetail,
  UnsupportedSourceError,
} as const;

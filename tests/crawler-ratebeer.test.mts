/**
 * RateBeer crawler — unit tests.
 *
 * Coverage targets (≥5 cases per harness contract):
 *   1. List-page parser (5 entries, Chinese names UTF-8 round-trip)
 *   2. Detail-page parser (numeric ABV, rating, brewery id)
 *   3. Concurrency / limit clamping
 *   4. Dry-run path never calls the network fetcher
 *   5. Single-record failure does not abort the stream
 *   6. AsyncIterable respects --limit (record count)
 *   7. Chinese brewery name round-trips through the parser (UTF-8 sanity)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  RATEBEER_MAX_CONCURRENCY,
  RATEBEER_DEFAULT_CONCURRENCY,
  RatebeerCrawler,
  UnsupportedSourceError,
  normaliseConcurrency,
  parseRatebeerDetail,
  parseRatebeerList,
} from "../lib/crawler/ratebeer.ts";
import type {
  BeerRecord,
  CrawlOptions,
  PageSnapshot,
} from "../lib/crawler/contracts.ts";
import type { RatebeerFetcher } from "../lib/crawler/ratebeer.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "data", "crawler", "_fixtures");
const LIST_HTML = readFileSync(join(FIXTURE_DIR, "ratebeer-cn-list.html"), "utf8");
const DETAIL_HTML = readFileSync(join(FIXTURE_DIR, "ratebeer-detail-cn.html"), "utf8");

/** Tiny in-memory fetcher: url → html. */
class FixtureFetcher implements RatebeerFetcher {
  readonly calls: string[] = [];
  pages: Record<string, string>;
  failOn: Set<string>;
  constructor(
    pages: Record<string, string>,
    failOn: Set<string> = new Set(),
  ) {
    this.pages = pages;
    this.failOn = failOn;
  }
  async fetch(url: string): Promise<PageSnapshot> {
    this.calls.push(url);
    if (this.failOn.has(url)) {
      throw new Error(`forced failure for ${url}`);
    }
    const html = this.pages[url];
    if (html === undefined) {
      throw new Error(`no fixture for ${url}`);
    }
    return { url, html, status: 200, retry_after_ms: null };
  }
}

/** Build a default CrawlOptions for the ratebeer source. */
function opts(overrides: Partial<CrawlOptions> = {}): CrawlOptions {
  return {
    source: "ratebeer",
    concurrency: RATEBEER_DEFAULT_CONCURRENCY,
    limit: null,
    dry_run: false,
    resume: false,
    tag: "china",
    cookies: [],
    retry_budget: 5,
    output_dir: "data/crawler/ratebeer",
    ...overrides,
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("ratebeer list parser", () => {
  it("extracts all 5 list entries with Chinese UTF-8 names", () => {
    const entries = parseRatebeerList(LIST_HTML);
    assert.equal(entries.length, 5, "expected 5 list entries");
    const ids = entries.map((e) => e.source_id);
    assert.deepEqual(
      ids,
      ["123456", "234567", "345678", "456789", "567890"],
    );
    // UTF-8 round-trip — at least one entry contains Chinese chars
    const hasChinese = entries.some((e) => /[一-鿿]/.test(e.name));
    assert.ok(hasChinese, "expected at least one Chinese beer name");
    // Concrete Chinese names present
    assert.ok(entries[0]!.name.includes("熊猫精酿"));
    assert.ok(entries[1]!.name.includes("京A"));
  });

  it("builds absolute URLs from relative hrefs", () => {
    const entries = parseRatebeerList(LIST_HTML);
    for (const e of entries) {
      assert.ok(
        e.url.startsWith("https://www.ratebeer.com/beer/"),
        `bad url: ${e.url}`,
      );
    }
  });
});

describe("ratebeer detail parser", () => {
  it("extracts rating, ABV, style, brewery_id with numeric conversion", () => {
    const entries = parseRatebeerList(LIST_HTML);
    const panda = entries.find((e) => e.source_id === "123456")!;
    const detail = parseRatebeerDetail(DETAIL_HTML, panda);
    assert.equal(detail.name, "熊猫精酿 功夫 IPA");
    assert.equal(detail.rating, 3.62, "rating should be a JS number");
    assert.equal(detail.rating_count, 1847, "rating count strips commas");
    assert.equal(detail.abv, 6.5, "ABV should be a JS number");
    assert.equal(detail.style, "India Pale Ale (IPA)");
    assert.equal(detail.brewery_id, "789");
    // UTF-8 round-trip for the brewery label
    assert.ok(detail.labels.includes("熊猫精酿"));
  });

  it("returns nulls when key fields are missing", () => {
    const entries = parseRatebeerList(LIST_HTML);
    const panda = entries.find((e) => e.source_id === "123456")!;
    const bare = "<html><body><h1>Empty</h1></body></html>";
    const detail = parseRatebeerDetail(bare, panda);
    assert.equal(detail.rating, null);
    assert.equal(detail.abv, null);
    assert.equal(detail.rating_count, null);
    assert.equal(detail.style, null);
    assert.equal(detail.brewery_id, null);
  });
});

describe("ratebeer concurrency / limit", () => {
  it("normaliseConcurrency caps at 4 (hard ceiling)", () => {
    assert.equal(normaliseConcurrency(99), RATEBEER_MAX_CONCURRENCY);
    assert.equal(normaliseConcurrency(RATEBEER_MAX_CONCURRENCY + 1), RATEBEER_MAX_CONCURRENCY);
  });

  it("normaliseConcurrency falls back to default on bad input", () => {
    assert.equal(normaliseConcurrency(undefined), RATEBEER_DEFAULT_CONCURRENCY);
    assert.equal(normaliseConcurrency(0), 1, "0 should clamp up to 1");
    assert.equal(normaliseConcurrency(-3), 1);
    assert.equal(normaliseConcurrency(Number.NaN), RATEBEER_DEFAULT_CONCURRENCY);
  });

  it("limit truncates the record stream to N records", async () => {
    const fetcher = new FixtureFetcher({
      "https://www.ratebeer.com/beer/country/46/": LIST_HTML,
      ...Object.fromEntries(
        parseRatebeerList(LIST_HTML).map((e) => [e.url, DETAIL_HTML]),
      ),
    });
    const crawler = new RatebeerCrawler({ fetcher });
    const recs = await collect(crawler.crawl(opts({ limit: 2, concurrency: 4 })));
    assert.equal(recs.length, 2);
    // Both records should be real (not dry-run stubs)
    for (const r of recs) {
      assert.equal(r.source, "ratebeer");
      assert.equal(typeof r.rating, "number");
      assert.equal(typeof r.abv, "number");
    }
  });
});

describe("ratebeer dry-run", () => {
  it("never calls the fetcher for detail pages", async () => {
    const listUrl = "https://www.ratebeer.com/beer/country/46/";
    const fetcher = new FixtureFetcher({ [listUrl]: LIST_HTML });
    const crawler = new RatebeerCrawler({ fetcher });
    const recs = await collect(
      crawler.crawl(opts({ dry_run: true, limit: 5, concurrency: 2 })),
    );
    // dry-run: only the list page is fetched; detail pages are skipped
    assert.deepEqual(fetcher.calls, [listUrl]);
    assert.equal(recs.length, 5);
    // Stubs carry the parsed list name but null detail fields
    for (const r of recs) {
      assert.equal(r.rating, null);
      assert.equal(r.abv, null);
      assert.equal(r.brewery_id, null);
    }
  });
});

describe("ratebeer resilience", () => {
  it("continues the stream when a single detail fetch fails", async () => {
    const listUrl = "https://www.ratebeer.com/beer/country/46/";
    const entries = parseRatebeerList(LIST_HTML);
    const failOn = new Set([entries[1]!.url]); // poison one record
    const fetcher = new FixtureFetcher(
      {
        [listUrl]: LIST_HTML,
        ...Object.fromEntries(entries.map((e) => [e.url, DETAIL_HTML])),
      },
      failOn,
    );
    const errors: Array<{ stage: string; url: string }> = [];
    const crawler = new RatebeerCrawler({
      fetcher,
      onError: (_e, ctx) => errors.push(ctx),
    });
    const recs = await collect(crawler.crawl(opts({ concurrency: 1 })));
    // 5 list entries minus 1 poisoned = 4 records
    assert.equal(recs.length, 4);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.stage, "detail");
    assert.equal(errors[0]!.url, entries[1]!.url);
  });

  it("rejects an unsupported source", async () => {
    const fetcher = new FixtureFetcher({});
    const crawler = new RatebeerCrawler({ fetcher });
    await assert.rejects(
      async () => {
        for await (const _ of crawler.crawl(opts({ source: "untappd" }))) {
          // should not get here
        }
      },
      (err: unknown) => err instanceof UnsupportedSourceError,
    );
  });

  it("emits UTF-8 brewery name end-to-end (round-trip through parser)", async () => {
    const listUrl = "https://www.ratebeer.com/beer/country/46/";
    const fetcher = new FixtureFetcher({
      [listUrl]: LIST_HTML,
      "https://www.ratebeer.com/beer/panda-ipa/123456/": DETAIL_HTML,
    });
    const crawler = new RatebeerCrawler({ fetcher });
    const recs = await collect(
      crawler.crawl(opts({ limit: 1, concurrency: 1 })),
    );
    const rec: BeerRecord = recs[0]!;
    // brewery id is the 789 from the fixture
    assert.equal(rec.brewery_id, "789");
    // the brewery name lives in the labels array
    assert.ok(
      rec.labels.includes("熊猫精酿"),
      `expected 熊猫精酿 in labels, got ${JSON.stringify(rec.labels)}`,
    );
  });
});

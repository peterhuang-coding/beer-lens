import { createHash } from "node:crypto";

import { HtmlHashCache } from "./cache.ts";
import type { BeerRecord } from "./contracts.ts";
import { LlmExtractor } from "./llm-extractor.ts";
import { ParseFailureLog } from "./parse-failure-log.ts";

const BEER_RECORD_FIELDS = [
  "source",
  "source_id",
  "name",
  "brewery_id",
  "style",
  "abv",
  "ibu",
  "rating",
  "rating_count",
  "description",
  "labels",
  "food_pairing",
  "similar_ids",
  "url",
  "fetched_at",
] as const satisfies ReadonlyArray<keyof BeerRecord>;

export interface ExtractorRouterOptions {
  primary: (html: string) => Promise<BeerRecord>;
  fallback: LlmExtractor;
  cache: HtmlHashCache;
  failureLog: ParseFailureLog;
  threshold?: number;
}

function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return true;
}

function fillRate(record: BeerRecord): number {
  const filled = BEER_RECORD_FIELDS.reduce(
    (count, field) => count + (isFilled(record[field]) ? 1 : 0),
    0,
  );
  return filled / BEER_RECORD_FIELDS.length;
}

function sha256(html: string): string {
  return createHash("sha256").update(html).digest("hex");
}

/** Route sparse or failed static extraction through the LLM fallback. */
export class ExtractorRouter {
  readonly #primary: (html: string) => Promise<BeerRecord>;
  readonly #fallback: LlmExtractor;
  readonly #cache: HtmlHashCache;
  readonly #failureLog: ParseFailureLog;
  readonly #threshold: number;

  constructor(opts: ExtractorRouterOptions) {
    const threshold = opts.threshold ?? 0.5;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError("threshold must be between 0 and 1");
    }

    this.#primary = opts.primary;
    this.#fallback = opts.fallback;
    this.#cache = opts.cache;
    this.#failureLog = opts.failureLog;
    this.#threshold = threshold;
  }

  async extract(html: string, url: string): Promise<BeerRecord> {
    const cached = await this.#cache.get(html);
    if (cached !== null) return cached;

    try {
      const primaryRecord = await this.#primary(html);
      if (fillRate(primaryRecord) >= this.#threshold) return primaryRecord;
    } catch {
      // A static parser exception is another fallback trigger.
    }

    try {
      const fallbackRecord = await this.#fallback.extract(html);
      await this.#cache.set(html, fallbackRecord);
      return fallbackRecord;
    } catch (error) {
      await this.#failureLog.record({
        url,
        html_hash: sha256(html),
        reason: "LLM fallback failed",
      });
      throw error;
    }
  }
}

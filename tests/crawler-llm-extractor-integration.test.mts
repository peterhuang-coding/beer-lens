import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { HtmlHashCache } from "../lib/crawler/cache.ts";
import type { BeerRecord } from "../lib/crawler/contracts.ts";
import { ExtractorRouter } from "../lib/crawler/extractor-router.ts";
import { LlmExtractor } from "../lib/crawler/llm-extractor.ts";
import { ParseFailureLog } from "../lib/crawler/parse-failure-log.ts";
import { parseDetail } from "../lib/crawler/untappd-parser.ts";

const FIXTURE_PATH = new URL(
  "../data/crawler/_fixtures/untappd-detail-info.html",
  import.meta.url,
);

const LLM_RECORD: BeerRecord = {
  source: "untappd",
  source_id: "fixture-123",
  name: "Fixture Beer",
  brewery_id: "brewery-1",
  style: "IPA",
  abv: 5.5,
  ibu: 40,
  rating: 4.2,
  rating_count: 120,
  description: "A public fixture beer.",
  labels: ["Hoppy"],
  food_pairing: ["Pizza"],
  similar_ids: ["99"],
  url: "https://untappd.com/beer/fixture-123",
  fetched_at: "2026-08-06T00:00:00.000Z",
};

test("fixture HTML routes through LLM once and then hits the hash cache", async () => {
  const html = await fs.readFile(FIXTURE_PATH, "utf8");
  const temp = await fs.mkdtemp(path.join(tmpdir(), "llm-integration-"));
  let fetchCalls = 0;
  let primaryCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(LLM_RECORD) }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;

  try {
    const entry = {
      source_id: "fixture-123",
      name: "Fixture Beer",
      url: LLM_RECORD.url,
    };
    const router = new ExtractorRouter({
      primary: async (sourceHtml) => {
        primaryCalls += 1;
        return parseDetail(sourceHtml, entry);
      },
      fallback: new LlmExtractor({
        apiKey: "fake-test-key",
        baseUrl: "https://llm.test",
        timeoutMs: 100,
        maxRetries: 0,
      }),
      cache: new HtmlHashCache({ dir: path.join(temp, "cache") }),
      failureLog: new ParseFailureLog(path.join(temp, "failures.jsonl")),
      threshold: 1,
    });

    const first = await router.extract(html, LLM_RECORD.url);
    const second = await router.extract(html, LLM_RECORD.url);
    assert.deepEqual(first, LLM_RECORD);
    assert.deepEqual(second, LLM_RECORD);
    assert.equal(fetchCalls, 1, "the second call must make zero fetches");
    assert.equal(primaryCalls, 1, "the second call must return before primary");
  } finally {
    globalThis.fetch = previousFetch;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import type { BeerRecord } from "../lib/crawler/contracts.ts";
import { HtmlHashCache } from "../lib/crawler/cache.ts";
import { ExtractorRouter } from "../lib/crawler/extractor-router.ts";
import {
  LlmExtractError,
  LlmExtractor,
} from "../lib/crawler/llm-extractor.ts";
import { ParseFailureLog } from "../lib/crawler/parse-failure-log.ts";
import {
  BeerRecordValidationError,
  validateBeerRecord,
} from "../lib/crawler/validate-beer-record.ts";

const VALID_RECORD: BeerRecord = {
  source: "untappd",
  source_id: "fixture-beer",
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
  url: "https://untappd.com/beer/fixture-beer",
  fetched_at: "2026-08-06T00:00:00.000Z",
};

const SPARSE_RECORD: BeerRecord = {
  source: "untappd",
  source_id: "fixture-beer",
  name: "Fixture Beer",
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
  url: "https://untappd.com/beer/fixture-beer",
  fetched_at: "2026-08-06T00:00:00.000Z",
};

type FetchMock = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function responseFor(record: BeerRecord, status = 200): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(record) }],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function responseWithText(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text }] }),
    { status, headers: { "content-type": "application/json" } },
  );
}

async function withFetch<T>(mock: FetchMock, fn: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = mock as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previous;
  }
}

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), `${prefix}-`));
}

function cacheFile(dir: string, html: string): string {
  const hash = createHash("sha256").update(html).digest("hex");
  return path.join(dir, `${hash}.json`);
}

test("validateBeerRecord accepts a complete BeerRecord", () => {
  assert.deepEqual(validateBeerRecord(VALID_RECORD), VALID_RECORD);
});

test("validateBeerRecord reports a missing required field", () => {
  const { name: _name, ...missingName } = VALID_RECORD;
  assert.throws(
    () => validateBeerRecord(missingName),
    (error: unknown) =>
      error instanceof BeerRecordValidationError &&
      error.field === "name" &&
      error.message.includes("name"),
  );
});

test("validateBeerRecord reports a field type error", () => {
  const invalid = { ...VALID_RECORD, abv: "5.5" };
  assert.throws(
    () => validateBeerRecord(invalid),
    (error: unknown) =>
      error instanceof BeerRecordValidationError && error.field === "abv",
  );
});

test("validateBeerRecord rejects an empty array", () => {
  const invalid = { ...VALID_RECORD, labels: [] };
  assert.throws(
    () => validateBeerRecord(invalid),
    (error: unknown) =>
      error instanceof BeerRecordValidationError && error.field === "labels",
  );
});

test("LlmExtractor sends an Anthropic-compatible request and parses JSON", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  await withFetch(
    async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return responseFor(VALID_RECORD);
    },
    async () => {
      const extractor = new LlmExtractor({
        apiKey: "fake-test-key",
        baseUrl: "https://llm.test/anthropic/",
        model: "MiniMax-M3-test",
        timeoutMs: 100,
        maxRetries: 0,
      });
      const result = await extractor.extract("<html>fixture</html>");
      assert.deepEqual(result, VALID_RECORD);
    },
  );
  assert.equal(requestUrl, "https://llm.test/anthropic/v1/messages");
  assert.equal(requestInit?.method, "POST");
  assert.equal(new Headers(requestInit?.headers).get("x-api-key"), "fake-test-key");
  const body = JSON.parse(String(requestInit?.body)) as {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(body.model, "MiniMax-M3-test");
  assert.equal(body.max_tokens, 1024);
  assert.match(body.system, /只输出 JSON，无任何解释文字/);
  assert.deepEqual(JSON.parse(body.messages[0]!.content), {
    html: "<html>fixture</html>",
  });
});

test("LlmExtractor retries one failed HTTP response then throws", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return responseWithText("unavailable", 503);
    },
    async () => {
      const extractor = new LlmExtractor({
        apiKey: "fake-test-key",
        baseUrl: "https://llm.test",
        timeoutMs: 100,
      });
      await assert.rejects(
        () => extractor.extract("same-html"),
        (error: unknown) =>
          error instanceof LlmExtractError && error.attempts === 2,
      );
    },
  );
  assert.equal(calls, 2);
});

test("LlmExtractor retries malformed JSON and succeeds", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return calls === 1 ? responseWithText("not-json") : responseFor(VALID_RECORD);
    },
    async () => {
      const extractor = new LlmExtractor({
        apiKey: "fake-test-key",
        baseUrl: "https://llm.test",
        timeoutMs: 100,
      });
      assert.deepEqual(await extractor.extract("retry-html"), VALID_RECORD);
    },
  );
  assert.equal(calls, 2);
});

test("LlmExtractor converts timeout into LlmExtractError without hanging", async () => {
  await withFetch(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }),
    async () => {
      const extractor = new LlmExtractor({
        apiKey: "fake-test-key",
        baseUrl: "https://llm.test",
        timeoutMs: 10,
        maxRetries: 0,
      });
      await assert.rejects(
        () => extractor.extract("timeout-html"),
        (error: unknown) => error instanceof LlmExtractError,
      );
    },
  );
});

test("LlmExtractor retries a validation failure and exposes no response body", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return responseFor({ ...VALID_RECORD, labels: [] });
    },
    async () => {
      const extractor = new LlmExtractor({
        apiKey: "fake-test-key",
        baseUrl: "https://llm.test",
        timeoutMs: 100,
      });
      await assert.rejects(
        () => extractor.extract("invalid-record-html"),
        (error: unknown) =>
          error instanceof LlmExtractError &&
          error.cause instanceof BeerRecordValidationError,
      );
    },
  );
  assert.equal(calls, 2);
});

test("LlmExtractor.extractMany preserves order and limits concurrency to two", async () => {
  let active = 0;
  let maximumActive = 0;
  const htmls = ["one", "two", "three", "four"];
  await withFetch(
    async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      const userPayload = JSON.parse(request.messages[0]!.content) as {
        html: string;
      };
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return userPayload.html === "three"
        ? responseWithText("bad", 500)
        : responseFor(VALID_RECORD);
    },
    async () => {
      const extractor = new LlmExtractor({
        apiKey: "fake-test-key",
        baseUrl: "https://llm.test",
        timeoutMs: 100,
        maxRetries: 0,
      });
      const results = await extractor.extractMany(htmls);
      assert.equal(results.length, htmls.length);
      assert.deepEqual(results[0], VALID_RECORD);
      assert.deepEqual(results[1], VALID_RECORD);
      assert.ok("error" in results[2]!);
      assert.deepEqual(results[3], VALID_RECORD);
    },
  );
  assert.equal(maximumActive, 2);
});

test("HtmlHashCache stores and returns a successful record", async () => {
  const dir = await makeTempDir("llm-cache-hit");
  try {
    const cache = new HtmlHashCache({ dir });
    await cache.set("cache-html", VALID_RECORD);
    assert.deepEqual(await cache.get("cache-html"), VALID_RECORD);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HtmlHashCache lazily removes expired files during an unrelated get", async () => {
  const dir = await makeTempDir("llm-cache-expiry");
  const oldHtml = "old-cache-html";
  try {
    const cache = new HtmlHashCache({ dir, ttlDays: 7 });
    await cache.set(oldHtml, VALID_RECORD);
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(cacheFile(dir, oldHtml), oldTime, oldTime);
    assert.equal(await cache.get("different-html"), null);
    await assert.rejects(fs.access(cacheFile(dir, oldHtml)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HtmlHashCache does not write an invalid or failed record", async () => {
  const dir = await makeTempDir("llm-cache-failure");
  try {
    const cache = new HtmlHashCache({ dir });
    await assert.rejects(
      () => cache.set("failed-html", { ...VALID_RECORD, labels: [] }),
      (error: unknown) => error instanceof BeerRecordValidationError,
    );
    assert.equal(await cache.get("failed-html"), null);
    await assert.rejects(fs.access(cacheFile(dir, "failed-html")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ParseFailureLog writes one JSONL line without raw HTML", async () => {
  const dir = await makeTempDir("failure-log-one");
  const filePath = path.join(dir, "nested", "parse-failures.jsonl");
  try {
    const log = new ParseFailureLog(filePath);
    await log.record({
      url: "https://example.test/beer/1",
      html_hash: "a".repeat(64),
      reason: "LLM fallback failed",
      ts: "2026-08-06T00:00:00.000Z",
      ...( { html: "<secret fixture HTML>" } as Record<string, string>),
    } as unknown as Parameters<ParseFailureLog["record"]>[0]);
    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(entry.url, "https://example.test/beer/1");
    assert.equal(entry.html_hash, "a".repeat(64));
    assert.equal(entry.ts, "2026-08-06T00:00:00.000Z");
    assert.equal("html" in entry, false);
    assert.equal(lines[0]!.includes("<secret fixture HTML>"), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ParseFailureLog appends multiple independent lines", async () => {
  const dir = await makeTempDir("failure-log-many");
  const filePath = path.join(dir, "parse-failures.jsonl");
  try {
    const log = new ParseFailureLog(filePath);
    await log.record({ url: "https://example.test/1", html_hash: "1", reason: "one" });
    await log.record({ url: "https://example.test/2", html_hash: "2", reason: "two" });
    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal((JSON.parse(lines[0]!) as { reason: string }).reason, "one");
    assert.equal((JSON.parse(lines[1]!) as { reason: string }).reason, "two");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ExtractorRouter returns a dense primary result without calling fallback", async () => {
  const dir = await makeTempDir("router-primary");
  let primaryCalls = 0;
  try {
    const cache = new HtmlHashCache({ dir: path.join(dir, "cache") });
    const log = new ParseFailureLog(path.join(dir, "failures.jsonl"));
    const fallback = new LlmExtractor({
      apiKey: "fake-test-key",
      baseUrl: "https://llm.test",
      timeoutMs: 100,
      maxRetries: 0,
    });
    await withFetch(
      async () => {
        throw new Error("fallback must not be called");
      },
      async () => {
        const router = new ExtractorRouter({
          primary: async () => {
            primaryCalls += 1;
            return VALID_RECORD;
          },
          fallback,
          cache,
          failureLog: log,
        });
        assert.deepEqual(await router.extract("dense-html", VALID_RECORD.url), VALID_RECORD);
      },
    );
    assert.equal(primaryCalls, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ExtractorRouter sends a sparse primary result to fallback and caches it", async () => {
  const dir = await makeTempDir("router-fallback");
  let fetchCalls = 0;
  try {
    const cache = new HtmlHashCache({ dir: path.join(dir, "cache") });
    const log = new ParseFailureLog(path.join(dir, "failures.jsonl"));
    const fallback = new LlmExtractor({
      apiKey: "fake-test-key",
      baseUrl: "https://llm.test",
      timeoutMs: 100,
      maxRetries: 0,
    });
    await withFetch(
      async () => {
        fetchCalls += 1;
        return responseFor(VALID_RECORD);
      },
      async () => {
        const router = new ExtractorRouter({
          primary: async () => SPARSE_RECORD,
          fallback,
          cache,
          failureLog: log,
        });
        assert.deepEqual(await router.extract("sparse-html", VALID_RECORD.url), VALID_RECORD);
      },
    );
    assert.equal(fetchCalls, 1);
    assert.deepEqual(await cache.get("sparse-html"), VALID_RECORD);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ExtractorRouter falls back when the primary parser throws", async () => {
  const dir = await makeTempDir("router-primary-error");
  try {
    const cache = new HtmlHashCache({ dir: path.join(dir, "cache") });
    const log = new ParseFailureLog(path.join(dir, "failures.jsonl"));
    const fallback = new LlmExtractor({
      apiKey: "fake-test-key",
      baseUrl: "https://llm.test",
      timeoutMs: 100,
      maxRetries: 0,
    });
    await withFetch(async () => responseFor(VALID_RECORD), async () => {
      const router = new ExtractorRouter({
        primary: async () => {
          throw new Error("static parser failed");
        },
        fallback,
        cache,
        failureLog: log,
      });
      assert.deepEqual(await router.extract("primary-error-html", VALID_RECORD.url), VALID_RECORD);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ExtractorRouter logs fallback failure by hash and never stores HTML", async () => {
  const dir = await makeTempDir("router-failure");
  const html = "<div>private-fixture-marker</div>";
  const logPath = path.join(dir, "failures.jsonl");
  try {
    const cache = new HtmlHashCache({ dir: path.join(dir, "cache") });
    const log = new ParseFailureLog(logPath);
    const fallback = new LlmExtractor({
      apiKey: "fake-test-key",
      baseUrl: "https://llm.test",
      timeoutMs: 100,
      maxRetries: 0,
    });
    await withFetch(async () => responseWithText("failure", 500), async () => {
      const router = new ExtractorRouter({
        primary: async () => SPARSE_RECORD,
        fallback,
        cache,
        failureLog: log,
      });
      await assert.rejects(() => router.extract(html, "https://example.test/failing"));
    });
    const rawLog = await fs.readFile(logPath, "utf8");
    assert.equal(rawLog.includes(html), false);
    assert.match(rawLog, new RegExp(createHash("sha256").update(html).digest("hex")));
    assert.equal(await cache.get(html), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

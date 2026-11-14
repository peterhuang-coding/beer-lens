/**
 * Offline DeepSeek provider contract tests.
 *
 * All credentials, images and responses are synthetic. Fetch is replaced
 * before every provider call; no real API request or caller state is used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deepseekProvider, MODEL } from "../lib/multimodal/providers/deepseek.ts";
import { VisionTimeoutError } from "../lib/multimodal/errors.ts";
import type { CapabilityInput } from "../lib/multimodal/types.ts";

const originalFetch = globalThis.fetch;
const originalKey = process.env.DEEPSEEK_API_KEY;

function input(): CapabilityInput {
  return {
    prompt: "Return the requested JSON",
    image: { mime: "image/jpeg", base64: "eA==" },
    schema: { type: "object" },
    maxTokens: 256,
  };
}

test.beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = "sk-deepseek-synthetic-only";
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.after(() => {
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
});

test("current stable model alias and request shape match the official vision API", async () => {
  assert.equal(MODEL, "deepseek-flash");
  let record: { url: string; auth: string | null; body: any; signal?: AbortSignal } | null = null;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    record = {
      url: String(url),
      auth: headers.authorization ?? null,
      body: JSON.parse(String(init?.body)),
      signal: init?.signal ?? undefined,
    };
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"items":[]}' } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const raw = await deepseekProvider.call(input(), {
    model: MODEL,
    timeoutMs: 1000,
  });
  assert.equal(raw, '{"items":[]}');
  assert.ok(record);
  assert.equal(record.url, "https://api.deepseek.com/chat/completions");
  assert.equal(record.auth, "Bearer sk-deepseek-synthetic-only");
  assert.equal(record.body.model, "deepseek-flash");
  assert.equal(record.body.response_format.type, "json_object");
  assert.equal(record.body.messages[0].content[1].image_url.url, "data:image/jpeg;base64,eA==");
});

test("an already-aborted caller makes zero DeepSeek requests", async () => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    throw new Error("must not be called");
  }) as typeof fetch;
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    deepseekProvider.call(input(), {
      model: MODEL,
      timeoutMs: 1000,
      signal: controller.signal,
    }),
    (err: unknown) => err instanceof VisionTimeoutError,
  );
  assert.equal(requests, 0);
});

test("external cancellation aborts the in-flight request before its own timeout", async () => {
  let requests = 0;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests += 1;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("Synthetic abort", "AbortError"));
      }, { once: true });
    });
  }) as typeof fetch;
  const controller = new AbortController();
  const pending = deepseekProvider.call(input(), {
    model: MODEL,
    timeoutMs: 1000,
    signal: controller.signal,
  });
  while (requests === 0) await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();

  const early = await Promise.race([
    pending.then(() => "resolved", (err: unknown) => err),
    new Promise<"still-pending">(resolve => setTimeout(() => resolve("still-pending"), 100)),
  ]);
  if (early === "still-pending") {
    await assert.rejects(pending);
    assert.fail("caller cancellation did not reach the DeepSeek fetch signal");
  }
  assert.ok(early instanceof VisionTimeoutError);
  assert.equal(requests, 1);
});

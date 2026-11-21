/**
 * Offline tests for the reusable Coding Plan VisionProvider.
 *
 * Everything is synthetic: global `fetch` is replaced per test with a
 * recording fake, CODING_PLAN_API_KEY is a non-credential sentinel, and the
 * "image" is a short fixed base64 token. No real network, keys, images,
 * databases, or user state are touched.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

import { getProvider } from "../lib/multimodal/providers/base.ts";
import {
  VisionAllProvidersFailedError,
  VisionAuthError,
  VisionError,
  VisionNetworkError,
  VisionParseError,
  VisionRateLimitError,
  VisionTimeoutError,
} from "../lib/multimodal/errors.ts";
import type { CapabilityInput } from "../lib/multimodal/types.ts";
import type { ProviderCallOptions } from "../lib/multimodal/providers/base.ts";

// ── Synthetic fixtures ──────────────────────────────────────────────────────

const ENDPOINT =
  "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const MODEL = "doubao-seed-evolving";
const SYNTHETIC_KEY = "ZTESTKEYZ-cp-synthetic-not-a-credential";
const MIME = "image/png";
const BASE64 = "U1lOVEhFVElDX0lNQUdFX0JBU0U2NF9EQVRB";
const PROMPT = "Read the menu photo. UNIQUE_PROMPT_MARKER_xq9z";

type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};
type FetchCall = { url: unknown; init: RequestInit };
type Handler = (url: string, init: RequestInit) => Promise<FakeResponse>;

function makeInput(over: Partial<CapabilityInput> = {}): CapabilityInput {
  return { image: { mime: MIME, base64: BASE64 }, prompt: PROMPT, ...over };
}
function makeOpts(
  over: Partial<ProviderCallOptions> = {},
): ProviderCallOptions {
  return { model: MODEL, timeoutMs: 5_000, ...over };
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

/** Fake in-flight request that honors AbortSignal, like real fetch does. */
function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      queueMicrotask(() => reject(abortError()));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(abortError()),
      { once: true },
    );
  });
}

function jsonResponse(status: number, payload: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}
function brokenJsonResponse(status = 200): FakeResponse {
  return {
    ok: true,
    status,
    json: async () => {
      throw new Error("Unexpected token X in JSON at position 0");
    },
  };
}
function contentResponse(content: unknown, status = 200): FakeResponse {
  return jsonResponse(status, { choices: [{ message: { content } }] });
}

// ── Recording fetch harness ─────────────────────────────────────────────────

let calls: FetchCall[] = [];
let handler: Handler;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  process.env.CODING_PLAN_API_KEY = SYNTHETIC_KEY;
  handler = async () => contentResponse("RAW-CONTENT-MARKER");
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : String(input.url ?? "");
    const captured: FetchCall = { url, init: init ?? {} };
    calls.push(captured);
    return handler(url, captured.init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.CODING_PLAN_API_KEY;
});

async function loadProvider() {
  const mod = await import(
    "../lib/multimodal/providers/coding-plan.ts"
  );
  return mod.codingPlanProvider as {
    id: string;
    call(i: CapabilityInput, o: ProviderCallOptions): Promise<string>;
  };
}

function headerRecord(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

/** Await a rejected promise and return the error (assert.rejects resolves
 *  undefined here, so callers needing the error use this helper). */
async function captureRejects(p: Promise<unknown>): Promise<VisionError> {
  try {
    await p;
  } catch (err) {
    return err as VisionError;
  }
  throw new assert.AssertionError({ message: "expected promise to reject" });
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("first import self-registers 'coding-plan' and sends zero requests", async () => {
  // The provider module is not imported statically anywhere above: this first
  // dynamic import happens while the recording fake is installed.
  const provider = await loadProvider();
  assert.equal(provider.id, "coding-plan");
  assert.equal(typeof provider.call, "function");
  assert.equal(getProvider("coding-plan")?.id, "coding-plan");
  assert.equal(getProvider("coding-plan"), (getProvider("coding-plan")));
  await Promise.resolve();
  assert.equal(calls.length, 0);
});

test("one POST to the fixed package URL with bearer + content-type headers", async () => {
  const provider = await loadProvider();
  await provider.call(makeInput(), makeOpts());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  const headers = headerRecord(calls[0].init);
  assert.equal(headers["authorization"], `Bearer ${SYNTHETIC_KEY}`);
  assert.equal(headers["content-type"], "application/json");
});

test("fixed model with temperature 0.1, stream false, thinking enabled", async () => {
  const provider = await loadProvider();
  await provider.call(makeInput(), makeOpts());
  const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
  assert.equal(body.model, MODEL);
  assert.equal(body.temperature, 0.1);
  assert.equal(body.stream, false);
  assert.deepEqual(body.thinking, { type: "enabled" });
});

test("max_tokens defaults to 12000 and is capped there", async () => {
  const provider = await loadProvider();
  for (const [requested, expected] of [
    [undefined, 12_000],
    [333, 333],
    [999_999, 12_000],
  ] as const) {
    await provider.call(
      makeInput(requested === undefined ? {} : { maxTokens: requested }),
      makeOpts(),
    );
  }
  assert.equal(calls.length, 3);
  const tokens = calls.map((c) => {
    const b = JSON.parse(String(c.init.body)) as { max_tokens: number };
    return b.max_tokens;
  });
  assert.deepEqual(tokens, [12_000, 333, 12_000]);
});

test("prompt and original image dataURL are exact without a schema", async () => {
  const provider = await loadProvider();
  await provider.call(makeInput(), makeOpts());
  const body = JSON.parse(String(calls[0].init.body)) as {
    messages: Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
  };
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.deepEqual(body.messages[0].content, [
    { type: "text", text: PROMPT },
    {
      type: "image_url",
      image_url: { url: `data:${MIME};base64,${BASE64}` },
    },
  ]);
  assert.equal(body.response_format, undefined);
});

test("schema is appended as text and triggers json_object response_format", async () => {
  const provider = await loadProvider();
  const schema = {
    type: "object",
    properties: { items: { type: "array" } },
    required: ["items"],
    additionalProperties: false,
  };
  await provider.call(
    makeInput({ schema, schemaName: "beer_menu_image" }),
    makeOpts(),
  );
  const body = JSON.parse(String(calls[0].init.body)) as {
    messages: Array<{ content: Array<{ text?: string }> }>;
    response_format: unknown;
  };
  const text = body.messages[0].content[0].text!;
  assert.equal(text.slice(0, PROMPT.length), PROMPT);
  assert.ok(text.includes(JSON.stringify(schema)));
  assert.deepEqual(body.response_format, { type: "json_object" });
  // No strict json_schema mode: fixed Chat API gets json_object + text only.
  assert.ok(!JSON.stringify(body).includes("json_schema"));
});

test("missing API key fails before fetch with AUTH and zero requests", async () => {
  const provider = await loadProvider();
  delete process.env.CODING_PLAN_API_KEY;
  await assert.rejects(
    () => provider.call(makeInput(), makeOpts()),
    (e: unknown) =>
      e instanceof VisionAuthError &&
      e.code === "AUTH" &&
      e.retriable === false,
  );
  assert.equal(calls.length, 0);
});

test("whitespace-only API key is treated as missing", async () => {
  const provider = await loadProvider();
  process.env.CODING_PLAN_API_KEY = "   ";
  await assert.rejects(
    () => provider.call(makeInput(), makeOpts()),
    (e: unknown) => e instanceof VisionAuthError,
  );
  assert.equal(calls.length, 0);
});

test("unsupported opts.model is rejected before any request", async () => {
  const provider = await loadProvider();
  await assert.rejects(
    () =>
      provider.call(
        makeInput(),
        makeOpts({ model: "some-other-model-2026" }),
      ),
    (e: unknown) =>
      e instanceof VisionAllProvidersFailedError &&
      e.retriable === false &&
      !e.message.includes("some-other-model-2026"),
  );
  assert.equal(calls.length, 0);
});

test("non-finite or non-positive timeoutMs is rejected before any request", async () => {
  const provider = await loadProvider();
  for (const bad of [0, -5, NaN, Infinity, -Infinity]) {
    await assert.rejects(
      () => provider.call(makeInput(), makeOpts({ timeoutMs: bad })),
      (e: unknown) =>
        e instanceof VisionError &&
        e.retriable === false &&
        e.message.length <= 120,
    );
  }
  assert.equal(calls.length, 0);
});

test("positive response: raw nonempty content returned verbatim", async () => {
  const provider = await loadProvider();
  handler = async () => contentResponse('{"ok":true,"n":3}');
  const raw = await provider.call(makeInput(), makeOpts());
  assert.equal(raw, '{"ok":true,"n":3}');
  assert.equal(calls.length, 1);
});

test("HTTP 401: exactly one fetch, AUTH, no body text leaked", async () => {
  const provider = await loadProvider();
  handler = async () => jsonResponse(401, { error: "NO-LEAK-MARKER-401" });
  const err = await captureRejects(provider.call(makeInput(), makeOpts()));
  assert.ok(err instanceof VisionAuthError);
  assert.equal(err.code, "AUTH");
  assert.equal(calls.length, 1);
  assert.ok(!err.message.includes("NO-LEAK-MARKER-401"));
});

test("HTTP 403: exactly one fetch, AUTH", async () => {
  const provider = await loadProvider();
  handler = async () => jsonResponse(403, { error: "NO-LEAK-MARKER-403" });
  const err = await captureRejects(provider.call(makeInput(), makeOpts()));
  assert.ok(err instanceof VisionAuthError);
  assert.equal(calls.length, 1);
  assert.ok(!err.message.includes("NO-LEAK-MARKER-403"));
});

test("HTTP 429: exactly one fetch, RATE_LIMIT", async () => {
  const provider = await loadProvider();
  handler = async () => jsonResponse(429, { error: "NO-LEAK-MARKER-429" });
  await assert.rejects(
    () => provider.call(makeInput(), makeOpts()),
    (e: unknown) =>
      e instanceof VisionRateLimitError && e.code === "RATE_LIMIT",
  );
  assert.equal(calls.length, 1);
});

test("HTTP 500: exactly one fetch, NETWORK", async () => {
  const provider = await loadProvider();
  handler = async () => jsonResponse(500, { error: "NO-LEAK-MARKER-500" });
  const err = await captureRejects(provider.call(makeInput(), makeOpts()));
  assert.ok(err instanceof VisionNetworkError);
  assert.equal(calls.length, 1);
  assert.ok(!err.message.includes("NO-LEAK-MARKER-500"));
});

test("malformed outer JSON: PARSE, exactly one fetch, raw text discarded", async () => {
  const provider = await loadProvider();
  handler = async () => brokenJsonResponse();
  const err = await captureRejects(provider.call(makeInput(), makeOpts()));
  assert.ok(err instanceof VisionParseError);
  assert.equal(calls.length, 1);
  assert.ok(!err.message.includes("Unexpected token"));
});

test("empty or missing content: PARSE, one fetch per call", async () => {
  const provider = await loadProvider();
  const envelopes = [
    { choices: [{ message: { content: "   " } }] },
    { choices: [{ message: { content: "" } }] },
    { choices: [{ message: {} }] },
    { choices: [] },
    {},
  ];
  for (const payload of envelopes) {
    handler = async () => jsonResponse(200, payload);
    await assert.rejects(
      () => provider.call(makeInput(), makeOpts()),
      (e: unknown) => e instanceof VisionParseError,
    );
  }
  assert.equal(calls.length, envelopes.length);
});

test("thrown transport error text is scrubbed from message, metadata, stack, console", async (t) => {
  const provider = await loadProvider();
  const secretParts = [
    SYNTHETIC_KEY,
    BASE64,
    PROMPT,
    "SECRET-LEAK-MARKER-zz",
    "authorization",
  ];
  handler = async () => {
    throw new Error(
      "boom SECRET-LEAK-MARKER-zz key=" +
        SYNTHETIC_KEY +
        " img=" +
        BASE64 +
        " prompt=" +
        PROMPT +
        " authorization: Bearer abc",
    );
  };

  const consoleArgs: unknown[][] = [];
  for (const name of ["error", "warn", "log", "info"] as const) {
    t.mock.method(console, name, (...args: unknown[]) => {
      consoleArgs.push(args);
    });
  }

  const err = await captureRejects(provider.call(makeInput(), makeOpts()));
  assert.ok(err instanceof VisionNetworkError);
  assert.equal(calls.length, 1);
  assert.equal(err.cause, undefined);
  assert.ok(err.message.length <= 120);
  const serialized = JSON.stringify(err);
  for (const secret of secretParts) {
    assert.ok(!err.message.includes(secret), "message leaked: " + secret);
    assert.ok(!(err.stack ?? "").includes(secret), "stack leaked: " + secret);
    assert.ok(!serialized.includes(secret), "metadata leaked: " + secret);
  }
  const consoleText = JSON.stringify(consoleArgs);
  for (const secret of secretParts) {
    assert.ok(!consoleText.includes(secret), "console leaked: " + secret);
  }
});

test("internal timeout: TIMEOUT, one fetch, finishes quickly", async () => {
  const provider = await loadProvider();
  handler = async (_url, init) => waitForAbort(init.signal!);
  const t0 = Date.now();
  const err = await captureRejects(
    provider.call(makeInput(), makeOpts({ timeoutMs: 20 })),
  );
  assert.ok(err instanceof VisionTimeoutError);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `expected fast timeout, got ${elapsed}ms`);
  assert.equal(calls.length, 1);
  assert.match(err.message, /timed out/i);
});

test("already-aborted signal: TIMEOUT with zero requests", async () => {
  const provider = await loadProvider();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => provider.call(makeInput(), makeOpts({ signal: ac.signal })),
    (e: unknown) => e instanceof VisionTimeoutError,
  );
  assert.equal(calls.length, 0);
});

test("in-flight external abort: TIMEOUT, one fetch, listeners cleaned", async () => {
  const provider = await loadProvider();
  const ac = new AbortController();
  assert.deepEqual(getEventListeners(ac.signal, "abort"), []);
  handler = async (_url, init) => {
    await Promise.resolve();
    ac.abort();
    return waitForAbort(init.signal!);
  };
  const err = await captureRejects(
    provider.call(makeInput(), makeOpts({ signal: ac.signal })),
  );
  assert.ok(err instanceof VisionTimeoutError);
  assert.equal(calls.length, 1);
  assert.match(err.message, /canceled|aborted/i);
  assert.deepEqual(getEventListeners(ac.signal, "abort"), []);
});

test("successful call removes external signal listeners", async () => {
  const provider = await loadProvider();
  const ac = new AbortController();
  await provider.call(makeInput(), makeOpts({ signal: ac.signal }));
  assert.deepEqual(getEventListeners(ac.signal, "abort"), []);
});

test("timeoutMs above the cap is clamped to 180000", async (t) => {
  const provider = await loadProvider();
  let capturedMs: number | undefined;
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    "setTimeout",
    ((fn: (...args: unknown[]) => void, ms?: number) => {
      capturedMs = ms;
      return realSetTimeout(fn, 5);
    }) as typeof setTimeout,
  );
  handler = async (_url, init) => waitForAbort(init.signal!);
  await assert.rejects(
    () => provider.call(makeInput(), makeOpts({ timeoutMs: 999_999 })),
    (e: unknown) => e instanceof VisionTimeoutError,
  );
  assert.equal(capturedMs, 180_000);
});

test("other LLM base URL env overrides are ignored", async () => {
  const provider = await loadProvider();
  process.env.OPENROUTER_BASE_URL = "https://evil.example/v1";
  process.env.OPENAI_BASE_URL = "https://evil.example/v2";
  process.env.ARK_BASE_URL = "https://evil.example/v3";
  try {
    await provider.call(makeInput(), makeOpts());
  } finally {
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.ARK_BASE_URL;
  }
  assert.equal(calls[0].url, ENDPOINT);
});

test("API key is read at call time, not cached", async () => {
  const provider = await loadProvider();
  await provider.call(makeInput(), makeOpts());
  assert.equal(
    headerRecord(calls[0].init)["authorization"],
    `Bearer ${SYNTHETIC_KEY}`,
  );
  process.env.CODING_PLAN_API_KEY = "ZROTATEDZ-synthetic";
  await provider.call(makeInput(), makeOpts());
  assert.equal(
    headerRecord(calls[1].init)["authorization"],
    "Bearer ZROTATEDZ-synthetic",
  );
});

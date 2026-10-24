/**
 * Offline unit tests for the package-only Agent text helper
 * (lib/beer-agent/text-client.ts → agentTextFetch).
 *
 * Synthetic fake fetch only; env is scrubbed per test; no real keys,
 * network, DB, or user state. Legacy delegation is exercised through the
 * real openrouter-client too, but only the HTTP transport is faked.
 *
 * Isolation: an empty temp directory is created and chdir-ed into BEFORE
 * the dynamic runtime import, so any cwd-capturing runtime dependency
 * points at owned empty state. Original cwd/env/fetch are restored and the
 * temp directory removed after the run — even on failure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as TextClientMod from "../lib/beer-agent/text-client.ts";

const ENV_KEYS = [
  "BEER_VISION_PROVIDER",
  "CODING_PLAN_API_KEY",
  "OPENROUTER_API_KEY",
];

// ── Owned sandbox: snapshot caller state before touching anything ────────────
const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const priorEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) priorEnv.set(key, process.env[key]);

let tempRoot = "";
let cleanedUp = false;

async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (globalThis.fetch !== originalFetch) globalThis.fetch = originalFetch;
  if (globalThis.setTimeout !== originalSetTimeout) {
    globalThis.setTimeout = originalSetTimeout;
  }
  if (process.cwd() !== originalCwd) {
    try { process.chdir(originalCwd); } catch { /* best effort */ }
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}

let agentTextFetch: typeof TextClientMod.agentTextFetch;
let AgentTextError: typeof TextClientMod.AgentTextError;

try {
  tempRoot = await mkdtemp(path.join(tmpdir(), "beer-package-text-"));
  process.chdir(tempRoot);
  // Type-only imports above are erased; this is the first runtime evaluation.
  ({ agentTextFetch, AgentTextError } = await import(
    "../lib/beer-agent/text-client.ts"
  ));
} catch (err) {
  await cleanup();
  throw err;
}

const PACKAGE_URL =
  "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

type Outcome =
  | { status: number; json?: unknown; text?: string }
  | "abort-when-canceled";

type Rec = {
  url: string;
  auth: string | null;
  rawBody: string;
  body: Record<string, unknown>;
};

function installFetch(
  handler: (
    body: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<Outcome> | Outcome,
): { recs: Rec[]; restore: () => void } {
  const recs: Rec[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const rawBody = String(init?.body ?? "");
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { /* fake */ }
    const headers = init?.headers as Record<string, string> | undefined;
    // The attempt starts now; a handler throw happens inside the fetch, so
    // record before invoking it.
    recs.push({
      url,
      auth: headers?.authorization ?? null,
      rawBody,
      body,
    });
    const outcome = await handler(body, init?.signal as AbortSignal);
    if (outcome === "abort-when-canceled") {
      const signal = init?.signal as AbortSignal;
      await new Promise<void>((_resolve, reject) => {
        const abortError = new Error("synthetic AbortError");
        abortError.name = "AbortError";
        signal.addEventListener(
          "abort",
          () => reject(abortError),
          { once: true },
        );
      });
    }
    const status = outcome.status;
    const payload =
      outcome.text !== undefined
        ? outcome.text
        : JSON.stringify(outcome.json ?? {});
    return new Response(payload, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    recs,
    restore() { globalThis.fetch = original; },
  };
}

function envelope(content: string): { choices: Array<{ message: { content: string } }> } {
  return { choices: [{ message: { content } }] };
}

function callerBody(temperature: unknown): Record<string, unknown> {
  return {
    model: "qwen/qwen-2.5-72b-instruct",
    messages: [
      { role: "system", content: "SYSTEM-PROMPT-MARKER" },
      { role: "user", content: "用户最新消息: 什么是NEIPA？" },
    ],
    temperature,
    max_tokens: 1500,
  };
}

function expectTextError(
  err: unknown,
  code: string,
): asserts err is InstanceType<typeof AgentTextError> {
  assert.ok(err instanceof AgentTextError, `expected AgentTextError: ${String(err)}`);
  assert.equal((err as { code: string }).code, code);
}

test.beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

test.afterEach(() => {
  if (globalThis.fetch !== originalFetch) globalThis.fetch = originalFetch;
  if (globalThis.setTimeout !== originalSetTimeout) {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test.after(cleanup);

// ── Legacy delegation preserved ──────────────────────────────────────────────

test("unset selection delegates to the legacy guard with zero requests", async () => {
  const transport = installFetch(() => ({ status: 200, json: envelope("unexpected") }));
  try {
    await assert.rejects(
      () => agentTextFetch(callerBody(0.3)),
      /OPENROUTER_API_KEY not configured/,
    );
    assert.equal(transport.recs.length, 0);
  } finally {
    transport.restore();
  }
});

test("unset selection delegates to the real legacy OpenRouter request exactly once", async () => {
  process.env.OPENROUTER_API_KEY = "sk-legacy-synthetic";
  const transport = installFetch(() => ({ status: 200, json: envelope("legacy answer") }));
  try {
    const result = await agentTextFetch(callerBody(0.3));
    assert.equal(result, "legacy answer");
    assert.equal(transport.recs.length, 1);
    assert.equal(transport.recs[0]!.url, OPENROUTER_URL);
    assert.equal(transport.recs[0]!.auth, "Bearer sk-legacy-synthetic");
    // Legacy body is the original body verbatim, including its Qwen model.
    assert.equal(transport.recs[0]!.body.model, "qwen/qwen-2.5-72b-instruct");
    assert.equal(transport.recs[0]!.body.max_tokens, 1500);
  } finally {
    transport.restore();
  }
});

// ── Package happy path ───────────────────────────────────────────────────────

test("package mode: fixed endpoint/model, bounded thinking body, preserved messages", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  const body = callerBody(0.3);
  const messagesSnapshot = JSON.stringify(body.messages);
  const transport = installFetch(() => ({ status: 200, json: envelope("package answer") }));
  try {
    const result = await agentTextFetch(body, { timeoutMs: 45_000 });
    assert.equal(result, "package answer");

    assert.equal(transport.recs.length, 1);
    const rec = transport.recs[0]!;
    assert.equal(rec.url, PACKAGE_URL);
    assert.equal(rec.auth, "Bearer pkg-synthetic-key");

    assert.equal(rec.body.model, "doubao-seed-evolving");
    assert.equal(rec.body.stream, false);
    assert.deepEqual(rec.body.thinking, { type: "enabled" });
    assert.equal(rec.body.max_tokens, 12_000);
    assert.equal(rec.body.temperature, 0.3);
    // Original roles/content/history preserved verbatim.
    assert.equal(JSON.stringify(rec.body.messages), messagesSnapshot);
    // Legacy Qwen model is not sent in package mode.
    assert.ok(!rec.rawBody.includes("qwen"));

    // Caller body/options are not mutated.
    assert.equal(body.model, "qwen/qwen-2.5-72b-instruct");
    assert.equal(body.max_tokens, 1500);
    assert.equal(JSON.stringify(body.messages), messagesSnapshot);
  } finally {
    transport.restore();
  }
});

test("package mode keeps falsy finite temperature 0 and omits non-finite values", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";

  const zero = installFetch(() => ({ status: 200, json: envelope("zero temp") }));
  try {
    await agentTextFetch(callerBody(0));
    assert.equal(zero.recs[0]!.body.temperature, 0);
  } finally {
    zero.restore();
  }

  const bad = installFetch(() => ({ status: 200, json: envelope("no temp") }));
  try {
    await agentTextFetch(callerBody("hot"));
    assert.ok(!("temperature" in bad.recs[0]!.body));
  } finally {
    bad.restore();
  }
});

test("package mode preserves a full multi-role message history", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
  ];
  const transport = installFetch(() => ({ status: 200, json: envelope("history answer") }));
  try {
    await agentTextFetch({ model: "qwen/x", messages, temperature: 0.7, max_tokens: 300 });
    assert.deepEqual(transport.recs[0]!.body.messages, messages);
  } finally {
    transport.restore();
  }
});

// ── Fail-closed: selector, key, pre-abort ───────────────────────────────────

test("unknown nonempty selector fails closed before any request", async () => {
  process.env.BEER_VISION_PROVIDER = "some-other-provider";
  const transport = installFetch(() => ({ status: 200, json: envelope("unexpected") }));
  try {
    await assert.rejects(
      () => agentTextFetch(callerBody(0.3)),
      (err: unknown) => {
        expectTextError(err, "SELECTION");
        assert.ok(!/some-other-provider/.test((err as Error).message));
        return true;
      },
    );
    assert.equal(transport.recs.length, 0);
  } finally {
    transport.restore();
  }
});

test("package mode without the package key fails as AUTH with zero requests", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  const transport = installFetch(() => ({ status: 200, json: envelope("unexpected") }));
  try {
    await assert.rejects(
      () => agentTextFetch(callerBody(0.3)),
      (err: unknown) => {
        expectTextError(err, "AUTH");
        assert.match((err as Error).message, /not configured/);
        return true;
      },
    );
    assert.equal(transport.recs.length, 0);
  } finally {
    transport.restore();
  }
});

test("pre-aborted signal makes zero requests", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  const controller = new AbortController();
  controller.abort();
  const transport = installFetch(() => ({ status: 200, json: envelope("unexpected") }));
  try {
    await assert.rejects(
      () => agentTextFetch(callerBody(0.3), { signal: controller.signal }),
      (err: unknown) => {
        expectTextError(err, "TIMEOUT");
        assert.match((err as Error).message, /canceled/);
        return true;
      },
    );
    assert.equal(transport.recs.length, 0);
  } finally {
    transport.restore();
  }
});

test("invalid explicit timeout values are rejected with zero requests", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  const transport = installFetch(() => ({ status: 200, json: envelope("unexpected") }));
  try {
    for (const timeoutMs of [0, -1, NaN, Infinity]) {
      await assert.rejects(
        () => agentTextFetch(callerBody(0.3), { timeoutMs }),
        (err: unknown) => err instanceof AgentTextError,
      );
    }
    assert.equal(transport.recs.length, 0);
  } finally {
    transport.restore();
  }
});

test("default timeout is 90000ms and explicit timeout is capped at 180000ms", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";

  let capturedDelay = -1;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
    capturedDelay = ms ?? -1;
    return originalSetTimeout(fn, 0);
  }) as typeof setTimeout;

  const defaultCase = installFetch(() => "abort-when-canceled");
  try {
    await assert.rejects(
      () => agentTextFetch(callerBody(0.3)),
      (err: unknown) => {
        expectTextError(err, "TIMEOUT");
        return true;
      },
    );
    assert.equal(capturedDelay, 90_000);
  } finally {
    defaultCase.restore();
  }

  capturedDelay = -1;
  const cappedCase = installFetch(() => "abort-when-canceled");
  try {
    await assert.rejects(
      () => agentTextFetch(callerBody(0.3), { timeoutMs: 999_999 }),
      (err: unknown) => err instanceof AgentTextError,
    );
    assert.equal(capturedDelay, 180_000);
  } finally {
    cappedCase.restore();
  }
});

// ── One request, no paid fallback, safe classification ──────────────────────

test("package timeout fires exactly one request with no paid fallback", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  process.env.OPENROUTER_API_KEY = "sk-legacy-synthetic";
  const transport = installFetch(() => "abort-when-canceled");
  try {
    await assert.rejects(
      () => agentTextFetch(callerBody(0.3), { timeoutMs: 40 }),
      (err: unknown) => {
        expectTextError(err, "TIMEOUT");
        assert.match((err as Error).message, /timed out/);
        return true;
      },
    );
    assert.equal(transport.recs.filter((r) => r.url === PACKAGE_URL).length, 1);
    assert.equal(transport.recs.filter((r) => r.url === OPENROUTER_URL).length, 0);
  } finally {
    transport.restore();
  }
});

test("package 429 is one request, classified RATE_LIMIT, no paid fallback", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  process.env.OPENROUTER_API_KEY = "sk-legacy-synthetic";
  const transport = installFetch(() => ({ status: 429, json: { error: { message: "rate limited" } } }));
  try {
    await assert.rejects(
      () => agentTextFetch(callerBody(0.3)),
      (err: unknown) => {
        expectTextError(err, "RATE_LIMIT");
        return true;
      },
    );
    assert.equal(transport.recs.filter((r) => r.url === PACKAGE_URL).length, 1);
    assert.equal(transport.recs.filter((r) => r.url === OPENROUTER_URL).length, 0);
  } finally {
    transport.restore();
  }
});

test("package network rejection is bounded NETWORK with one request", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  const transport = installFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    await assert.rejects(
      () => agentTextFetch(callerBody(0.3)),
      (err: unknown) => {
        expectTextError(err, "NETWORK");
        assert.match((err as Error).message, /transport/);
        return true;
      },
    );
    assert.equal(transport.recs.length, 1);
  } finally {
    transport.restore();
  }
});

test("package HTTP statuses classify to AUTH / NETWORK / UNKNOWN with one request each", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  const cases: Array<[number, string]> = [
    [401, "AUTH"],
    [403, "AUTH"],
    [500, "NETWORK"],
    [502, "NETWORK"],
    [400, "UNKNOWN"],
  ];
  for (const [status, code] of cases) {
    const transport = installFetch(() => ({ status, json: { error: "upstream detail" } }));
    try {
      await assert.rejects(
        () => agentTextFetch(callerBody(0.3)),
        (err: unknown) => {
          expectTextError(err, code);
          assert.match((err as Error).message, new RegExp(`HTTP ${status}`));
          return true;
        },
      );
      assert.equal(transport.recs.length, 1);
    } finally {
      transport.restore();
    }
  }
});

test("malformed envelope and empty content classify as PARSE with one request", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";

  const malformed = installFetch(() => ({ status: 200, text: "this is not json" }));
  try {
    await assert.rejects(
      () => agentTextFetch(callerBody(0.3)),
      (err: unknown) => {
        expectTextError(err, "PARSE");
        assert.match((err as Error).message, /JSON/);
        return true;
      },
    );
    assert.equal(malformed.recs.length, 1);
  } finally {
    malformed.restore();
  }

  const empty = installFetch(() => ({ status: 200, json: envelope("   ") }));
  try {
    await assert.rejects(
      () => agentTextFetch(callerBody(0.3)),
      (err: unknown) => {
        expectTextError(err, "PARSE");
        assert.match((err as Error).message, /no usable content/);
        return true;
      },
    );
    assert.equal(empty.recs.length, 1);
  } finally {
    empty.restore();
  }
});

test("raw hostile transport errors and prompts are scrubbed from everything thrown", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  const key = "pkg-super-secret-key";
  process.env.CODING_PLAN_API_KEY = key;
  const secretMarker = "NEIPA_SECRET_PROMPT_MARKER";
  const transport = installFetch(() => {
    // Hostile external code attempts to smuggle secrets in the exception.
    const err = new Error(`boom key=${key} prompt=${secretMarker}`);
    err.name = "TypeError";
    throw err;
  });
  try {
    await assert.rejects(
      () => agentTextFetch({
        model: "qwen/x",
        messages: [{ role: "user", content: secretMarker }],
      }),
      (err: unknown) => {
        expectTextError(err, "NETWORK");
        const dumped = JSON.stringify(err, Object.getOwnPropertyNames(err as Error));
        assert.ok(!dumped.includes(key), "key leaked");
        assert.ok(!dumped.includes(secretMarker), "prompt leaked");
        return true;
      },
    );
    assert.equal(transport.recs.length, 1);
  } finally {
    transport.restore();
  }
});

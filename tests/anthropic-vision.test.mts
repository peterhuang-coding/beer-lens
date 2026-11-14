/**
 * Offline tests for the explicit Anthropic vision route.
 *
 * The real provider, official SDK, multimodal container and skills run against
 * synthetic SSE/HTTP responses. No real credential, image, API request, DB or
 * user state is used. The default fetch implementation denies every call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentContext } from "../lib/agent/types.ts";
import type * as MultimodalMod from "../lib/multimodal/index.ts";
import type * as ImageRoutingMod from "../lib/multimodal/image-routing.ts";
import type * as RecommendMod from "../lib/skills/recommend/execute.ts";
import type * as LabelCheckMod from "../lib/skills/label-check/execute.ts";
import type { CapabilityInput, VisionProvider } from "../lib/multimodal/index.ts";

const ENV_KEYS = [
  "BEER_VISION_PROVIDER",
  "BEER_TEXT_PROVIDER",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_LOG",
  "CODING_PLAN_API_KEY",
  "OPENROUTER_API_KEY",
  "VISION_FALLBACK_MODELS",
];
const SYNTHETIC_KEY = "sk-ant-offline-synthetic-only";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const priorEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) priorEnv.set(key, process.env[key]);
const denyFetch = (async () => {
  throw new Error("Unexpected network call in Anthropic offline tests");
}) as typeof fetch;

let tempRoot = "";
let cleanedUp = false;
async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
  if (process.cwd() !== originalCwd) {
    try { process.chdir(originalCwd); } catch { /* best effort */ }
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}

let vision: typeof MultimodalMod.vision;
let getProvider: typeof MultimodalMod.getProvider;
let VisionError: typeof MultimodalMod.VisionError;
let VisionAuthError: typeof MultimodalMod.VisionAuthError;
let VisionTimeoutError: typeof MultimodalMod.VisionTimeoutError;
let VisionNetworkError: typeof MultimodalMod.VisionNetworkError;
let VisionParseError: typeof MultimodalMod.VisionParseError;
let VisionRateLimitError: typeof MultimodalMod.VisionRateLimitError;
let VisionAllProvidersFailedError: typeof MultimodalMod.VisionAllProvidersFailedError;
let resolveImageRoute: typeof ImageRoutingMod.resolveImageRoute;
let resolveImageCall: typeof ImageRoutingMod.resolveImageCall;
let recommendExecute: typeof RecommendMod.execute;
let labelCheckExecute: typeof LabelCheckMod.execute;

try {
  tempRoot = await mkdtemp(path.join(tmpdir(), "beer-anthropic-vision-"));
  process.chdir(tempRoot);
  await mkdir("data", { recursive: true });
  await writeFile(
    "data/pipeline-config.json",
    JSON.stringify({ memoryExperiment: { enabled: false } }),
  );
  globalThis.fetch = denyFetch;
  ({
    vision,
    getProvider,
    VisionError,
    VisionAuthError,
    VisionTimeoutError,
    VisionNetworkError,
    VisionParseError,
    VisionRateLimitError,
    VisionAllProvidersFailedError,
  } = await import("../lib/multimodal/index.ts"));
  ({ resolveImageRoute, resolveImageCall } =
    await import("../lib/multimodal/image-routing.ts"));
  ({ execute: recommendExecute } =
    await import("../lib/skills/recommend/execute.ts"));
  ({ execute: labelCheckExecute } =
    await import("../lib/skills/label-check/execute.ts"));
} catch (err) {
  await cleanup();
  throw err;
}

function provider(): VisionProvider {
  const selected = getProvider("anthropic");
  assert.ok(selected, "explicit Anthropic provider is registered");
  return selected;
}

function input(overrides: Partial<CapabilityInput> = {}): CapabilityInput {
  return {
    image: { base64: "eA==", mime: "image/jpeg" },
    prompt: "SYNTHETIC_PROMPT: read only visible menu text",
    schema: {
      type: "object",
      properties: { extracted: { type: "object" } },
      required: ["extracted"],
    },
    maxTokens: 12_000,
    ...overrides,
  };
}

type FetchRecord = {
  url: string;
  apiKey: string | null;
  authorization: string | null;
  body: any;
};
type FetchHandler = (
  record: FetchRecord,
  signal: AbortSignal | undefined,
) => Response | Promise<Response>;

function installFetch(handler: FetchHandler): {
  records: FetchRecord[];
  restore: () => void;
} {
  const records: FetchRecord[] = [];
  globalThis.fetch = (async (rawInput: RequestInfo | URL, init?: RequestInit) => {
    const request = rawInput instanceof Request ? rawInput : null;
    const url = request?.url ?? String(rawInput);
    const rawBody = request ? await request.text() : String(init?.body ?? "");
    const headers = new Headers(request?.headers ?? init?.headers);
    let body: any = null;
    try { body = JSON.parse(rawBody); } catch { /* synthetic transport */ }
    const record: FetchRecord = {
      url,
      apiKey: headers.get("x-api-key"),
      authorization: headers.get("authorization"),
      body,
    };
    records.push(record);
    return handler(record, request?.signal ?? init?.signal ?? undefined);
  }) as typeof fetch;
  return { records, restore() { globalThis.fetch = denyFetch; } };
}

function event(name: string, data: object): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicSse(
  text: string,
  options: { thinking?: boolean; stopReason?: string } = {},
): string {
  let index = 0;
  let output = event("message_start", {
    type: "message_start",
    message: {
      id: "msg_offline_synthetic",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  if (options.thinking) {
    output += event("content_block_start", {
      type: "content_block_start", index,
      content_block: { type: "thinking", thinking: "", signature: "synthetic" },
    });
    output += event("content_block_delta", {
      type: "content_block_delta", index,
      delta: { type: "thinking_delta", thinking: "SYNTHETIC_HIDDEN_REASONING" },
    });
    output += event("content_block_stop", { type: "content_block_stop", index });
    index += 1;
  }
  if (text) {
    const split = Math.max(1, Math.floor(text.length / 2));
    output += event("content_block_start", {
      type: "content_block_start", index,
      content_block: { type: "text", text: "" },
    });
    for (const part of [text.slice(0, split), text.slice(split)]) {
      output += event("content_block_delta", {
        type: "content_block_delta", index,
        delta: { type: "text_delta", text: part },
      });
    }
    output += event("content_block_stop", { type: "content_block_stop", index });
  }
  output += event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: options.stopReason ?? "end_turn", stop_sequence: null },
    usage: { output_tokens: 8 },
  });
  output += event("message_stop", { type: "message_stop" });
  return output;
}

function sseResponse(text: string, options?: { thinking?: boolean; stopReason?: string }): Response {
  return new Response(anthropicSse(text, options), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({
    type: "error",
    error: {
      type: "synthetic_error",
      message: "SYNTHETIC_SECRET_KEY SYNTHETIC_SECRET_IMAGE SYNTHETIC_SECRET_PROMPT",
    },
  }), { status, headers: { "content-type": "application/json" } });
}

function combinedText(): string {
  return JSON.stringify({
    imageContext: {
      imageType: "menu", confidence: 0.9, reason: "synthetic printed menu", needsOcr: true,
      needsLabelRecognition: false, canAssessVisualQuality: true, visibleClues: ["menu board"],
    },
    extracted: {
      sourceType: "menu",
      rawText: "#1 Test IPA | Example Brewery | IPA | 6.5% | ¥38 | 330ml",
      items: [{
        menuIndex: 1,
        rawText: "#1 Test IPA | Example Brewery | IPA | 6.5% | 45 IBU | ¥38 | 330ml",
        beerName: "Test IPA", brewery: "Example Brewery", style: "IPA",
        abv: 6.5, ibu: 45, price: 38, serving: "330ml", currency: "CNY",
        servingMode: "bottle", packagingDate: "", confidence: 0.9,
      }],
      visualBeerDescription: {
        color: "gold", clarity: "clear", foam: "white", visiblePackagingDate: "", notes: [],
      },
      uncertainties: [],
    },
    visualQuality: {
      canAssess: false, visualRiskFlags: [], oxidationRisk: "unknown", freshnessRisk: "unknown",
      lightstrikeRisk: "unknown", evidence: [], caveat: "synthetic",
    },
  });
}

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userId: "anthropic-offline-user",
    conversationId: "anthropic-offline-conv",
    traceId: "anthropic-offline-trace",
    hasImage: true,
    imageDataUrl: "data:image/jpeg;base64,eA==",
    lastUserText: "推荐",
    messages: [],
    channel: "test",
    ...overrides,
  };
}

test.beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  globalThis.fetch = denyFetch;
  vision.invalidateCache();
});
test.afterEach(() => {
  globalThis.fetch = denyFetch;
  vision.config({ capabilityProviders: undefined, fallbackProviders: undefined });
});
test.after(cleanup);

test("routing remains legacy by default and pins exactly one explicit provider", () => {
  assert.deepEqual(resolveImageRoute(), { mode: "legacy" });
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  assert.deepEqual(resolveImageRoute(), {
    mode: "package",
    providers: [{ provider: "coding-plan", models: ["doubao-seed-evolving"], timeoutMs: 180_000 }],
  });
  process.env.BEER_VISION_PROVIDER = " anthropic ";
  assert.deepEqual(resolveImageRoute(), {
    mode: "package",
    providers: [{ provider: "anthropic", models: ["claude-opus-5"], timeoutMs: 180_000 }],
  });
});

test("Anthropic route requires its own key and never borrows other provider keys", async () => {
  process.env.BEER_VISION_PROVIDER = "anthropic";
  process.env.CODING_PLAN_API_KEY = "synthetic-package-key";
  process.env.OPENROUTER_API_KEY = "synthetic-openrouter-key";
  assert.throws(
    () => resolveImageCall(),
    (err: unknown) => err instanceof VisionAuthError && err.code === "AUTH",
  );
  await assert.rejects(
    provider().call(input(), { model: "claude-opus-5", timeoutMs: 1000 }),
    (err: unknown) => err instanceof VisionAuthError && err.code === "AUTH",
  );
});

test("official SDK sends fixed adaptive streaming image request and returns text only", async () => {
  process.env.ANTHROPIC_API_KEY = SYNTHETIC_KEY;
  process.env.ANTHROPIC_AUTH_TOKEN = "synthetic-auth-token-must-not-win";
  process.env.ANTHROPIC_BASE_URL = "https://synthetic-invalid-base.example";
  process.env.ANTHROPIC_LOG = "debug";
  const expected = '{"extracted":{"items":[]}}';
  const transport = installFetch(() => sseResponse(expected, { thinking: true }));
  try {
    const raw = await provider().call(input({ maxTokens: 20_000 }), {
      model: "claude-opus-5",
      timeoutMs: 1000,
    });
    assert.equal(raw, expected);
    assert.doesNotMatch(raw, /SYNTHETIC_HIDDEN_REASONING/);
    assert.equal(transport.records.length, 1);
    const record = transport.records[0]!;
    assert.equal(record.url, ANTHROPIC_URL);
    assert.equal(record.apiKey, null);
    assert.equal(record.authorization, `Bearer ${SYNTHETIC_KEY}`);
    assert.equal(record.body.model, "claude-opus-5");
    assert.equal(record.body.stream, true);
    assert.equal(record.body.max_tokens, 12_000);
    assert.deepEqual(record.body.thinking, { type: "adaptive" });
    assert.equal(record.body.fallbacks, undefined);
    assert.match(record.body.system, /JSON/);
    assert.match(record.body.system, /extracted/);
    assert.equal(record.body.messages.length, 1);
    const content = record.body.messages[0].content;
    assert.deepEqual(content[0], {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "eA==" },
    });
    assert.deepEqual(content[1], {
      type: "text",
      text: "SYNTHETIC_PROMPT: read only visible menu text",
    });
  } finally {
    transport.restore();
  }
});

test("bad model, unsupported image and already-aborted calls make zero requests", async () => {
  process.env.ANTHROPIC_API_KEY = SYNTHETIC_KEY;
  const transport = installFetch(() => sseResponse("{}"));
  try {
    await assert.rejects(
      provider().call(input(), { model: "other-model", timeoutMs: 1000 }),
      VisionAllProvidersFailedError,
    );
    await assert.rejects(
      provider().call(input({ image: { base64: "eA==", mime: "image/svg+xml" } }), {
        model: "claude-opus-5", timeoutMs: 1000,
      }),
      VisionAllProvidersFailedError,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      provider().call(input(), {
        model: "claude-opus-5", timeoutMs: 1000, signal: controller.signal,
      }),
      VisionTimeoutError,
    );
    assert.equal(transport.records.length, 0);
  } finally {
    transport.restore();
  }
});

test("external AbortSignal cancels the in-flight SDK stream without another request", { timeout: 2000 }, async () => {
  process.env.ANTHROPIC_API_KEY = SYNTHETIC_KEY;
  const controller = new AbortController();
  const transport = installFetch((_record, signal) => {
    queueMicrotask(() => controller.abort());
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  });
  try {
    await assert.rejects(
      provider().call(input(), {
        model: "claude-opus-5", timeoutMs: 1000, signal: controller.signal,
      }),
      (err: unknown) => err instanceof VisionTimeoutError && /canceled/.test(err.message),
    );
    assert.equal(transport.records.length, 1);
  } finally {
    transport.restore();
  }
});

test("provider timeout aborts the stream and is not mislabeled as external cancellation", { timeout: 2000 }, async () => {
  process.env.ANTHROPIC_API_KEY = SYNTHETIC_KEY;
  const transport = installFetch((_record, signal) => new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
  try {
    await assert.rejects(
      provider().call(input(), { model: "claude-opus-5", timeoutMs: 20 }),
      (err: unknown) => err instanceof VisionTimeoutError && /timed out/.test(err.message),
    );
    assert.equal(transport.records.length, 1);
  } finally {
    transport.restore();
  }
});

test("typed HTTP failures are redacted and 429/500 are never retried", async () => {
  process.env.ANTHROPIC_API_KEY = SYNTHETIC_KEY;
  for (const [status, expected] of [
    [401, VisionAuthError],
    [429, VisionRateLimitError],
    [500, VisionNetworkError],
  ] as const) {
    const transport = installFetch(() => errorResponse(status));
    try {
      await assert.rejects(
        provider().call(input(), { model: "claude-opus-5", timeoutMs: 1000 }),
        (err: unknown) => {
          assert.ok(err instanceof expected);
          assert.ok(err instanceof VisionError);
          const serialized = `${err.message} ${err.stack} ${JSON.stringify(err)}`;
          assert.doesNotMatch(serialized, /SYNTHETIC_SECRET_(?:KEY|IMAGE|PROMPT)/);
          return true;
        },
      );
      assert.equal(transport.records.length, 1, `HTTP ${status} has one attempt`);
    } finally {
      transport.restore();
    }
  }
});

test("empty and truncated streams fail closed as parse errors", async () => {
  process.env.ANTHROPIC_API_KEY = SYNTHETIC_KEY;
  for (const response of [
    sseResponse("", { thinking: true }),
    sseResponse('{"partial":', { stopReason: "max_tokens" }),
  ]) {
    const transport = installFetch(() => response);
    try {
      await assert.rejects(
        provider().call(input(), { model: "claude-opus-5", timeoutMs: 1000 }),
        VisionParseError,
      );
      assert.equal(transport.records.length, 1);
    } finally {
      transport.restore();
    }
  }
});

test("non-end_turn statuses fail closed even with valid-looking JSON", async () => {
  process.env.ANTHROPIC_API_KEY = SYNTHETIC_KEY;
  for (const stopReason of [
    "pause_turn",
    "refusal",
    "model_context_window_exceeded",
    "stop_sequence",
    "tool_use",
  ]) {
    const transport = installFetch(() => sseResponse(
      '{"extracted":{"items":[]}}',
      { stopReason },
    ));
    try {
      await assert.rejects(
        provider().call(input(), { model: "claude-opus-5", timeoutMs: 1000 }),
        (err: unknown) => err instanceof VisionParseError && /stopped/.test(err.message),
        stopReason,
      );
      assert.equal(transport.records.length, 1, stopReason);
    } finally {
      transport.restore();
    }
  }
});

test("recommend skill accepts Anthropic SSE without any other provider request", async () => {
  process.env.BEER_VISION_PROVIDER = "anthropic";
  process.env.BEER_TEXT_PROVIDER = "coding-plan";
  process.env.ANTHROPIC_API_KEY = SYNTHETIC_KEY;
  process.env.CODING_PLAN_API_KEY = "synthetic-package-key";
  process.env.OPENROUTER_API_KEY = "synthetic-openrouter-key";
  const transport = installFetch((record) => {
    assert.equal(record.url, ANTHROPIC_URL);
    return sseResponse(combinedText());
  });
  try {
    const result = await recommendExecute(makeCtx());
    assert.deepEqual(result.errors, []);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.displayName, "Test IPA");
    assert.equal(result.candidates[0]!.ibu, 45);
    assert.equal(transport.records.length, 1);
  } finally {
    transport.restore();
  }
});

test("Anthropic 429 cannot fall through to configured legacy or package providers", async () => {
  process.env.BEER_VISION_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = SYNTHETIC_KEY;
  process.env.CODING_PLAN_API_KEY = "synthetic-package-key";
  process.env.OPENROUTER_API_KEY = "synthetic-openrouter-key";
  vision.config({
    capabilityProviders: {
      beer_menu_image: [{ provider: "openrouter", models: ["paid-fallback"], timeoutMs: 1000 }],
    },
    fallbackProviders: [{ provider: "coding-plan", models: ["doubao-seed-evolving"], timeoutMs: 1000 }],
  });
  const transport = installFetch((record) => {
    assert.equal(record.url, ANTHROPIC_URL);
    return errorResponse(429);
  });
  try {
    const result = await recommendExecute(makeCtx());
    assert.ok(result.errors.length > 0);
    assert.equal(result.candidates.length, 0);
    assert.equal(transport.records.length, 1);
  } finally {
    transport.restore();
  }
});

test("label-check also uses the explicit Anthropic image route", async () => {
  process.env.BEER_VISION_PROVIDER = "anthropic";
  process.env.BEER_TEXT_PROVIDER = "coding-plan";
  process.env.ANTHROPIC_API_KEY = SYNTHETIC_KEY;
  process.env.CODING_PLAN_API_KEY = "synthetic-package-key";
  const label = JSON.stringify({
    beerName: "Label Ale", brewery: "Label Brewery", style: "IPA",
    abv: 6, volumeMl: 330, packagingDate: "", productionDate: "",
    visibleDateText: "", rawText: "Label Ale / Label Brewery",
    issues: [], freshnessAssessment: "unknown",
  });
  const transport = installFetch((record) => {
    assert.equal(record.url, ANTHROPIC_URL);
    return sseResponse(label);
  });
  try {
    const result = await labelCheckExecute(makeCtx({ lastUserText: "检查酒标" }));
    assert.deepEqual(result.errors, []);
    assert.equal(result.candidates[0]?.displayName, "Label Ale");
    assert.equal(transport.records.length, 1);
  } finally {
    transport.restore();
  }
});

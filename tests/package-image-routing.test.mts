/**
 * Offline routing tests for the explicit opt-in Coding Plan image route.
 *
 * Synthetic fetch transport only; env is scrubbed per test; no real keys,
 * network, images, DB, or user state. The runtime under test is the real
 * skill execute → runImagePipeline → multimodal container chain; only the
 * HTTP transport is faked.
 *
 * Isolation: runtime modules capture process.cwd() while loading
 * (multi-stage-pipeline, route-registry, memory-experiment, ...), so this
 * file creates an empty temp directory and chdirs into it BEFORE importing
 * any runtime module. Original cwd/env/fetch are restored and the temp
 * directory removed after the run — even on failure — so `npm test` never
 * reads or writes caller configuration or state.
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
import type * as MenuVisionMod from "../lib/skills/menu-vision/execute.ts";

const ENV_KEYS = [
  "BEER_VISION_PROVIDER",
  "CODING_PLAN_API_KEY",
  "OPENROUTER_API_KEY",
  "VISION_FALLBACK_MODELS",
  "BRAVE_SEARCH_API_KEY",
];

// ── Owned sandbox: snapshot caller state before touching anything ────────────
const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const priorEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) priorEnv.set(key, process.env[key]);

let tempRoot = "";
let cleanedUp = false;

/** Restore caller cwd/env/fetch and delete the owned temp directory. */
async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  // Every altered env key returns to its exact prior value (or absence).
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (globalThis.fetch !== originalFetch) globalThis.fetch = originalFetch;
  if (process.cwd() !== originalCwd) {
    try { process.chdir(originalCwd); } catch { /* best effort */ }
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}

// Bindings are populated by dynamic imports inside the try block below.
let vision: typeof MultimodalMod.vision;
let VisionError: typeof MultimodalMod.VisionError;
let VisionAllProvidersFailedError: typeof MultimodalMod.VisionAllProvidersFailedError;
let VisionAuthError: typeof MultimodalMod.VisionAuthError;
let resolveImageRoute: typeof ImageRoutingMod.resolveImageRoute;
let resolveImageCall: typeof ImageRoutingMod.resolveImageCall;
let recommendExecute: typeof RecommendMod.execute;
let menuVisionExecute: typeof MenuVisionMod.execute;

try {
  tempRoot = await mkdtemp(path.join(tmpdir(), "beer-package-routing-"));
  process.chdir(tempRoot);
  // Deterministically disable memory reads for the image finish path. This
  // lives entirely in the owned temp cwd, so no caller data is touched and
  // the default model config (no `models` key) is left untouched.
  await mkdir("data", { recursive: true });
  await writeFile(
    "data/pipeline-config.json",
    JSON.stringify({ memoryExperiment: { enabled: false } }),
  );
  // Runtime modules are imported only after the chdir: they capture
  // process.cwd() while loading. The imports above are type-only and
  // erased, so they never trigger runtime module evaluation.
  ({ vision, VisionError, VisionAllProvidersFailedError, VisionAuthError } =
    await import("../lib/multimodal/index.ts"));
  ({ resolveImageRoute, resolveImageCall } =
    await import("../lib/multimodal/image-routing.ts"));
  ({ execute: recommendExecute } =
    await import("../lib/skills/recommend/execute.ts"));
  ({ execute: menuVisionExecute } =
    await import("../lib/skills/menu-vision/execute.ts"));
} catch (err) {
  await cleanup();
  throw err;
}

type FetchRecord = { url: string; status: number; auth: string | null; model: string | null };
type FetchOutcome = { status: number; body: unknown };

function installFetch(handler: (url: string) => FetchOutcome): { records: FetchRecord[]; restore: () => void } {
  const records: FetchRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const outcome = handler(url);
    let model: string | null = null;
    if (init?.body) {
      try { model = (JSON.parse(String(init.body)) as { model?: string }).model ?? null; } catch { /* fake only */ }
    }
    const headers = init?.headers as Record<string, string> | undefined;
    records.push({
      url,
      status: outcome.status,
      auth: headers?.authorization ?? null,
      model,
    });
    const body = typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body);
    return new Response(body, {
      status: outcome.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    records,
    restore() { globalThis.fetch = original; },
  };
}

function combinedEnvelope(): { choices: Array<{ message: { content: string } }> } {
  const content = JSON.stringify({
    imageContext: {
      imageType: "menu", confidence: 0.9, reason: "printed menu", needsOcr: true,
      needsLabelRecognition: false, canAssessVisualQuality: true, visibleClues: ["menu board"],
    },
    extracted: {
      sourceType: "menu",
      rawText: "#1 Test IPA | Example Brewery | IPA | 6.5% | ¥38 | 330ml",
      items: [{
        menuIndex: 1,
        rawText: "#1 Test IPA | Example Brewery | IPA | 6.5% | 45 IBU | ¥38 | 330ml",
        beerName: "Test IPA",
        brewery: "Example Brewery",
        style: "IPA",
        abv: 6.5,
        ibu: 45,
        price: 38,
        serving: "330ml",
        currency: "CNY",
        servingMode: "bottle",
        packagingDate: "",
        confidence: 0.9,
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
  return { choices: [{ message: { content } }] };
}

const CODING_PLAN_URL = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function makeCtx(): AgentContext {
  return {
    userId: "package-routing-user",
    conversationId: "package-routing-conv",
    traceId: "package-routing-trace",
    hasImage: true,
    imageDataUrl: "data:image/jpeg;base64,eA==",
    lastUserText: "推荐",
    messages: [],
    channel: "test",
  };
}

test.beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vision.invalidateCache();
});

// Defense in depth: each test restores fetch in its own finally, but if that
// path is ever bypassed the fake transport must not leak past the test.
test.afterEach(() => {
  if (globalThis.fetch !== originalFetch) globalThis.fetch = originalFetch;
});

// Runs after the suite even when tests fail: restore cwd/env/fetch and remove
// the owned temp directory.
test.after(cleanup);

// ── Legacy preserved ─────────────────────────────────────────────────────────

test("unset selection keeps the legacy OpenRouter guard with zero requests", async () => {
  const transport = installFetch(() => ({ status: 200, body: combinedEnvelope() }));
  try {
    const recommendResult = await recommendExecute(makeCtx());
    assert.equal(recommendResult.errors[0], "OPENROUTER_API_KEY not configured");
    const menuResult = await menuVisionExecute(makeCtx());
    assert.equal(menuResult.errors[0], "OPENROUTER_API_KEY not configured");
    assert.equal(transport.records.length, 0);
  } finally {
    transport.restore();
  }
});

test("unset selection still reaches the legacy OpenRouter provider exactly once", async () => {
  process.env.OPENROUTER_API_KEY = "sk-legacy-synthetic";
  const transport = installFetch((url) =>
    url.includes("openrouter.ai")
      ? { status: 200, body: combinedEnvelope() }
      : { status: 429, body: { error: "unexpected" } },
  );
  try {
    const result = await recommendExecute(makeCtx());
    assert.equal(result.candidates.length, 1);
    const candidate = result.candidates[0]!;
    assert.equal(candidate.displayName, "Test IPA");
    assert.equal(candidate.style, "IPA");
    assert.equal(candidate.ibu, 45);
    assert.equal(candidate.price, 38);
    assert.equal(candidate.volumeMl, 330);
    assert.match(candidate.evidence[0]!.summary, /Test IPA/);

    assert.equal(transport.records.length, 1);
    assert.equal(transport.records[0]!.url, OPENROUTER_URL);
    assert.equal(transport.records[0]!.auth, "Bearer sk-legacy-synthetic");
  } finally {
    transport.restore();
  }
});

// ── Package opt-in happy path ─────────────────────────────────────────────────

test("package mode: recommend skill uses only the package key and one package provider", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  const transport = installFetch((url) =>
    url === CODING_PLAN_URL
      ? { status: 200, body: combinedEnvelope() }
      : { status: 500, body: { error: "must not be called" } },
  );
  try {
    const result = await recommendExecute(makeCtx());
    assert.equal(result.errors.length, 0);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.style, "IPA");
    assert.equal(result.candidates[0]!.ibu, 45);

    assert.equal(transport.records.length, 1);
    const record = transport.records[0]!;
    assert.equal(record.url, CODING_PLAN_URL);
    assert.equal(record.auth, "Bearer pkg-synthetic-key");
    assert.equal(record.model, "doubao-seed-evolving");
  } finally {
    transport.restore();
  }
});

test("package mode: menu-vision skill needs no OpenRouter key or guard", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  const transport = installFetch((url) =>
    url === CODING_PLAN_URL
      ? { status: 200, body: combinedEnvelope() }
      : { status: 500, body: { error: "must not be called" } },
  );
  try {
    const result = await menuVisionExecute(makeCtx());
    assert.deepEqual(result.errors, []);
    assert.equal(result.reply, "识别到 1 款啤酒");
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.displayName, "Test IPA");
    assert.ok(result.profileSummary.length > 0);

    assert.equal(transport.records.length, 1);
    assert.equal(transport.records[0]!.url, CODING_PLAN_URL);
    assert.ok(!transport.records.some((r) => r.url.includes("openrouter.ai")));
  } finally {
    transport.restore();
  }
});

// ── Fail-closed selections ───────────────────────────────────────────────────

test("unknown provider selection fails closed with zero requests", () => {
  process.env.BEER_VISION_PROVIDER = "some-other-provider";
  assert.throws(
    () => resolveImageRoute(),
    (err: unknown) => err instanceof VisionAllProvidersFailedError && err instanceof VisionError,
  );
});

test("unknown provider selection fails closed in both skills with zero requests", async () => {
  process.env.BEER_VISION_PROVIDER = "some-other-provider";
  const transport = installFetch(() => ({ status: 200, body: combinedEnvelope() }));
  try {
    const recommendResult = await recommendExecute(makeCtx());
    assert.ok(recommendResult.errors.length > 0);
    assert.equal(recommendResult.candidates.length, 0);
    const menuResult = await menuVisionExecute(makeCtx());
    assert.ok(menuResult.errors.length > 0);
    assert.equal(transport.records.length, 0);
  } finally {
    transport.restore();
  }
});

test("package mode without the package key fails as AUTH before any request", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  assert.throws(
    () => resolveImageCall(),
    (err: unknown) => err instanceof VisionAuthError && err.code === "AUTH",
  );
  const transport = installFetch(() => ({ status: 200, body: combinedEnvelope() }));
  try {
    const recommendResult = await recommendExecute(makeCtx());
    assert.match(recommendResult.errors[0]!, /not configured/);
    const menuResult = await menuVisionExecute(makeCtx());
    assert.match(menuResult.errors[0]!, /not configured/);
    assert.equal(transport.records.length, 0);
  } finally {
    transport.restore();
  }
});

// ── No paid fallback on package failures ─────────────────────────────────────

test("package 429 has no fallthrough despite legacy keys and container override", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  process.env.OPENROUTER_API_KEY = "sk-legacy-synthetic";
  vision.config({
    capabilityProviders: {
      beer_menu_image: [
        { provider: "openrouter", models: ["qwen/qwen3-vl-32b-instruct"], timeoutMs: 180_000 },
      ],
    },
    fallbackProviders: [
      { provider: "openrouter", models: ["paid-fallback-model"], timeoutMs: 180_000 },
    ],
  });
  const transport = installFetch((url) =>
    url === CODING_PLAN_URL
      ? { status: 429, body: { error: { message: "rate limited" } } }
      : { status: 200, body: combinedEnvelope() },
  );
  try {
    const result = await recommendExecute(makeCtx());
    assert.ok(result.errors.length > 0);
    assert.equal(transport.records.filter((r) => r.url === CODING_PLAN_URL).length, 1);
    assert.equal(transport.records.filter((r) => r.url.includes("openrouter.ai")).length, 0);
  } finally {
    transport.restore();
    vision.config({ capabilityProviders: undefined, fallbackProviders: undefined });
  }
});

test("package malformed content has no fallthrough despite legacy keys", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  process.env.OPENROUTER_API_KEY = "sk-legacy-synthetic";
  const transport = installFetch((url) =>
    url === CODING_PLAN_URL
      ? { status: 200, body: "this is not a json envelope" }
      : { status: 200, body: combinedEnvelope() },
  );
  try {
    const result = await recommendExecute(makeCtx());
    assert.ok(result.errors.length > 0);
    assert.equal(transport.records.filter((r) => r.url === CODING_PLAN_URL).length, 1);
    assert.equal(transport.records.filter((r) => r.url.includes("openrouter.ai")).length, 0);
  } finally {
    transport.restore();
  }
});

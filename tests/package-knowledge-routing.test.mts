/**
 * Offline routing tests for package-only Agent text: intent selection and
 * beer-knowledge answers.
 *
 * The runtime under test is the REAL controller runAgentTurn and the REAL
 * beer-knowledge execute — the method under test is never mocked. Only the
 * HTTP transport is faked; text is synthetic and the profile/memory state
 * is empty.
 *
 * Isolation: runtime modules capture process.cwd() while loading, so this
 * file creates an empty temp directory (with memory reads disabled) and
 * chdirs into it BEFORE importing any runtime module. Original
 * cwd/env/fetch are restored and the temp directory removed after the
 * run — even on failure — so no caller configuration, memory, DB, or
 * state is ever touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentContext } from "../lib/agent/types.ts";
import type { BeerDialogRequest, BeerDialogResponse } from "../lib/beer-agent/dialog-types.ts";
import type * as KnowledgeMod from "../lib/skills/beer-knowledge/execute.ts";
import type * as ControllerMod from "../lib/agent/controller.ts";

const ENV_KEYS = [
  "BEER_VISION_PROVIDER",
  "CODING_PLAN_API_KEY",
  "OPENROUTER_API_KEY",
];

// ── Owned sandbox: snapshot caller state before touching anything ────────────
const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
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
  if (process.cwd() !== originalCwd) {
    try { process.chdir(originalCwd); } catch { /* best effort */ }
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}

let knowledgeExecute: typeof KnowledgeMod.execute;
let runAgentTurn: typeof ControllerMod.runAgentTurn;

try {
  tempRoot = await mkdtemp(path.join(tmpdir(), "beer-package-knowledge-"));
  process.chdir(tempRoot);
  // Deterministically disable memory reads; lives entirely in owned temp cwd.
  await mkdir("data", { recursive: true });
  await writeFile(
    "data/pipeline-config.json",
    JSON.stringify({ memoryExperiment: { enabled: false } }),
  );
  // Type-only imports above are erased; runtime evaluation starts here.
  ({ execute: knowledgeExecute } = await import(
    "../lib/skills/beer-knowledge/execute.ts"
  ));
  ({ runAgentTurn } = await import("../lib/agent/controller.ts"));
} catch (err) {
  await cleanup();
  throw err;
}

const PACKAGE_URL =
  "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const KNOWLEDGE_CONTENT =
  "NEIPA 是一种浑浊印度淡色艾尔（合成测试回答，不代表真实模型输出）。";
const SELECTION_CONTENT = JSON.stringify({
  skill: "beer-knowledge",
  reason: "synthetic selection",
  params: { question: "synthetic" },
});

type Outcome = { status: number; body: unknown };

type Rec = {
  url: string;
  auth: string | null;
  model: string | null;
  body: Record<string, unknown>;
};

function installFetch(
  handler: (url: string, body: Record<string, unknown>) => Outcome,
): { recs: Rec[]; restore: () => void } {
  const recs: Rec[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const rawBody = String(init?.body ?? "");
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { /* fake */ }
    const outcome = handler(url, body);
    const headers = init?.headers as Record<string, string> | undefined;
    recs.push({
      url,
      auth: headers?.authorization ?? null,
      model: typeof body.model === "string" ? body.model : null,
      body,
    });
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    recs,
    restore() { globalThis.fetch = original; },
  };
}

/** Default routing: package URL serves selector + knowledge; others blocked. */
function defaultHandler(url: string, body: Record<string, unknown>): Outcome {
  if (url !== PACKAGE_URL) return { status: 500, body: { error: "must not be called" } };
  const isSelector = JSON.stringify(body.messages ?? []).includes("技能调度器");
  return isSelector
    ? { status: 200, body: { choices: [{ message: { content: SELECTION_CONTENT } }] } }
    : { status: 200, body: { choices: [{ message: { content: KNOWLEDGE_CONTENT } }] } };
}

function knowledgeEnvelope(content: string): { choices: Array<{ message: { content: string } }> } {
  return { choices: [{ message: { content } }] };
}

function makeCtx(): AgentContext {
  return {
    userId: "pkg-knowledge-user",
    conversationId: "pkg-knowledge-conv",
    traceId: "pkg-knowledge-trace",
    hasImage: false,
    lastUserText: "什么是NEIPA？",
    messages: [{ role: "user", content: "什么是NEIPA？" }],
    channel: "feishu",
  };
}

function makeRequest(text: string): BeerDialogRequest {
  return {
    userId: "pkg-knowledge-user",
    conversationId: "pkg-knowledge-conv",
    turnId: "pkg-knowledge-turn",
    channel: "feishu",
    messages: [{ role: "user", content: text }],
  };
}

test.beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

test.afterEach(() => {
  if (globalThis.fetch !== originalFetch) globalThis.fetch = originalFetch;
});

test.after(cleanup);

// ── Package-only knowledge: real skill execute ───────────────────────────────

test("package-only knowledge: real execute answers without any legacy key", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  const transport = installFetch(defaultHandler);
  try {
    const result = await knowledgeExecute(makeCtx(), {});
    assert.deepEqual(result.errors, []);
    assert.equal(result.skillId, "beer-knowledge");
    assert.equal(result.reply, KNOWLEDGE_CONTENT);

    assert.equal(transport.recs.length, 1);
    const rec = transport.recs[0]!;
    assert.equal(rec.url, PACKAGE_URL);
    assert.equal(rec.auth, "Bearer pkg-synthetic-key");
    assert.equal(rec.model, "doubao-seed-evolving");
    assert.equal(rec.body.max_tokens, 12_000);
    assert.equal(rec.body.stream, false);
    assert.deepEqual(rec.body.thinking, { type: "enabled" });
  } finally {
    transport.restore();
  }
});

// ── Package-only knowledge: real controller turn (rule-routed knowledge) ─────

test("package-only knowledge followup: real controller turn, rule-routed, no legacy key", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  const transport = installFetch(defaultHandler);
  try {
    const response: BeerDialogResponse = await runAgentTurn(makeRequest("什么是NEIPA？"));
    assert.equal(response.reply, KNOWLEDGE_CONTENT);
    assert.equal(response.intentResult.intent, "beer_knowledge");
    assert.equal(response.intentResult.source, "rule");
    assert.equal((response.debug?.warnings ?? []).length, 0);

    assert.equal(transport.recs.filter((r) => r.url === PACKAGE_URL).length, 1);
    assert.equal(transport.recs.filter((r) => r.url === OPENROUTER_URL).length, 0);
    assert.equal(transport.recs[0]!.auth, "Bearer pkg-synthetic-key");
  } finally {
    transport.restore();
  }
});

// ── Package-only intent selection (LLM path) ─────────────────────────────────

test("package-only intent selection: unmatched text reaches the selector via the fixed package transport", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  const transport = installFetch(defaultHandler);
  try {
    // No keyword rule matches this; deterministic short-circuit requires
    // specific phrases + active menu, so it falls through to the LLM.
    const response = await runAgentTurn(makeRequest("哎呀，随便聊点东西吧"));
    assert.equal(response.intentResult.source, "llm");
    assert.equal(response.intentResult.intent, "beer_knowledge");
    assert.equal(response.reply, KNOWLEDGE_CONTENT);

    // Exactly two package requests: selector + knowledge; no legacy call.
    assert.equal(transport.recs.length, 2);
    assert.ok(transport.recs.every((r) => r.url === PACKAGE_URL));
    assert.equal(transport.recs.filter((r) => r.url === OPENROUTER_URL).length, 0);
    for (const rec of transport.recs) {
      assert.equal(rec.model, "doubao-seed-evolving");
      assert.equal(rec.body.max_tokens, 12_000);
    }
  } finally {
    transport.restore();
  }
});

// ── Rule-routed purchase followups stay model-free ───────────────────────────

test("rule-routed purchase followup remains model-free with zero requests", async () => {
  const transport = installFetch(defaultHandler);
  try {
    const response = await runAgentTurn(makeRequest("第2款怎么样"));
    assert.equal(response.intentResult.source, "rule");
    assert.match(response.reply, /酒单/);
    assert.equal(transport.recs.length, 0);
  } finally {
    transport.restore();
  }
});

// ── Fail-closed through the real callers ─────────────────────────────────────

test("unknown selector fails closed through the real controller with zero requests", async () => {
  process.env.BEER_VISION_PROVIDER = "some-other-provider";
  const transport = installFetch(defaultHandler);
  try {
    const response = await runAgentTurn(makeRequest("什么是NEIPA？"));
    assert.equal((response.debug?.warnings ?? []).length, 1);
    // Handler error maps the public intent to the unclear fallback.
    assert.equal(response.intentResult.intent, "unclear");
    assert.equal(transport.recs.length, 0);
  } finally {
    transport.restore();
  }
});

test("package mode without the package key fails closed with zero requests", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  const transport = installFetch(defaultHandler);
  try {
    const response = await runAgentTurn(makeRequest("什么是NEIPA？"));
    const warnings = response.debug?.warnings ?? [];
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /not configured/);
    assert.equal(transport.recs.length, 0);
  } finally {
    transport.restore();
  }
});

test("package 429 has exactly one request and no paid fallback despite a legacy key", async () => {
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  process.env.CODING_PLAN_API_KEY = "pkg-synthetic-key";
  process.env.OPENROUTER_API_KEY = "sk-legacy-synthetic";
  const transport = installFetch((url: string) =>
    url === PACKAGE_URL
      ? { status: 429, body: { error: { message: "rate limited" } } }
      : { status: 200, body: knowledgeEnvelope("unexpected") },
  );
  try {
    const response = await runAgentTurn(makeRequest("什么是NEIPA？"));
    assert.equal((response.debug?.warnings ?? []).length, 1);
    assert.equal(transport.recs.filter((r) => r.url === PACKAGE_URL).length, 1);
    assert.equal(transport.recs.filter((r) => r.url === OPENROUTER_URL).length, 0);
  } finally {
    transport.restore();
  }
});

// ── Legacy unset delegation preserved through the real controller ────────────

test("legacy unset selection still answers via OpenRouter when the legacy key is present", async () => {
  process.env.OPENROUTER_API_KEY = "sk-legacy-synthetic";
  const transport = installFetch((url: string) =>
    url === OPENROUTER_URL
      ? { status: 200, body: knowledgeEnvelope("legacy answer") }
      : { status: 500, body: { error: "must not be called" } },
  );
  try {
    const response = await runAgentTurn(makeRequest("什么是NEIPA？"));
    assert.equal((response.debug?.warnings ?? []).length, 0);
    assert.equal(response.reply, "legacy answer");
    assert.equal(transport.recs.length, 1);
    assert.equal(transport.recs[0]!.url, OPENROUTER_URL);
    assert.equal(transport.recs[0]!.auth, "Bearer sk-legacy-synthetic");
    // Legacy body keeps its original Qwen model and caps.
    assert.equal(transport.recs[0]!.model, "qwen/qwen-2.5-72b-instruct");
    assert.equal(transport.recs[0]!.body.max_tokens, 1500);
  } finally {
    transport.restore();
  }
});

test("legacy unset selection keeps the legacy missing-key guard with zero requests", async () => {
  const transport = installFetch(() => ({ status: 200, body: knowledgeEnvelope("unexpected") }));
  try {
    const response = await runAgentTurn(makeRequest("什么是NEIPA？"));
    const warnings = response.debug?.warnings ?? [];
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /OPENROUTER_API_KEY not configured/);
    assert.equal(transport.recs.length, 0);
  } finally {
    transport.restore();
  }
});

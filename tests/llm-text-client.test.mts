import test from "node:test";
import assert from "node:assert/strict";
import { agentTextFetch, AgentTextError } from "../lib/beer-agent/text-client.ts";
import { resolveAgentTextRoute } from "../lib/beer-agent/text-routing.ts";

const ENV_KEYS = [
  "BEER_TEXT_PROVIDER",
  "BEER_VISION_PROVIDER",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_MAX_TOKENS",
  "CODING_PLAN_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

function setEnv(values: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
}

const baseEnv = {
  BEER_TEXT_PROVIDER: "llm",
  BEER_VISION_PROVIDER: "deepseek",
  LLM_BASE_URL: "https://llm.example/v1",
  LLM_API_KEY: "synthetic-llm-key-2026",
  LLM_MODEL: "synthetic-llm-model",
};

test("llm route resolves explicitly and sends one request to LLM_BASE_URL", async () => {
  setEnv(baseEnv);
  assert.deepEqual(resolveAgentTextRoute(), { route: { mode: "llm" }, error: null, field: null });
  const calls: Array<{ url: string; auth: string | null; body: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({
      url: String(input),
      auth: (init.headers as Record<string, string>)?.authorization ?? null,
      body: JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify({
      choices: [{ message: { content: "合成回答：保留当前菜单上下文。" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const content = await agentTextFetch({
      messages: [{ role: "user", content: "哪款酒花最香？" }],
      max_tokens: 1500,
      temperature: 0.3,
    }, { timeoutMs: 5_000 });
    assert.equal(content, "合成回答：保留当前菜单上下文。");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://llm.example/v1/chat/completions");
    assert.equal(calls[0].auth, "Bearer synthetic-llm-key-2026");
    assert.equal(calls[0].body.model, "synthetic-llm-model");
    assert.ok(calls[0].body.max_tokens >= 4_096, "reasoning-capable model needs room for content");
    assert.equal(calls[0].body.temperature, 0.3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("llm route fails closed without each configured field and never echoes the key", async () => {
  for (const missing of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) {
    setEnv({ ...baseEnv, [missing]: undefined });
    await assert.rejects(
      () => agentTextFetch({ messages: [{ role: "user", content: "hi" }] }),
      (error: unknown) => error instanceof AgentTextError &&
        error.code === "AUTH" &&
        !error.message.includes("synthetic-llm-key-2026"),
      missing,
    );
  }
});

test("llm HTTP status is classified without copying the upstream body", async () => {
  setEnv(baseEnv);
  const originalFetch = globalThis.fetch;
  for (const [status, code] of [[401, "AUTH"], [429, "RATE_LIMIT"], [503, "NETWORK"]] as const) {
    globalThis.fetch = (async () => new Response("synthetic-secret-upstream-body", { status })) as typeof fetch;
    try {
      await assert.rejects(
        () => agentTextFetch({ messages: [{ role: "user", content: "hi" }] }, { timeoutMs: 2_000 }),
        (error: unknown) => error instanceof AgentTextError &&
          error.code === code &&
          !error.message.includes("synthetic-secret-upstream-body"),
        String(status),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("an already-aborted llm turn makes zero requests", async () => {
  setEnv(baseEnv);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls += 1; return new Response("{}"); }) as typeof fetch;
  try {
    await assert.rejects(
      () => agentTextFetch(
        { messages: [{ role: "user", content: "hi" }] },
        { signal: controller.signal },
      ),
      (error: unknown) => error instanceof AgentTextError && error.code === "TIMEOUT",
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("empty llm content is a parse failure, not an empty answer", async () => {
  setEnv(baseEnv);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    await assert.rejects(
      () => agentTextFetch({ messages: [{ role: "user", content: "hi" }] }, { timeoutMs: 2_000 }),
      (error: unknown) => error instanceof AgentTextError && error.code === "PARSE",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

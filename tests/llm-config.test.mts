/**
 * tests/llm-config.test.mts
 *
 * Unit tests for env loading + config error reporting. Does NOT touch
 * process.env — passes a stub record directly so the test is hermetic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLLMConfig } from "../lib/harness/llm/config.ts";
import { LLMConfigError } from "../lib/harness/llm/provider.ts";

test("loadLLMConfig: accepts a complete openai-compatible config", () => {
  const cfg = loadLLMConfig({
    LLM_PROVIDER: "openai-compatible",
    LLM_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3/",
    LLM_API_KEY: "ark-xxx",
    LLM_MODEL: "doubao-seed-evolving",
    LLM_TEMPERATURE: "0.3",
    LLM_MAX_TOKENS: "1024",
  });
  assert.equal(cfg.provider, "openai-compatible");
  // Trailing slash is trimmed so request URLs concatenate safely.
  assert.equal(cfg.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  assert.equal(cfg.apiKey, "ark-xxx");
  assert.equal(cfg.model, "doubao-seed-evolving");
  assert.equal(cfg.temperature, 0.3);
  assert.equal(cfg.maxTokens, 1024);
});

test("loadLLMConfig: throws on unknown provider", () => {
  assert.throws(
    () => loadLLMConfig({ LLM_PROVIDER: "anthropic", LLM_BASE_URL: "x", LLM_API_KEY: "x", LLM_MODEL: "x" }),
    /only "openai-compatible"/,
  );
});

test("loadLLMConfig: throws when BASE_URL is empty", () => {
  assert.throws(
    () => loadLLMConfig({ LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "x", LLM_MODEL: "x" }),
    LLMConfigError,
  );
});

test("loadLLMConfig: throws when API_KEY is empty", () => {
  assert.throws(
    () => loadLLMConfig({ LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: "x", LLM_MODEL: "x" }),
    /LLM_API_KEY/,
  );
});

test("loadLLMConfig: throws when MODEL is empty", () => {
  assert.throws(
    () => loadLLMConfig({ LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: "x", LLM_API_KEY: "x" }),
    /LLM_MODEL/,
  );
});

test("loadLLMConfig: falls back to defaults when temperature/max_tokens missing", () => {
  const cfg = loadLLMConfig({
    LLM_PROVIDER: "openai-compatible",
    LLM_BASE_URL: "x",
    LLM_API_KEY: "x",
    LLM_MODEL: "y",
  });
  assert.equal(cfg.temperature, 0.4);
  assert.equal(cfg.maxTokens, 2048);
});

test("loadLLMConfig: tolerates non-numeric temperature without crashing", () => {
  const cfg = loadLLMConfig({
    LLM_PROVIDER: "openai-compatible",
    LLM_BASE_URL: "x",
    LLM_API_KEY: "x",
    LLM_MODEL: "y",
    LLM_TEMPERATURE: "NaN-ish",
    LLM_MAX_TOKENS: "-3",
  });
  // NaN-ish → not finite → falls back to 0.4; max_tokens ≤ 0 → 2048.
  assert.equal(cfg.temperature, 0.4);
  assert.equal(cfg.maxTokens, 2048);
});
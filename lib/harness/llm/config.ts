/**
 * Harness LLM — environment loader.
 *
 * Reads LLM_* env vars and returns a normalised config object. Centralised
 * so every adapter and prompt builder can pull from the same source.
 *
 * Validation is intentionally permissive: we surface a `LLMConfigError`
 * with a clear message rather than crashing the server on missing keys.
 */

import { LLMConfigError } from "./provider.ts";

export interface LLMConfig {
  provider: "openai-compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Trim trailing slash so request paths can safely concatenate with "/chat/...".
 */
function stripSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function loadLLMConfig(env: Record<string, string | undefined> = process.env): LLMConfig {
  const provider = (env.LLM_PROVIDER ?? "openai-compatible").trim();
  if (provider !== "openai-compatible") {
    // v1 only ships the openai-compat adapter.
    throw new LLMConfigError(
      `LLM_PROVIDER="${provider}" not supported in v1 (only "openai-compatible").`,
    );
  }

  const baseUrl = (env.LLM_BASE_URL ?? "").trim();
  const apiKey = (env.LLM_API_KEY ?? "").trim();
  const model = (env.LLM_MODEL ?? "").trim();

  if (!baseUrl) throw new LLMConfigError("LLM_BASE_URL is empty");
  if (!apiKey) throw new LLMConfigError("LLM_API_KEY is empty");
  if (!model) throw new LLMConfigError("LLM_MODEL is empty");

  const temperature = Number(env.LLM_TEMPERATURE ?? "0.4");
  const maxTokens = Number(env.LLM_MAX_TOKENS ?? "2048");

  return {
    provider,
    baseUrl: stripSlash(baseUrl),
    apiKey,
    model,
    temperature: Number.isFinite(temperature) ? temperature : 0.4,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 2048,
  };
}

/**
 * Cached singleton — env does not change at runtime, so parse once per
 * process. Tests can call `loadLLMConfig({ ... })` directly with a stub.
 */
let _cached: LLMConfig | null = null;
export function getLLMConfig(): LLMConfig {
  if (!_cached) _cached = loadLLMConfig();
  return _cached;
}

/** Test helper — resets the module cache. */
export function _resetLLMConfigForTests(): void {
  _cached = null;
}
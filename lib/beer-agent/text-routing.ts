/**
 * Resolve Agent text transport independently from the image transport.
 *
 * BEER_TEXT_PROVIDER explicitly accepts "coding-plan", "openrouter" or
 * "llm" (the existing OpenAI-compatible LLM_BASE_URL/LLM_API_KEY/LLM_MODEL
 * entry). When it is absent, the historical shared selector behavior is preserved:
 * no image selector means legacy OpenRouter, and an image "coding-plan"
 * selector also selects package text. Anthropic or DeepSeek vision instead
 * requires an explicit text selector so enabling either cannot silently enable
 * a paid text request. Neither is a text provider here.
 *
 * This is a pure environment read: no key values, requests, or cached route.
 */
import {
  ANTHROPIC_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  IMAGE_ROUTE_ENV,
  PACKAGE_PROVIDER_ID,
} from "../multimodal/image-routing.ts";

export const TEXT_ROUTE_ENV = "BEER_TEXT_PROVIDER";
export const LEGACY_TEXT_PROVIDER_ID = "openrouter";
export const LLM_TEXT_PROVIDER_ID = "llm";

export type AgentTextRoute = { mode: "legacy" | "package" | "llm" };
export type AgentTextRouteResolution = {
  route: AgentTextRoute | null;
  error: "missing" | "unsupported" | null;
  field: typeof TEXT_ROUTE_ENV | typeof IMAGE_ROUTE_ENV | null;
};

export function resolveAgentTextRoute(
  env: Record<string, string | undefined> = process.env,
): AgentTextRouteResolution {
  const text = env[TEXT_ROUTE_ENV]?.trim() ?? "";
  if (text === PACKAGE_PROVIDER_ID) {
    return { route: { mode: "package" }, error: null, field: null };
  }
  if (text === LEGACY_TEXT_PROVIDER_ID) {
    return { route: { mode: "legacy" }, error: null, field: null };
  }
  if (text === LLM_TEXT_PROVIDER_ID) {
    return { route: { mode: "llm" }, error: null, field: null };
  }
  if (text !== "") {
    return { route: null, error: "unsupported", field: TEXT_ROUTE_ENV };
  }

  const image = env[IMAGE_ROUTE_ENV]?.trim() ?? "";
  if (image === ANTHROPIC_PROVIDER_ID || image === DEEPSEEK_PROVIDER_ID) {
    return { route: null, error: "missing", field: TEXT_ROUTE_ENV };
  }
  if (image === PACKAGE_PROVIDER_ID) {
    return { route: { mode: "package" }, error: null, field: null };
  }
  if (image === "") {
    return { route: { mode: "legacy" }, error: null, field: null };
  }
  return { route: null, error: "unsupported", field: IMAGE_ROUTE_ENV };
}

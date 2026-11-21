/**
 * Shared image routing + credential resolution.
 *
 * Opt-in only: when BEER_VISION_PROVIDER is unset or blank the existing
 * legacy behavior is preserved (OPENROUTER_API_KEY, capability default
 * chains). Setting it to "coding-plan", "anthropic" or "deepseek" pins image
 * calls to exactly one explicit provider/model attempt. The historical
 * "package" mode label means this pinned route; it does not imply a Coding
 * Plan request when another provider is selected. Any other nonblank value
 * fails closed with a typed
 * VisionError before a model request can be made.
 *
 * Environment is read at call time — it is never cached here. Keys are
 * never read for logging, telemetry, or inclusion in errors; this module
 * only reports whether the selected credential is present.
 */

import type { ProviderSpec } from "./types.ts";
import {
  VisionAllProvidersFailedError,
  VisionAuthError,
} from "./errors.ts";

export const IMAGE_ROUTE_ENV = "BEER_VISION_PROVIDER";
export const PACKAGE_KEY_ENV = "CODING_PLAN_API_KEY";
export const ANTHROPIC_KEY_ENV = "ANTHROPIC_API_KEY";
export const DEEPSEEK_KEY_ENV = "DEEPSEEK_API_KEY";
export const LEGACY_KEY_ENV = "OPENROUTER_API_KEY";

export const PACKAGE_PROVIDER_ID = "coding-plan";
export const PACKAGE_MODEL = "doubao-seed-evolving";
export const PACKAGE_TIMEOUT_MS = 180_000;
export const ANTHROPIC_PROVIDER_ID = "anthropic";
export const ANTHROPIC_MODEL = "claude-opus-5";
export const ANTHROPIC_TIMEOUT_MS = 180_000;
export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const DEEPSEEK_MODEL = "deepseek-flash";
export const DEEPSEEK_TIMEOUT_MS = 180_000;

const MSG = {
  unsupported: "Unsupported image vision provider selection",
  missingPackageKey: "coding-plan vision API key is not configured",
  missingAnthropicKey: "anthropic vision API key is not configured",
  missingDeepSeekKey: "deepseek vision API key is not configured",
} as const;

export type ImageRoute =
  | { mode: "legacy" }
  | { mode: "package"; providers: ProviderSpec[] };

/**
 * Resolve the image route from BEER_VISION_PROVIDER.
 * Throws a typed, non-retriable VisionError for an unknown selection.
 */
export function resolveImageRoute(): ImageRoute {
  const selection = process.env[IMAGE_ROUTE_ENV];
  if (typeof selection !== "string" || selection.trim() === "") {
    return { mode: "legacy" };
  }
  const value = selection.trim();
  if (
    value === PACKAGE_PROVIDER_ID ||
    value === ANTHROPIC_PROVIDER_ID ||
    value === DEEPSEEK_PROVIDER_ID
  ) {
    const model = value === PACKAGE_PROVIDER_ID
      ? PACKAGE_MODEL
      : value === ANTHROPIC_PROVIDER_ID
        ? ANTHROPIC_MODEL
        : DEEPSEEK_MODEL;
    const timeoutMs = value === PACKAGE_PROVIDER_ID
      ? PACKAGE_TIMEOUT_MS
      : value === ANTHROPIC_PROVIDER_ID
        ? ANTHROPIC_TIMEOUT_MS
        : DEEPSEEK_TIMEOUT_MS;
    const providers: ProviderSpec[] = [
      { provider: value, models: [model], timeoutMs },
    ];
    return { mode: "package", providers };
  }
  throw new VisionAllProvidersFailedError(MSG.unsupported);
}

export type ResolvedImageCall =
  | { mode: "legacy"; apiKey: string }
  | { mode: "package"; apiKey: ""; providers: ProviderSpec[] };

/**
 * Resolve route + credential rules for an image skill call.
 *
 *  - legacy: returns the OPENROUTER_API_KEY value; the caller keeps its
 *    existing missing-key guard.
 *  - package (pinned): requires the selected provider's nonblank key or
 *    fails as AUTH before any request can be issued. Returns an empty apiKey
 *    so no sentinel is fabricated for the legacy OpenRouter credential.
 */
export function resolveImageCall(): ResolvedImageCall {
  const route = resolveImageRoute();
  if (route.mode === "legacy") {
    return {
      mode: "legacy",
      apiKey: process.env[LEGACY_KEY_ENV] ?? "",
    };
  }
  const spec = route.providers[0]!;
  const keyEnv = spec.provider === ANTHROPIC_PROVIDER_ID
    ? ANTHROPIC_KEY_ENV
    : spec.provider === DEEPSEEK_PROVIDER_ID
      ? DEEPSEEK_KEY_ENV
      : PACKAGE_KEY_ENV;
  const missingMessage = spec.provider === ANTHROPIC_PROVIDER_ID
    ? MSG.missingAnthropicKey
    : spec.provider === DEEPSEEK_PROVIDER_ID
      ? MSG.missingDeepSeekKey
      : MSG.missingPackageKey;
  const key = process.env[keyEnv];
  if (typeof key !== "string" || key.trim() === "") {
    throw new VisionAuthError(
      missingMessage,
      spec.provider,
      spec.models[0],
    );
  }
  return { mode: "package", apiKey: "", providers: route.providers };
}

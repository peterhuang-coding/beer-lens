/**
 * Shared image routing + credential resolution.
 *
 * Opt-in only: when BEER_VISION_PROVIDER is unset or blank the existing
 * legacy behavior is preserved (OPENROUTER_API_KEY, capability default
 * chains). Setting it to the exact value "coding-plan" pins image calls to
 * one fixed package provider attempt:
 *
 *   [{ provider: "coding-plan",
 *      models: ["doubao-seed-evolving"],
 *      timeoutMs: 180000 }]
 *
 * Any other nonblank value fails closed with a typed VisionError before a
 * model request can be made.
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
export const LEGACY_KEY_ENV = "OPENROUTER_API_KEY";

export const PACKAGE_PROVIDER_ID = "coding-plan";
export const PACKAGE_MODEL = "doubao-seed-evolving";
export const PACKAGE_TIMEOUT_MS = 180_000;

const MSG = {
  unsupported: "Unsupported image vision provider selection",
  missingKey: "coding-plan vision API key is not configured",
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
  if (value === PACKAGE_PROVIDER_ID) {
    const providers: ProviderSpec[] = [
      {
        provider: PACKAGE_PROVIDER_ID,
        models: [PACKAGE_MODEL],
        timeoutMs: PACKAGE_TIMEOUT_MS,
      },
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
 *  - package: requires a nonblank CODING_PLAN_API_KEY or fails as AUTH
 *    before any request can be issued. Returns an empty apiKey — no
 *    sentinel value is fabricated for the legacy credential.
 */
export function resolveImageCall(): ResolvedImageCall {
  const route = resolveImageRoute();
  if (route.mode === "legacy") {
    return {
      mode: "legacy",
      apiKey: process.env[LEGACY_KEY_ENV] ?? "",
    };
  }
  const key = process.env[PACKAGE_KEY_ENV];
  if (typeof key !== "string" || key.trim() === "") {
    throw new VisionAuthError(
      MSG.missingKey,
      PACKAGE_PROVIDER_ID,
      PACKAGE_MODEL,
    );
  }
  return { mode: "package", apiKey: "", providers: route.providers };
}

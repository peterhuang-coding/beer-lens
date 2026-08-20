/**
 * Multimodal container — public surface.
 *
 * Anywhere in the app:
 *
 *   import { vision, suggest, VisionError } from "@/lib/multimodal";
 *
 *   try {
 *     const r = await vision.call("beer_menu_image", {
 *       image: { base64, mime },
 *       prompt: "你是啤酒图像分析器…",
 *       schema: combinedVisionSchema(),
 *     });
 *     const data = r.parsed; // already parsed JSON when schema was provided
 *   } catch (e) {
 *     if (e instanceof VisionError) {
 *       const copy = suggest(e);
 *       // … show copy to user, fall through to type-the-name flow
 *     }
 *   }
 *
 * Side-effect: importing this module registers the built-in providers and
 * capabilities. No explicit init needed.
 *
 * Note: relative imports below so this module is also importable from
 * Node test runners (which don't honor tsconfig path aliases).
 */

import { container } from "./container.ts";
import {
  _cacheSize as _multimodalCacheSize,
  computeKey as _computeKey,
  invalidateCache as _invalidateCache,
} from "./cache.ts";
import "./providers/openrouter.ts";
import "./capabilities.ts";

export { container as vision } from "./container.ts";
export const _cacheSize = _multimodalCacheSize;
export const computeKey = _computeKey;
export const invalidateCache = _invalidateCache;
export {
  VisionError,
  VisionTimeoutError,
  VisionNetworkError,
  VisionParseError,
  VisionRateLimitError,
  VisionAuthError,
  VisionSizeError,
  VisionAllProvidersFailedError,
  VisionBlockedError,
  classify,
  allProvidersFailed,
} from "./errors.ts";
export { suggest } from "./degrade.ts";
export {
  registerCapability,
  getCapability,
  listCapabilities,
} from "./capabilities.ts";
export {
  registerProvider,
  getProvider,
  listProviders,
} from "./providers/base.ts";
export type {
  VisionImage,
  CapabilityInput,
  VisionCallResult,
  ProviderAttempt,
  ProviderSpec,
} from "./types.ts";
export type { VisionErrorCode } from "./errors.ts";
export type { Capability } from "./capabilities.ts";
export type { VisionProvider } from "./providers/base.ts";
export type { ContainerCallOptions, ContainerConfig } from "./container.ts";
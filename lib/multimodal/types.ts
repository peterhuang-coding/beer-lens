/**
 * Multimodal container — public types.
 *
 * A "capability" is a named vision task (e.g. beer_menu_image, beer_label_check).
 * A "provider" is a backend that can satisfy a capability (currently only
 * openrouter; future: doubao, anthropic-direct).
 *
 * Call sites don't import openrouterFetch directly anymore — they go through
 * `vision.call(capability, input, opts)` which handles fallback, cache,
 * rule-engine hooks, error classification and tracing.
 */

export interface VisionImage {
  /** Raw base64 (no `data:` prefix). */
  base64: string;
  /** MIME type, e.g. "image/jpeg" or "image/png". */
  mime: string;
}

export interface CapabilityInput {
  image: VisionImage;
  /** Prompt text. JSON schema instruction is appended automatically when `schema` is set. */
  prompt: string;
  /** JSON schema for structured output. Optional — pass `undefined` for free-text. */
  schema?: object;
  /** JSON schema name (OpenRouter json_schema.name). Default: "vision_result". */
  schemaName?: string;
  /** Max output tokens. Default: 12000 for vision calls. */
  maxTokens?: number;
}

export interface ProviderAttempt {
  provider: string;
  model: string;
  ok: boolean;
  errorCode?: string;
  durationMs: number;
}

export interface VisionCallResult<T = unknown> {
  /** Raw text content returned by the provider. */
  raw: string;
  /** Best-effort parsed JSON (or the raw string if not JSON). */
  parsed: T;
  /** True if served from cache (provider/model are "cache"). */
  fromCache: boolean;
  /** The provider that succeeded, or "cache" / "all_failed". */
  provider: string;
  /** The model that succeeded. */
  model: string;
  /** Total wall-clock time including any failed attempts. */
  durationMs: number;
  /** Every (provider, model) attempted, in order. Useful for debugging. */
  attempts: ProviderAttempt[];
}

export interface ProviderSpec {
  provider: string;
  models: string[];
  timeoutMs: number;
}
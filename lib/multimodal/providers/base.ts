/**
 * Provider interface + registry.
 *
 * A provider is an opaque backend that satisfies a vision capability.
 * Today: only openrouter. Future: doubao (火山原生), anthropic-direct
 * (bypass OpenRouter), local qwen-vl, etc.
 *
 * Each provider declares how to call its API. The container handles
 * cache, fallback walking, error classification, rule hooks, and tracing
 * — providers just do `input → raw text response`.
 */

import type { CapabilityInput } from "../types.ts";

export interface ProviderCallOptions {
  /** Which specific model within this provider to call. */
  model: string;
  /** Per-attempt timeout in ms. Provider must abort internally. */
  timeoutMs: number;
  /** Optional caller-supplied AbortSignal (e.g. for request cancellation). */
  signal?: AbortSignal;
}

export interface VisionProvider {
  /** Stable id, e.g. "openrouter" / "doubao" / "anthropic". */
  id: string;
  /**
   * Call the provider with the given capability input. Returns raw text
   * content. Throws on any failure — the container classifies and walks
   * the fallback chain.
   */
  call(input: CapabilityInput, opts: ProviderCallOptions): Promise<string>;
}

const _registry = new Map<string, VisionProvider>();

export function registerProvider(p: VisionProvider): void {
  _registry.set(p.id, p);
}

export function getProvider(id: string): VisionProvider | undefined {
  return _registry.get(id);
}

export function listProviders(): VisionProvider[] {
  return Array.from(_registry.values());
}
/**
 * Multimodal container — single entry point for all vision calls.
 *
 * Public API: `container.call(capability, input, opts) → VisionCallResult`.
 *
 * What the container does on each call:
 *   1. emit `vision:enter` trace stage (with capability id, prompt preview)
 *   2. run `pre-vision` hard rules — short-circuit on `block`
 *   3. cache lookup by sha256(capability + prompt + schema + image)
 *      — on hit, emit `vision:cache_hit` and return
 *   4. walk provider chain: for each provider spec, for each model,
 *      call → if success, cache, run `post-vision` rules, return
 *      — on failure, classify error, log `vision:attempt_fail`, continue
 *   5. all providers failed → emit `vision:all_failed`, throw
 *
 * Why a container and not a free function?
 *   - Configurable per-process (env var / runtime PATCH via debug API)
 *   - Single source of truth for cache, fallback policy, trace stages
 *   - Future: rate limit accounting, health checks, provider registration
 */

import { appendStage } from "../harness/trace-buffer.ts";
import { getTraceCtx } from "../harness/trace-context.ts";
import { runRulesForStage } from "../harness/rules-engine.ts";
import type { RuleCtx } from "../harness/rules.ts";

import { getCapability } from "./capabilities.ts";
import { getProvider, listProviders } from "./providers/base.ts";
import {
  classify,
  VisionAllProvidersFailedError,
  VisionBlockedError,
  VisionError,
} from "./errors.ts";
import {
  computeKey,
  getCache,
  setCache,
  invalidateCache as clearCache,
  setCacheTtl,
} from "./cache.ts";
import { suggest } from "./degrade.ts";
import type {
  CapabilityInput,
  ProviderAttempt,
  ProviderSpec,
  VisionCallResult,
} from "./types.ts";

// Auto-register the openrouter provider on container import.
import "./providers/openrouter.ts";

export interface ContainerConfig {
  /** Per-capability provider chain overrides. */
  capabilityProviders?: Record<string, ProviderSpec[]>;
  /** Global cache TTL in ms. 0 = disable caching. Default 60_000. */
  cacheTtlMs?: number;
  /** Default providers to use when a capability has none registered. */
  fallbackProviders?: ProviderSpec[];
}

const _config: ContainerConfig = {};

export function configContainer(patch: Partial<ContainerConfig>): void {
  Object.assign(_config, patch);
  if (typeof patch.cacheTtlMs === "number") setCacheTtl(patch.cacheTtlMs);
}

export interface ContainerCallOptions {
  /** Override the provider chain for this single call. */
  providers?: ProviderSpec[];
  /** Skip cache lookup & write. Default false. */
  bypassCache?: boolean;
  /** Per-call JSON schema (overrides capability default). */
  schema?: object;
  /** Per-call JSON schema name (overrides capability default). */
  schemaName?: string;
  /** Per-call max output tokens. */
  maxTokens?: number;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

async function call<T = unknown>(
  capabilityId: string,
  input: CapabilityInput,
  opts: ContainerCallOptions = {},
): Promise<VisionCallResult<T>> {
  const cap = getCapability(capabilityId);
  if (!cap) {
    throw new VisionAllProvidersFailedError(
      `Unknown capability: ${capabilityId}`,
    );
  }

  const tc = getTraceCtx();
  const trace = tc ? { root_ts: tc.root_ts, parent_ts: tc.parent_ts } : undefined;

  // 1. vision:enter
  if (trace) {
    try {
      appendStage(trace.root_ts, trace.parent_ts, "vision:enter", {
        stage_skill_id: capabilityId,
        message: input.prompt.slice(0, 80),
        has_image: true,
      });
    } catch { /* never let tracing kill the request */ }
  }

  // 2. pre-vision rules — always run (governance isn't trace-dependent).
  //    When there's no trace context, the rule engine gets no trace args
  //    so no stage entries are emitted.
  try {
    const ruleCtx: RuleCtx = {
      message: input.prompt,
      skill_id: capabilityId,
    };
    const outcome = runRulesForStage("pre-vision", ruleCtx, trace);
    if (outcome.action?.kind === "block") {
      throw new VisionBlockedError(outcome.action.reason, capabilityId);
    }
  } catch (e) {
    if (e instanceof VisionBlockedError) throw e;
    // Other rule-engine errors must never break the call
  }

  // 3. cache lookup
  const cacheKey = opts.bypassCache ? null : computeKey(capabilityId, input);
  if (cacheKey) {
    const cached = getCache(cacheKey);
    if (cached !== null) {
      if (trace) {
        try {
          appendStage(trace.root_ts, trace.parent_ts, "vision:cache_hit", {
            stage_skill_id: capabilityId,
            decision: { capability_id: capabilityId, key: cacheKey },
          });
        } catch { /* ignore */ }
      }
      return {
        raw: cached,
        parsed: tryParse(cached) as T,
        fromCache: true,
        provider: "cache",
        model: "cache",
        durationMs: 0,
        attempts: [],
      };
    }
  }

  // 4. walk provider chain
  const providerSpecs: ProviderSpec[] =
    opts.providers ??
    _config.capabilityProviders?.[capabilityId] ??
    cap.defaultProviders ??
    _config.fallbackProviders ??
    [];

  if (providerSpecs.length === 0) {
    throw new VisionAllProvidersFailedError(
      `No providers configured for capability ${capabilityId}`,
    );
  }

  const effectiveInput: CapabilityInput = {
    ...input,
    schema: opts.schema ?? input.schema ?? cap.schema,
    schemaName: opts.schemaName ?? input.schemaName ?? cap.schemaName,
    maxTokens: opts.maxTokens ?? input.maxTokens ?? 12_000,
  };

  const attempts: ProviderAttempt[] = [];

  for (const spec of providerSpecs) {
    const provider = getProvider(spec.provider);
    if (!provider) {
      attempts.push({
        provider: spec.provider,
        model: "(missing)",
        ok: false,
        errorCode: "UNKNOWN",
        durationMs: 0,
      });
      continue;
    }

    for (const model of spec.models) {
      const t0 = Date.now();
      try {
        const raw = await provider.call(effectiveInput, {
          model,
          timeoutMs: spec.timeoutMs,
        });
        const durationMs = Date.now() - t0;
        attempts.push({ provider: spec.provider, model, ok: true, durationMs });

        if (trace) {
          try {
            appendStage(trace.root_ts, trace.parent_ts, "vision:success", {
              stage_skill_id: capabilityId,
              decision: {
                capability_id: capabilityId,
                provider: spec.provider,
                model,
                duration_ms: durationMs,
                attempt_index: attempts.length - 1,
              },
            });
          } catch { /* ignore */ }
        }

        if (cacheKey) setCache(cacheKey, raw);

        // post-vision rules — always run (governance isn't trace-dependent).
        try {
          const parsed = tryParse(raw);
          const ruleCtx: RuleCtx = {
            message: input.prompt,
            skill_id: capabilityId,
            llm_response: parsed,
          };
          const outcome = runRulesForStage("post-vision", ruleCtx, trace);
          if (outcome.action?.kind === "block") {
            throw new VisionBlockedError(outcome.action.reason, capabilityId);
          }
        } catch (e) {
          if (e instanceof VisionBlockedError) throw e;
        }

        return {
          raw,
          parsed: tryParse(raw) as T,
          fromCache: false,
          provider: spec.provider,
          model,
          durationMs,
          attempts,
        };
      } catch (err) {
        const ve = classify(err, spec.provider, model);
        const durationMs = Date.now() - t0;
        attempts.push({
          provider: spec.provider,
          model,
          ok: false,
          errorCode: ve.code,
          durationMs,
        });
        if (trace) {
          try {
            appendStage(trace.root_ts, trace.parent_ts, "vision:attempt_fail", {
              stage_skill_id: capabilityId,
              decision: {
                capability_id: capabilityId,
                provider: spec.provider,
                model,
                error_code: ve.code,
                error_message: ve.message.slice(0, 200),
                duration_ms: durationMs,
                retriable: ve.retriable,
              },
            });
          } catch { /* ignore */ }
        }
        // Non-retriable error → skip the rest of THIS provider's models
        if (!ve.retriable) break;
        // Otherwise → try the next model in this provider's chain
      }
    }
    // Continue to next provider spec
  }

  // 5. all providers failed
  const allFailed = new VisionAllProvidersFailedError(
    `All vision providers failed for ${capabilityId} after ${attempts.length} attempts`,
  );
  if (trace) {
    try {
      appendStage(trace.root_ts, trace.parent_ts, "vision:all_failed", {
        stage_skill_id: capabilityId,
        decision: { capability_id: capabilityId, attempts_count: attempts.length },
        ok: false,
        error_code: allFailed.code,
      });
    } catch { /* ignore */ }
  }
  throw allFailed;
}

function invalidateCache(): void {
  clearCache();
}

function health(): Array<{ id: string; configured: boolean }> {
  return listProviders().map((p) => ({ id: p.id, configured: true }));
}

export const container = {
  call,
  config: configContainer,
  invalidateCache,
  health,
};

// Re-export common types & helpers for ergonomic imports.
export type { VisionError };
export { suggest };
export { computeKey };
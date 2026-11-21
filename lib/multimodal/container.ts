/**
 * Multimodal container — single entry point for all vision calls.
 *
 * Public API: `container.call(capability, input, opts) → VisionCallResult`.
 *
 * What the container does on each call:
 *   1. emit `vision:enter` trace stage (with capability id, prompt preview)
 *   2. run `pre-vision` hard rules — short-circuit on `block`
 *   3. cache lookup by effective request + provider chain
 *      — on hit, rerun post-vision rules, emit `vision:cache_hit` and return
 *   4. walk provider chain: for each provider spec, for each model,
 *      call → if success, run `post-vision` rules, cache accepted result, return
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
  VisionTimeoutError,
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

// Auto-register providers on container import.
import "./providers/openrouter.ts";
import "./providers/deepseek.ts";

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
  /**
   * Optional caller-owned cancellation signal. The SAME object is forwarded
   * verbatim to `provider.call` — the container never aborts it, never
   * derives/combines signals, and owns no deadline timer (the external
   * caller owns the deadline).
   *
   * An already-aborted signal fails the call with a redacted TIMEOUT error
   * before governance side effects, cache lookup, or any provider call.
   * Aborting while a provider is in flight is terminal: the cooperative
   * provider is expected to observe the signal and reject; the container
   * then stops every subsequent model/provider and never caches or returns
   * a result, including one a noncooperative provider might resolve later.
   */
  signal?: AbortSignal;
}

/**
 * Fixed, redacted cancellation copy. `signal.reason`, prompts, images,
 * credentials and provider-produced error text are never copied into this
 * message or into trace decisions.
 */
const CANCELED_MESSAGE = "vision call canceled before completion";

function canceledError(): VisionTimeoutError {
  return new VisionTimeoutError(CANCELED_MESSAGE);
}

type ProviderSettlement =
  | { kind: "resolved"; raw: string }
  | { kind: "rejected"; err: unknown };

/**
 * Invoke one provider attempt, racing its settlement against caller abort.
 *
 * The provider promise is wrapped so it ALWAYS settles to a value: a late
 * rejection after the abort race is therefore swallowed here rather than
 * surfacing as an unhandled rejection, and a late resolution can never reach
 * the cache. Limitation: JavaScript cannot forcibly stop a noncooperative
 * provider's underlying work (an outstanding fetch/timer keeps running until
 * it settles); we can only stop using its result and prevent fallback.
 *
 * Returns "aborted" when the caller signal fires first (or was already
 * aborted). The abort listener is removed as soon as the race settles.
 */
async function settleProviderAttempt(
  runProvider: () => Promise<string>,
  signal: AbortSignal | undefined,
): Promise<ProviderSettlement | { kind: "aborted" }> {
  // Defense in depth (the call loop also guards): never start a provider
  // attempt for an already-aborted caller.
  if (signal?.aborted) return { kind: "aborted" };

  // A provider's call() may THROW SYNCHRONOUSLY (a non-async method that
  // raises before returning a promise). That throw must settle the attempt
  // exactly like an asynchronous rejection so it still flows through the
  // existing classify → fallback walk instead of leaking out of the
  // container. The rejection handler is attached on the same synchronous
  // tick, so the synthesized rejection is never reported unhandled.
  let providerPromise: Promise<string>;
  try {
    providerPromise = runProvider();
  } catch (err) {
    providerPromise = Promise.reject(err);
  }
  const settled: Promise<ProviderSettlement> = providerPromise.then(
    (raw) => ({ kind: "resolved" as const, raw }),
    (err) => ({ kind: "rejected" as const, err }),
  );

  if (!signal) return settled;

  let onAbort: (() => void) | null = null;
  try {
    const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
      if (signal.aborted) {
        resolve({ kind: "aborted" });
      } else {
        onAbort = () => resolve({ kind: "aborted" });
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    return await Promise.race([settled, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
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

  // Caller cancellation wins before any side effect: no trace stage, no
  // governance run, no cache read (warm or cold), and no provider call.
  // Fixed redacted TIMEOUT; signal.reason is never propagated.
  if (opts.signal?.aborted) {
    throw canceledError();
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

  // 3. resolve the effective request and provider chain before consulting the
  //    cache so per-call schema/model changes cannot reuse an old response.
  const effectiveInput: CapabilityInput = {
    ...input,
    schema: opts.schema ?? input.schema ?? cap.schema,
    schemaName: opts.schemaName ?? input.schemaName ?? cap.schemaName,
    maxTokens: opts.maxTokens ?? input.maxTokens ?? 12_000,
  };

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

  const cacheKey = opts.bypassCache
    ? null
    : computeKey(capabilityId, effectiveInput, providerSpecs);
  if (cacheKey) {
    const cached = getCache(cacheKey);
    if (cached !== null) {
      try {
        const parsed = tryParse(cached);
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
        // Other rule-engine errors must never break a cache hit.
      }

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
  const attempts: ProviderAttempt[] = [];

  for (const spec of providerSpecs) {
    // Never start another provider once the caller has canceled.
    if (opts.signal?.aborted) throw canceledError();

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
      // Abort landing between attempts (e.g. during fallback walking) is
      // terminal: do not start another model.
      if (opts.signal?.aborted) throw canceledError();

      const t0 = Date.now();
      // Forward the SAME signal object the caller gave us — never a derived
      // or internally aborted one.
      const outcome = await settleProviderAttempt(
        () =>
          provider.call(effectiveInput, {
            model,
            timeoutMs: spec.timeoutMs,
            signal: opts.signal,
          }),
        opts.signal,
      );
      const durationMs = Date.now() - t0;

      // Terminal on abort whether the provider cooperated (rejected),
      // ignored us and resolved late, or the abort race won outright.
      // Fixed bounded fields only: provider error text and signal.reason
      // are discarded and no further model/provider is attempted.
      if (outcome.kind === "aborted" || opts.signal?.aborted) {
        attempts.push({
          provider: spec.provider,
          model,
          ok: false,
          errorCode: "TIMEOUT",
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
                error_code: "TIMEOUT",
                error_message: "canceled",
                duration_ms: durationMs,
                retriable: false,
              },
            });
          } catch { /* ignore */ }
        }
        throw canceledError();
      }

      if (outcome.kind === "rejected") {
        const err = outcome.err;
        if (err instanceof VisionBlockedError) throw err;
        const ve = classify(err, spec.provider, model);
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
        continue;
      }

      {
        const raw = outcome.raw;
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

        // post-vision rules — always run (governance isn't trace-dependent).
        // Cache only after governance accepts the response. A VisionBlockedError
        // is terminal and must not cause fallback to another provider/model.
        try {
          const parsed = tryParse(raw);
          const ruleCtx: RuleCtx = {
            message: input.prompt,
            skill_id: capabilityId,
            llm_response: parsed,
          };
          const ruleOutcome = runRulesForStage("post-vision", ruleCtx, trace);
          if (ruleOutcome.action?.kind === "block") {
            throw new VisionBlockedError(ruleOutcome.action.reason, capabilityId);
          }
        } catch (e) {
          if (e instanceof VisionBlockedError) throw e;
          // Other rule-engine errors must never break the call.
        }

        // Re-check after the (synchronous) governance run: a result arriving
        // after cancellation must never be cached or returned.
        if (opts.signal?.aborted) throw canceledError();

        if (cacheKey) setCache(cacheKey, raw);

        return {
          raw,
          parsed: tryParse(raw) as T,
          fromCache: false,
          provider: spec.provider,
          model,
          durationMs,
          attempts,
        };
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
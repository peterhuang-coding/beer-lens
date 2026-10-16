/**
 * Coding Plan package vision provider.
 *
 * Reusable VisionProvider for the fixed Coding Plan Chat Completions
 * endpoint. Package-only by construction:
 *  - fixed endpoint + model; no OpenRouter/Ark v3 path, env base-URL
 *    overrides, automatic model selection, retries, or fallback
 *  - reads CODING_PLAN_API_KEY at call time only; no token cache, disk,
 *    keychain, or env files
 *  - at most one fetch per call; importing this module performs no request
 *  - every failure becomes a bounded, typed VisionError: error messages and
 *    metadata never carry the key, prompt, image data, headers, HTTP body,
 *    or the raw transport exception
 *
 * This module only registers the provider. It does not touch index.ts,
 * capability registries, or default chains; future serial wiring activates
 * the provider elsewhere.
 */

import { registerProvider } from "./base.ts";
import type { ProviderCallOptions, VisionProvider } from "./base.ts";
import type { CapabilityInput } from "../types.ts";
import {
  VisionAllProvidersFailedError,
  VisionAuthError,
  VisionError,
  VisionNetworkError,
  VisionParseError,
  VisionRateLimitError,
  VisionSizeError,
  VisionTimeoutError,
} from "../errors.ts";

const PROVIDER_ID = "coding-plan";
const ENDPOINT =
  "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const MODEL = "doubao-seed-evolving";
const MAX_TOKENS = 12_000;
const MAX_TIMEOUT_MS = 180_000;

// Bounded generic messages. Untrusted transport detail is never copied.
const MSG = {
  missingKey: "coding-plan vision API key is not configured",
  badModel: "coding-plan vision provider rejected an unsupported model",
  badTimeout: "coding-plan vision call rejected: invalid timeout",
  aborted: "coding-plan vision request was canceled before completion",
  timedOut: "coding-plan vision request timed out before returning content",
  malformed: "coding-plan vision response was not a valid JSON envelope",
  empty: "coding-plan vision response contained no usable content",
  transport:
    "coding-plan vision transport error: network connection or delivery failure",
  http: "coding-plan vision request failed with an HTTP error status",
} as const;

function httpStatusError(status: number): VisionError {
  const detail = ` (HTTP ${status})`;
  if (status === 401 || status === 403) {
    return new VisionAuthError(MSG.http + detail, PROVIDER_ID, MODEL);
  }
  if (status === 429) {
    return new VisionRateLimitError(MSG.http + detail, PROVIDER_ID, MODEL);
  }
  if (status === 413) {
    return new VisionSizeError(MSG.http + detail, PROVIDER_ID, MODEL);
  }
  if (status >= 500) {
    return new VisionNetworkError(MSG.http + detail, PROVIDER_ID, MODEL);
  }
  return new VisionAllProvidersFailedError(
    MSG.http + detail,
    PROVIDER_ID,
    MODEL,
  );
}

export const codingPlanProvider: VisionProvider = {
  id: PROVIDER_ID,

  async call(
    input: CapabilityInput,
    opts: ProviderCallOptions,
  ): Promise<string> {
    // Cancellation takes precedence; an already-aborted caller makes 0
    // requests (mapped to TIMEOUT per the existing abort classification).
    if (opts.signal?.aborted) {
      throw new VisionTimeoutError(MSG.aborted, PROVIDER_ID, MODEL);
    }

    // Key read at call time; never cached or logged.
    const apiKey = process.env.CODING_PLAN_API_KEY;
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new VisionAuthError(MSG.missingKey, PROVIDER_ID, MODEL);
    }

    // Fixed model only — no automatic model selection.
    if (opts.model !== MODEL) {
      throw new VisionAllProvidersFailedError(
        MSG.badModel,
        PROVIDER_ID,
        MODEL,
      );
    }

    if (
      typeof opts.timeoutMs !== "number" ||
      !Number.isFinite(opts.timeoutMs) ||
      opts.timeoutMs <= 0
    ) {
      throw new VisionAllProvidersFailedError(
        MSG.badTimeout,
        PROVIDER_ID,
        MODEL,
      );
    }
    // A bound, not a measured performance target.
    const timeoutMs = Math.min(opts.timeoutMs, MAX_TIMEOUT_MS);

    // Original prompt preserved verbatim; schema appended as text only when
    // supplied.
    const schemaText =
      input.schema === undefined ? null : JSON.stringify(input.schema);
    const text =
      schemaText === null
        ? input.prompt
        : `${input.prompt}\n\nYou MUST return ONLY one single JSON object. No markdown, no code fences. Follow this JSON schema exactly:\n${schemaText}`;

    const body: Record<string, unknown> = {
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text },
            {
              type: "image_url",
              image_url: {
                url: `data:${input.image.mime};base64,${input.image.base64}`,
              },
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: Math.min(input.maxTokens ?? MAX_TOKENS, MAX_TOKENS),
      stream: false,
      thinking: { type: "enabled" },
    };
    if (schemaText !== null) {
      body.response_format = { type: "json_object" };
    }

    // One internal controller: our timeout OR the caller signal aborts it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const externalSignal = opts.signal;
    let onExternalAbort: (() => void) | null = null;
    if (externalSignal) {
      onExternalAbort = () => controller.abort();
      externalSignal.addEventListener("abort", onExternalAbort, {
        once: true,
      });
    }

    // Anything crossing the fetch/body boundary is untrusted: transport
    // rejections, body-read failures, and even thrown VisionErrors may carry
    // secrets in message/provider/model/cause. Each phase therefore maps to
    // a locally constructed bounded error; only errors built inside this
    // module may leave the provider.
    const abortedByAnyParty = (err: unknown): boolean =>
      controller.signal.aborted ||
      (err instanceof Error && err.name === "AbortError");
    const timeoutError = (): VisionTimeoutError =>
      // Distinguish external cancellation from our internal timeout; both
      // carry code TIMEOUT in the existing error hierarchy.
      new VisionTimeoutError(
        externalSignal?.aborted ? MSG.aborted : MSG.timedOut,
        PROVIDER_ID,
        MODEL,
      );

    try {
      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        // Headers never arrived. Timer/external abort keeps TIMEOUT; every
        // other rejection — including a VisionError fabricated by injected
        // fetch code — becomes a bounded NETWORK error. Raw exception is
        // deliberately discarded, no `cause` chain.
        if (abortedByAnyParty(err)) throw timeoutError();
        throw new VisionNetworkError(MSG.transport, PROVIDER_ID, MODEL);
      }

      // Locally constructed from the status code: safe to propagate and
      // preserves the HTTP error classification (401/403, 429, 413, 5xx).
      if (!response.ok) throw httpStatusError(response.status);

      // Headers can arrive before the body. Reading/parsing the body is a
      // separate phase so its failures keep their own classification.
      let envelope: unknown;
      try {
        envelope = await response.json();
      } catch (err) {
        // Abort/timeout while still reading the body (timer or external
        // signal) must remain TIMEOUT.
        if (abortedByAnyParty(err)) throw timeoutError();
        // A body transport failure (undici surfaces these as TypeError).
        if (err instanceof TypeError) {
          throw new VisionNetworkError(MSG.transport, PROVIDER_ID, MODEL);
        }
        // A JSON syntax failure (plain Error JSON hints from older run/tests).
        if (
          err instanceof SyntaxError ||
          (err instanceof Error &&
            /json|unexpected\s+token|parse/i.test(err.message))
        ) {
          throw new VisionParseError(MSG.malformed, PROVIDER_ID, MODEL);
        }
        // Unknown body failure: treated as transport; detail discarded.
        throw new VisionNetworkError(MSG.transport, PROVIDER_ID, MODEL);
      }

      // Validate envelope structure before dereferencing: a JSON null (or
      // any non-object envelope) is PARSE, never a dereferencing TypeError.
      if (envelope === null || typeof envelope !== "object") {
        throw new VisionParseError(MSG.malformed, PROVIDER_ID, MODEL);
      }

      const content = (
        envelope as { choices?: Array<{ message?: { content?: unknown } }> }
      ).choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new VisionParseError(MSG.empty, PROVIDER_ID, MODEL);
      }
      return content;
    } finally {
      clearTimeout(timer);
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  },
};

registerProvider(codingPlanProvider);

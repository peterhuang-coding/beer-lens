/**
 * Explicit Anthropic vision provider.
 *
 * One official SDK streaming request per call: fixed direct endpoint and
 * Claude Opus 5 model, adaptive thinking, no SDK retries or fallback. The
 * caller's deadline/cancellation aborts the stream. ANTHROPIC_API_KEY is read
 * only at call time; SDK logging is disabled so prompts and images are not
 * emitted through environment-selected debug logging.
 *
 * Only locally constructed, bounded VisionErrors leave this module. Raw API
 * bodies, transport exceptions, credentials, prompts and base64 image data
 * are never copied into errors or their cause chains.
 */

import Anthropic from "@anthropic-ai/sdk";
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

const PROVIDER_ID = "anthropic";
const BASE_URL = "https://api.anthropic.com";
const MODEL = "claude-opus-5";
const MAX_TOKENS = 12_000;
const MAX_TIMEOUT_MS = 180_000;
const SYSTEM_PROMPT =
  "You are Beer Lens's vision extractor. Return only the requested content. When JSON is requested, return ONLY one JSON object with no markdown or code fences. Never invent unreadable text.";

const MSG = {
  missingKey: "anthropic vision API key is not configured",
  badModel: "anthropic vision provider rejected an unsupported model",
  badTimeout: "anthropic vision call rejected: invalid timeout",
  badImage: "anthropic vision call rejected: unsupported image media type",
  aborted: "anthropic vision request was canceled before completion",
  timedOut: "anthropic vision request timed out before returning content",
  malformed: "anthropic vision response had no valid message content",
  incomplete: "anthropic vision response stopped before completing its content",
  empty: "anthropic vision response contained no usable text",
  transport:
    "anthropic vision transport error: network connection or delivery failure",
  http: "anthropic vision request failed with an HTTP error status",
} as const;

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function imageMediaType(mime: string): ImageMediaType | null {
  const normalized = mime.toLowerCase();
  switch (normalized) {
    case "image/jpeg":
    case "image/png":
    case "image/gif":
    case "image/webp":
      return normalized;
    default:
      return null;
  }
}

function mapError(
  err: unknown,
  externalSignal: AbortSignal | undefined,
  didTimeout: boolean,
): VisionError {
  if (externalSignal?.aborted) {
    return new VisionTimeoutError(MSG.aborted, PROVIDER_ID, MODEL);
  }
  if (didTimeout || err instanceof Anthropic.APIConnectionTimeoutError) {
    return new VisionTimeoutError(MSG.timedOut, PROVIDER_ID, MODEL);
  }
  if (err instanceof Anthropic.AuthenticationError ||
      err instanceof Anthropic.PermissionDeniedError) {
    return new VisionAuthError(MSG.http, PROVIDER_ID, MODEL);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new VisionRateLimitError(MSG.http + " (HTTP 429)", PROVIDER_ID, MODEL);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new VisionNetworkError(MSG.transport, PROVIDER_ID, MODEL);
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 408) {
      return new VisionTimeoutError(MSG.timedOut, PROVIDER_ID, MODEL);
    }
    if (status === 413) {
      return new VisionSizeError(MSG.http + " (HTTP 413)", PROVIDER_ID, MODEL);
    }
    if (typeof status === "number" && status >= 500) {
      return new VisionNetworkError(
        MSG.http + ` (HTTP ${status})`,
        PROVIDER_ID,
        MODEL,
      );
    }
    const detail = typeof status === "number" ? ` (HTTP ${status})` : "";
    return new VisionAllProvidersFailedError(
      MSG.http + detail,
      PROVIDER_ID,
      MODEL,
    );
  }
  // Includes SDK/user aborts not caused by our timer and hostile exceptions
  // injected by a custom transport. Detail and cause are deliberately dropped.
  return new VisionNetworkError(MSG.transport, PROVIDER_ID, MODEL);
}

export const anthropicProvider: VisionProvider = {
  id: PROVIDER_ID,

  async call(
    input: CapabilityInput,
    opts: ProviderCallOptions,
  ): Promise<string> {
    if (opts.signal?.aborted) {
      throw new VisionTimeoutError(MSG.aborted, PROVIDER_ID, MODEL);
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new VisionAuthError(MSG.missingKey, PROVIDER_ID, MODEL);
    }
    if (opts.model !== MODEL) {
      throw new VisionAllProvidersFailedError(MSG.badModel, PROVIDER_ID, MODEL);
    }
    if (
      typeof opts.timeoutMs !== "number" ||
      !Number.isFinite(opts.timeoutMs) ||
      opts.timeoutMs <= 0
    ) {
      throw new VisionAllProvidersFailedError(MSG.badTimeout, PROVIDER_ID, MODEL);
    }
    const mediaType = imageMediaType(input.image.mime);
    if (!mediaType) {
      throw new VisionAllProvidersFailedError(MSG.badImage, PROVIDER_ID, MODEL);
    }

    const timeoutMs = Math.min(opts.timeoutMs, MAX_TIMEOUT_MS);
    const schemaText =
      input.schema === undefined ? null : JSON.stringify(input.schema);
    const system = schemaText === null
      ? SYSTEM_PROMPT
      : `${SYSTEM_PROMPT}\n\nFollow this JSON schema exactly:\n${schemaText}`;

    const externalSignal = opts.signal;
    let didTimeout = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onExternalAbort: (() => void) | null = null;
    let message: Anthropic.Message;

    try {
      const client = new Anthropic({
        apiKey,
        baseURL: BASE_URL,
        maxRetries: 0,
        timeout: timeoutMs,
        logLevel: "off",
      });
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: Math.min(input.maxTokens ?? MAX_TOKENS, MAX_TOKENS),
        thinking: { type: "adaptive" },
        system,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: input.image.base64 },
            },
            { type: "text", text: input.prompt },
          ],
        }],
      });

      timer = setTimeout(() => {
        didTimeout = true;
        stream.abort();
      }, timeoutMs);
      if (externalSignal) {
        onExternalAbort = () => stream.abort();
        if (externalSignal.aborted) stream.abort();
        else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
      message = await stream.finalMessage();
    } catch (err) {
      throw mapError(err, externalSignal, didTimeout);
    } finally {
      if (timer) clearTimeout(timer);
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }

    let raw: string;
    let stopReason: unknown;
    try {
      const parts: string[] = [];
      for (const block of message.content) {
        if (block.type === "text") parts.push(block.text);
      }
      raw = parts.join("");
      stopReason = message.stop_reason;
    } catch {
      throw new VisionParseError(MSG.malformed, PROVIDER_ID, MODEL);
    }
    // This request configures neither tools nor custom stop sequences, so
    // only a natural end_turn is complete. pause_turn needs continuation;
    // refusal, tool_use, stop_sequence and context/output limits must not
    // turn partial but valid-looking JSON into a successful extraction.
    if (stopReason !== "end_turn") {
      throw new VisionParseError(MSG.incomplete, PROVIDER_ID, MODEL);
    }
    if (raw.trim() === "") {
      throw new VisionParseError(MSG.empty, PROVIDER_ID, MODEL);
    }
    return raw;
  },
};

registerProvider(anthropicProvider);

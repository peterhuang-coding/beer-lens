/**
 * Agent text transport selector.
 *
 * Opt-in reuse of the existing BEER_VISION_PROVIDER selection for the
 * Agent's textual calls (intent skill selector + beer-knowledge answers):
 *
 *  - unset/blank: the call is delegated verbatim to the legacy
 *    openrouter-client (same body, same options, same proxy/retry/trace
 *    behavior); legacy behavior is preserved exactly
 *  - "coding-plan": one fixed package request — fixed endpoint + model,
 *    CODING_PLAN_API_KEY read at call time, no OpenRouter key, env base
 *    URL overrides, retries, model/provider selection, or paid fallback
 *  - any other nonblank value: fails closed before a request can be made
 *
 * Package-mode failure messages are bounded strings. They never carry the
 * key, prompt, message content, request body, response body, headers, or
 * the raw transport exception; errors thrown by hostile external code
 * (including fabricated typed errors) are also treated as untrusted and
 * mapped to a locally constructed AgentTextError.
 */

const SELECTOR_ENV = "BEER_VISION_PROVIDER";
const PACKAGE_KEY_ENV = "CODING_PLAN_API_KEY";
const PACKAGE_PROVIDER_ID = "coding-plan";

const ENDPOINT =
  "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const MODEL = "doubao-seed-evolving";
// Bounded package reasoning budget. A chosen bound, not a measured
// quality/latency claim; legacy 300/1500 caps are not a proof of a
// sufficient Seed reasoning budget.
const MAX_TOKENS = 12_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 180_000;

// Bounded generic messages. Untrusted transport detail is never copied.
const MSG = {
  unsupported: "Unsupported agent text provider selection",
  missingKey: "coding-plan text API key is not configured",
  aborted: "coding-plan text request was canceled before completion",
  timedOut: "coding-plan text request timed out before returning content",
  malformed: "coding-plan text response was not a valid JSON envelope",
  empty: "coding-plan text response contained no usable content",
  transport:
    "coding-plan text transport error: network connection or delivery failure",
  badRequest: "coding-plan text call was rejected before delivery",
  http: "coding-plan text request failed with an HTTP error status",
} as const;

export type AgentTextErrorCode =
  | "SELECTION"
  | "AUTH"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "NETWORK"
  | "PARSE"
  | "UNKNOWN";

/** Bounded typed error for Agent text transport failures. */
export class AgentTextError extends Error {
  readonly code: AgentTextErrorCode;
  readonly provider: string;
  readonly model: string;

  constructor(
    message: string,
    code: AgentTextErrorCode,
    provider: string,
    model: string,
  ) {
    super(message);
    this.name = "AgentTextError";
    this.code = code;
    this.provider = provider;
    this.model = model;
  }
}

/** Matches the legacy openrouterFetch argument shape. */
export interface AgentTextOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

type ChatMessageLike = { role?: unknown; content?: unknown };

function packageError(
  message: string,
  code: AgentTextErrorCode,
): AgentTextError {
  return new AgentTextError(message, code, PACKAGE_PROVIDER_ID, MODEL);
}

function httpStatusError(status: number): AgentTextError {
  const detail = ` (HTTP ${status})`;
  if (status === 401 || status === 403) {
    return packageError(MSG.http + detail, "AUTH");
  }
  if (status === 429) {
    return packageError(MSG.http + detail, "RATE_LIMIT");
  }
  if (status >= 500) {
    return packageError(MSG.http + detail, "NETWORK");
  }
  return packageError(MSG.http + detail, "UNKNOWN");
}

/**
 * Send one Agent textual chat request.
 *
 * When BEER_VISION_PROVIDER is unset/blank this delegates to the legacy
 * openrouter-client; importing this module performs no request, and the
 * legacy module is only loaded on a legacy call.
 */
export async function agentTextFetch(
  body: object,
  options?: AgentTextOptions,
): Promise<string> {
  // Selection is read at call time, never cached.
  const selection = process.env[SELECTOR_ENV];
  if (typeof selection !== "string" || selection.trim() === "") {
    const { openrouterFetch } = await import("./openrouter-client.ts");
    return openrouterFetch(body, options);
  }
  if (selection.trim() !== PACKAGE_PROVIDER_ID) {
    // Fail closed before any request can be made.
    throw new AgentTextError(
      MSG.unsupported,
      "SELECTION",
      "agent-text",
      "",
    );
  }

  // Cancellation takes precedence; an already-aborted caller makes 0
  // requests.
  if (options?.signal?.aborted) {
    throw packageError(MSG.aborted, "TIMEOUT");
  }

  // Key read at call time; never cached or logged.
  const apiKey = process.env[PACKAGE_KEY_ENV];
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw packageError(MSG.missingKey, "AUTH");
  }

  // Timeout: default, positive finite explicit, bounded cap.
  const explicit = options?.timeoutMs;
  let timeoutMs: number;
  if (explicit === undefined) {
    timeoutMs = DEFAULT_TIMEOUT_MS;
  } else if (
    typeof explicit !== "number" ||
    !Number.isFinite(explicit) ||
    explicit <= 0
  ) {
    throw packageError(MSG.badRequest, "UNKNOWN");
  } else {
    timeoutMs = Math.min(explicit, MAX_TIMEOUT_MS);
  }

  // Original roles/content/history/context messages are preserved
  // verbatim; validate structure before dereferencing.
  const source = body as Record<string, unknown>;
  const messages = source.messages;
  if (!Array.isArray(messages)) {
    throw packageError(MSG.badRequest, "UNKNOWN");
  }

  // Temperature from the existing caller when finite (callers place it in
  // the body; options.temperature is accepted too). No fabricated default.
  const rawTemperature =
    typeof source.temperature === "number"
      ? source.temperature
      : options?.temperature;
  const temperature =
    typeof rawTemperature === "number" && Number.isFinite(rawTemperature)
      ? rawTemperature
      : null;

  const outbound: Record<string, unknown> = {
    model: MODEL,
    messages: messages as ChatMessageLike[],
    max_tokens: MAX_TOKENS,
    stream: false,
    thinking: { type: "enabled" },
  };
  if (temperature !== null) outbound.temperature = temperature;

  // One internal controller: our timeout OR the caller signal aborts it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = options?.signal;
  let onExternalAbort: (() => void) | null = null;
  if (externalSignal) {
    onExternalAbort = () => controller.abort();
    externalSignal.addEventListener("abort", onExternalAbort, {
      once: true,
    });
  }

  // Anything crossing the fetch/body boundary is untrusted: transport
  // rejections, body-read failures, and thrown errors fabricated by
  // injected fetch code may carry secrets. Each phase maps to a locally
  // constructed bounded error; only errors built inside this module may
  // leave the helper.
  const abortedByAnyParty = (err: unknown): boolean =>
    controller.signal.aborted ||
    (err instanceof Error && err.name === "AbortError");
  const timeoutError = (): AgentTextError =>
    packageError(
      externalSignal?.aborted ? MSG.aborted : MSG.timedOut,
      "TIMEOUT",
    );

  try {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      // Headers (key) and serialized body live only inside this request.
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(outbound),
        signal: controller.signal,
      });
    } catch (err) {
      if (abortedByAnyParty(err)) throw timeoutError();
      // Raw exception deliberately discarded; no `cause` chain.
      throw packageError(MSG.transport, "NETWORK");
    }

    // Locally constructed from the status code: safe to propagate and
    // preserves the HTTP error classification. Upstream body is unread.
    if (!response.ok) throw httpStatusError(response.status);

    // Reading/parsing the body is a separate phase.
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch (err) {
      if (abortedByAnyParty(err)) throw timeoutError();
      if (err instanceof TypeError) {
        throw packageError(MSG.transport, "NETWORK");
      }
      if (
        err instanceof SyntaxError ||
        (err instanceof Error &&
          /json|unexpected\s+token|parse/i.test(err.message))
      ) {
        throw packageError(MSG.malformed, "PARSE");
      }
      throw packageError(MSG.transport, "NETWORK");
    }

    // A JSON null (or any non-object envelope) is PARSE, never a
    // dereferencing TypeError.
    if (envelope === null || typeof envelope !== "object") {
      throw packageError(MSG.malformed, "PARSE");
    }

    const content = (
      envelope as { choices?: Array<{ message?: { content?: unknown } }> }
    ).choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw packageError(MSG.empty, "PARSE");
    }
    return content;
  } finally {
    clearTimeout(timer);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

import { ProxyAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { setTimeout as wait } from "node:timers/promises";
import { appendStage } from "../harness/trace-buffer.ts";
import { getTraceCtx } from "../harness/trace-context.ts";

let proxyInitialized = false;
let previousDispatcher: Dispatcher | undefined;
let configuredProxy: ProxyAgent | undefined;

/** Structured error carrying model/provider/status for trace diagnostics. */
export class OpenRouterError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly errorCode: string;

  constructor(
    message: string,
    provider: string,
    model: string,
    errorCode: string,
  ) {
    super(message);
    this.name = "OpenRouterError";
    this.provider = provider;
    this.model = model;
    this.errorCode = errorCode;
  }
}

function initProxyOnce() {
  if (proxyInitialized) return;
  proxyInitialized = true;

  const proxy = process.env.OPENROUTER_PROXY
    ?? process.env.HTTPS_PROXY
    ?? process.env.https_proxy
    ?? process.env.ALL_PROXY
    ?? process.env.all_proxy;

  if (!proxy) return;

  const proxyUrl = proxy.startsWith("http") ? proxy : `http://${proxy}`;
  try {
    const proxyAgent = new ProxyAgent({ uri: proxyUrl });
    previousDispatcher = getGlobalDispatcher();
    setGlobalDispatcher(proxyAgent);
    configuredProxy = proxyAgent;
    console.log("[openrouter] proxy configured");
  } catch {
    console.warn("[openrouter] failed to configure proxy; keeping the existing dispatcher");
  }
}

/** Restore only the dispatcher installed by this module, not a later override. */
function restorePreviousDispatcher(): boolean {
  if (!previousDispatcher || !configuredProxy || getGlobalDispatcher() !== configuredProxy) return false;
  setGlobalDispatcher(previousDispatcher);
  return true;
}

export async function openrouterFetch(
  body: object,
  options?: { model?: string; maxTokens?: number; temperature?: number; timeoutMs?: number; signal?: AbortSignal }
): Promise<string> {
  initProxyOnce();

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");

  // Extract model name from body for error diagnostics
  const bodyModel = (body as Record<string, unknown>).model as string | undefined;
  const modelName = options?.model ?? bodyModel ?? "unknown";

  // One deadline covers every attempt and backoff, including when the caller
  // also supplies a cancellation signal. Neither timer is reset by a retry.
  const timeoutMs = options?.timeoutMs ?? 20000;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, abortController.signal])
    : abortController.signal;
  let retryAfterMs = 0;
  let attempts = 0;
  let connectionRetried = false;

  const makeRequest = async () => {
    signal.throwIfAborted();
    attempts++;
    retryAfterMs = 0;
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
        "X-Title": process.env.OPENROUTER_APP_TITLE ?? "Beer Lens",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(delay)) retryAfterMs = Math.max(0, delay);
      }
      const errorText = await response.text().catch(() => "unknown");
      throw new OpenRouterError(
        `OpenRouter ${response.status}: ${errorText}`,
        "openrouter",
        modelName,
        String(response.status),
      );
    }

    const result = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = result?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new OpenRouterError("OpenRouter returned empty content", "openrouter", modelName, "EMPTY_CONTENT");
    }
    return content;
  };

  // Try with proxy first; if it fails with ECONNREFUSED, fall back to direct
  const started_at = Date.now();
  const trace = getTraceCtx();
  const traceCall = (ok: boolean, extra?: Record<string, unknown>) => {
    if (!trace) return;
    try {
      appendStage(trace.root_ts, trace.parent_ts ?? trace.root_ts, "llm:call", {
        ok,
        stage_skill_id: trace.skill_id,
        decision: { model: modelName, messages_count: Array.isArray((body as Record<string, unknown>).messages) ? ((body as Record<string, unknown>).messages as unknown[]).length : undefined, provider: "openrouter", ...extra },
        started_at,
      });
    } catch { /* never let tracing kill the request */ }
  };
  try {
    // Two retries for transient provider failures; request/model configuration
    // stays identical. All other HTTP errors (especially 401/403) fail directly.
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await makeRequest();
        traceCall(true, { result_chars: result.length, attempts });
        return result;
      } catch (err) {
        if (signal.aborted || attempts >= 3) throw err;
        const message = err instanceof Error ? err.message : "";
        const connectionFailure = !(err instanceof OpenRouterError) &&
          /ECONNREFUSED|fetch failed|ProxyAgent/.test(message);
        if (connectionFailure && !connectionRetried) {
          connectionRetried = true;
          const restored = restorePreviousDispatcher();
          console.warn(restored
            ? "[openrouter] proxy unreachable; restored the previous dispatcher for retry"
            : "[openrouter] connection failed; retrying once");
          continue;
        }
        const retryable = err instanceof OpenRouterError &&
          ["429", "502", "503", "504", "EMPTY_CONTENT"].includes(err.errorCode);
        if (!retryable) throw err;
        await wait(Math.min(timeoutMs, Math.max(250 * 2 ** attempt, retryAfterMs)), undefined, { signal });
      }
    }
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      const cancelled = options?.signal?.aborted === true;
      const code = cancelled ? "ABORTED" : "TIMEOUT";
      traceCall(false, { error_code: code, error: cancelled ? "cancelled" : "timeout" });
      throw new OpenRouterError(
        cancelled ? "OpenRouter request cancelled" : `OpenRouter request timed out after ${timeoutMs}ms`,
        "openrouter",
        modelName,
        code,
      );
    }
    if (err instanceof OpenRouterError) {
      traceCall(false, { error_code: err.errorCode, error: err.message.slice(0, 200) });
      throw err;
    }
    const msg = err instanceof Error ? (err.message || "") : "";
    traceCall(false, { error: msg.slice(0, 200) });
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

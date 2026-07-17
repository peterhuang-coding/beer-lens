import { ProxyAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";

let proxyInitialized = false;
let proxyFailed = false;

/** Structured error carrying model/provider/status for trace diagnostics. */
export class OpenRouterError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly model: string,
    public readonly errorCode: string,
  ) {
    super(message);
    this.name = "OpenRouterError";
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
    setGlobalDispatcher(new ProxyAgent({ uri: proxyUrl }));
    console.log(`[openrouter] proxy configured: ${proxyUrl}`);
  } catch (err) {
    console.warn(`[openrouter] failed to configure proxy: ${proxyUrl}, will fall back to direct connection`, err);
    proxyFailed = true;
  }
}

/**
 * Check if the proxy is actually working. If it's dead, reset to direct connection.
 */
function isProxyDead(): boolean {
  return proxyFailed;
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

  // Wire up timeout via AbortController (caller-supplied signal takes precedence)
  const timeoutMs = options?.timeoutMs ?? 20000;
  let abortController: AbortController | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  if (!options?.signal) {
    abortController = new AbortController();
    timeoutId = setTimeout(() => abortController!.abort(), timeoutMs);
  }

  const makeRequest = async () => {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
        "X-Title": process.env.OPENROUTER_APP_TITLE ?? "Beer Lens",
      },
      body: JSON.stringify(body),
      signal: options?.signal ?? abortController?.signal,
    });

    if (!response.ok) {
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
    if (!content) throw new Error("OpenRouter returned empty content");
    return content;
  };

  // Try with proxy first; if it fails with ECONNREFUSED, fall back to direct
  try {
    return await makeRequest();
  } catch (err) {
    // Distinguish timeout from other failures
    if (err instanceof Error && err.name === "AbortError") {
      throw new OpenRouterError(
        `OpenRouter request timed out after ${timeoutMs}ms`,
        "openrouter",
        modelName,
        "TIMEOUT",
      );
    }
    if (err instanceof OpenRouterError) throw err;
    const msg = err instanceof Error ? (err.message || "") : "";
    // If proxy connection refused, reset to direct and retry
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ProxyAgent")) {
      try {
        const { setGlobalDispatcher } = await import("undici");
        setGlobalDispatcher((await import("undici")).getGlobalDispatcher());
      } catch {}
      console.warn("[openrouter] proxy unreachable, retrying with direct connection...");
      return await makeRequest();
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

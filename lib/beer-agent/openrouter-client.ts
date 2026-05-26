import { ProxyAgent } from "undici";

function getProxyDispatcher() {
  const proxy = process.env.OPENROUTER_PROXY
    ?? process.env.HTTPS_PROXY
    ?? process.env.https_proxy
    ?? process.env.ALL_PROXY
    ?? process.env.all_proxy;

  if (!proxy) return undefined;

  // undici ProxyAgent expects a full URI
  const proxyUrl = proxy.startsWith("http") ? proxy : `http://${proxy}`;
  try {
    return new ProxyAgent({ uri: proxyUrl });
  } catch {
    console.warn(`[openrouter] Failed to create proxy agent for: ${proxyUrl}`);
    return undefined;
  }
}

export async function openrouterFetch(
  body: object,
  options?: { model?: string; maxTokens?: number; temperature?: number }
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");

  const dispatcher = getProxyDispatcher();

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": process.env.OPENROUTER_APP_TITLE ?? "Beer Lens",
    },
    body: JSON.stringify(body),
    ...(dispatcher ? { dispatcher } : {}),
  } as any);

  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${await response.text().catch(() => "unknown")}`);
  }

  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = result?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned empty content");
  return content;
}

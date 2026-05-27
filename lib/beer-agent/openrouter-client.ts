import { ProxyAgent, setGlobalDispatcher } from "undici";

let proxyInitialized = false;

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
    console.warn(`[openrouter] failed to configure proxy: ${proxyUrl}`, err);
  }
}

export async function openrouterFetch(
  body: object,
  options?: { model?: string; maxTokens?: number; temperature?: number }
): Promise<string> {
  initProxyOnce();

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": process.env.OPENROUTER_APP_TITLE ?? "Beer Lens",
    },
    body: JSON.stringify(body),
  });

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

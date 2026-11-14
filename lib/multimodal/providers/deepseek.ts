/**
 * DeepSeek vision provider.
 *
 * DeepSeek's stable vision alias is `deepseek-flash` (official vision and
 * model documentation checked 2026-10-28). The retired experimental name
 * `deepseek-v4-flash-vision-exp` is still accepted by the service as an alias,
 * but new calls use the stable ID. This provider talks to DeepSeek directly,
 * bypassing OpenRouter.
 *
 * Caveat: a response can spend part of its max_tokens budget on
 * `reasoning_content` and return empty `content`; we treat that as an error
 * so the container walks to the fallback provider instead of returning "".
 *
 * Endpoint: POST {DEEPSEEK_BASE_URL}/chat/completions
 * Auth: Bearer DEEPSEEK_API_KEY
 * Request: OpenAI shape; user message content is array of {type, image_url}
 *          parts (base64 data: URL works the same as OpenRouter).
 *
 * Self-registers on import so callers just `import "./deepseek.ts"` once.
 *
 * Differences vs OpenRouter:
 *   - No `response_format: json_schema` (DeepSeek rejects strict schema).
 *     We fall back to `response_format: { type: "json_object" }` and append
 *     the schema as text — same trick as the openrouter.ts provider.
 *   - No proxy layer, no rate-limit retry middleware; we just throw and
 *     let the container walk to the next provider.
 */

import { registerProvider } from "./base.ts";
import { classify, VisionError, VisionAuthError, VisionParseError, VisionTimeoutError } from "../errors.ts";
import type { CapabilityInput } from "../types.ts";
import type { ProviderCallOptions, VisionProvider } from "./base.ts";

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-flash";

function appendSchemaInstruction(prompt: string, schemaJson: string): string {
  return `${prompt}\n\nYou MUST return ONLY a single JSON object. No markdown, no code fences. Follow this JSON schema exactly:\n${schemaJson}`;
}

async function postJson(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "unknown");
      throw new Error(`DeepSeek ${res.status}: ${text}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function extractContent(payload: unknown): string {
  const p = payload as {
    choices?: Array<{ message?: { content?: string | Array<unknown> } }>;
  };
  const c = p?.choices?.[0]?.message?.content;
  if (typeof c === "string") {
    // Reasoner spent the whole budget on reasoning_content → no answer.
    // Non-retriable so the container walks to the next provider instead
    // of returning "" to callers.
    if (c === "") {
      throw new VisionParseError("DeepSeek returned empty content", "deepseek");
    }
    return c;
  }
  if (Array.isArray(c)) {
    // Some DeepSeek responses return content as [{type: "text", text: "..."}]
    return c
      .map((part) => {
        const x = part as { type?: string; text?: string };
        return x?.type === "text" ? (x.text ?? "") : "";
      })
      .join("");
  }
  throw new VisionParseError("DeepSeek returned empty content", "deepseek");
}

const deepseekProvider: VisionProvider = {
  id: "deepseek",
  async call(input: CapabilityInput, opts: ProviderCallOptions): Promise<string> {
    if (opts.signal?.aborted) {
      throw new VisionTimeoutError(
        "DeepSeek request canceled before completion",
        "deepseek",
        opts.model,
      );
    }
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new VisionAuthError(
        "DEEPSEEK_API_KEY not configured",
        "deepseek",
        opts.model,
      );
    }

    const schemaJson = input.schema ? JSON.stringify(input.schema) : null;
    const useJsonObject = !!input.schema;
    const textPrompt =
      useJsonObject && schemaJson
        ? appendSchemaInstruction(input.prompt, schemaJson)
        : input.prompt;

    const userContent: Array<Record<string, unknown>> = [
      { type: "text", text: textPrompt },
      {
        type: "image_url",
        image_url: {
          url: `data:${input.image.mime};base64,${input.image.base64}`,
        },
      },
    ];

    const body: Record<string, unknown> = {
      model: opts.model,
      messages: [{ role: "user", content: userContent }],
      temperature: 0.1,
      max_tokens: input.maxTokens ?? 4096,
      stream: false,
    };

    if (useJsonObject) {
      body.response_format = { type: "json_object" };
    }

    let payload: unknown;
    try {
      payload = await postJson(
        `${BASE_URL}/chat/completions`,
        apiKey,
        body,
        opts.timeoutMs,
        opts.signal,
      );
    } catch (err) {
      // Re-throw as a typed VisionError so the container classifies and walks.
      throw classify(err, "deepseek", opts.model);
    }

    try {
      return extractContent(payload);
    } catch (err) {
      throw classify(err, "deepseek", opts.model);
    }
  },
};

registerProvider(deepseekProvider);

export { deepseekProvider, MODEL };
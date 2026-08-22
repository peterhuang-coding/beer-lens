/**
 * DeepSeek vision provider.
 *
 * DeepSeek's vision model is `deepseek-v4-flash-vision-exp` (verified
 * 2026-08-23: accepts base64 data: URLs, returns json_object on request).
 * `deepseek-chat` no longer exists on api.deepseek.com and never had
 * vision. This provider talks to DeepSeek directly, bypassing OpenRouter —
 * useful when the user's region blocks the OpenRouter-hosted Google/OpenAI
 * models.
 *
 * Caveat: the model is a reasoner — `reasoning_content` consumes part of
 * the max_tokens budget. With small max_tokens it can return an empty
 * `content`; we treat that as an error so the container walks to the
 * fallback provider instead of returning "" to callers.
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
import { classify, VisionError, VisionAuthError, VisionParseError } from "../errors.ts";
import type { CapabilityInput } from "../types.ts";
import type { ProviderCallOptions, VisionProvider } from "./base.ts";

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash-vision-exp";

function appendSchemaInstruction(prompt: string, schemaJson: string): string {
  return `${prompt}\n\nYou MUST return ONLY a single JSON object. No markdown, no code fences. Follow this JSON schema exactly:\n${schemaJson}`;
}

async function postJson(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
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
/**
 * OpenRouter vision provider.
 *
 * Wraps `openrouterFetch` (which already handles proxy, timeout, JSON
 * response, and llm:call trace stage) with the capability-input shape.
 *
 * Self-registers on import so callers that just `import "./openrouter.ts"`
 * at the top of the container bootstrap get the provider available.
 *
 * Gemini models on OpenRouter reject strict json_schema (they reject
 * `additionalProperties: false` reliably enough to fail); for those we
 * downgrade to `json_object` and append a schema-as-text instruction in
 * the prompt. This mirrors the behavior already in
 * `lib/beer-agent/multi-stage-pipeline.ts::callOpenRouterJson`.
 */

import { openrouterFetch } from "../../beer-agent/openrouter-client.ts";
import { registerProvider } from "./base.ts";
import type { CapabilityInput } from "../types.ts";
import type { ProviderCallOptions, VisionProvider } from "./base.ts";

function supportsJsonSchema(model: string): boolean {
  // Gemini models on OpenRouter don't reliably honor strict json_schema;
  // downgrade to json_object + text-instruction for them.
  // qwen3-vl with strict json_schema on the beer_menu_image schema took
  // >120s (2026-08-23); json_object finished in ~80s. Downgrade qwen too.
  return (
    !model.toLowerCase().includes("gemini") &&
    !model.toLowerCase().includes("qwen")
  );
}

function appendSchemaInstruction(prompt: string, schemaJson: string): string {
  return `${prompt}\n\nYou MUST return ONLY a single JSON object. No markdown, no code fences. Follow this JSON schema exactly:\n${schemaJson}`;
}

const openrouterProvider: VisionProvider = {
  id: "openrouter",
  async call(input: CapabilityInput, opts: ProviderCallOptions): Promise<string> {
    const schemaJson = input.schema ? JSON.stringify(input.schema) : null;
    const useStrictSchema = input.schema && supportsJsonSchema(opts.model);

    const userContent: Array<Record<string, unknown>> = [];
    const textPrompt = useStrictSchema || !schemaJson
      ? input.prompt
      : appendSchemaInstruction(input.prompt, schemaJson!);
    userContent.push({ type: "text", text: textPrompt });
    userContent.push({
      type: "image_url",
      image_url: {
        url: `data:${input.image.mime};base64,${input.image.base64}`,
      },
    });

    const body: Record<string, unknown> = {
      model: opts.model,
      messages: [{ role: "user", content: userContent }],
      temperature: 0.1,
      max_tokens: input.maxTokens ?? 12_000,
    };

    if (input.schema) {
      if (useStrictSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: input.schemaName ?? "vision_result",
            strict: true,
            schema: input.schema,
          },
        };
      } else {
        body.response_format = { type: "json_object" };
      }
    }

    return openrouterFetch(body, {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
  },
};

registerProvider(openrouterProvider);

export { openrouterProvider };
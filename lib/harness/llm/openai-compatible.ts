/**
 * OpenAI-compatible adapter — covers OpenAI, Doubao Ark, DeepSeek, Moonshot,
 * Gemini OpenAI-compat, Ollama /v1, etc.
 *
 * Wire format reference:
 *   POST {baseUrl}/chat/completions
 *   Authorization: Bearer {apiKey}
 *   Body: { model, messages, tools?, stream, temperature, max_tokens }
 *
 * Streaming response: SSE `data: {choices:[{delta:{content|tool_calls}}]}`.
 *
 * The adapter is intentionally small: it knows about the wire shape and
 * nothing else. Prompt construction lives in `prompts/`, tool schema lives
 * in `tools/`.
 */

import { parseSSE } from "./streaming.ts";
import {
  LLMUpstreamError,
  type LLMProvider,
  type ChatRequest,
  type ChatMessage,
  type ChatDelta,
  type ToolSpec,
} from "./provider.ts";
import { type LLMConfig, getLLMConfig } from "./config.ts";

// ── Wire shapes (subset of OpenAI Chat Completions) ──────────────────────

interface WireMessage {
  role: ChatMessage["role"];
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface WireTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface WireRequest {
  model: string;
  messages: WireMessage[];
  tools?: WireTool[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

interface WireDeltaChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: "function";
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: "stop" | "tool_calls" | "length" | null;
}

interface WireChunk {
  choices?: WireDeltaChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly cfg: LLMConfig = getLLMConfig()) {}

  async chat(req: ChatRequest): Promise<ReadableStream<ChatDelta>> {
    const wire = this.toWire(req);
    const url = `${this.cfg.baseUrl}/chat/completions`;
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 60_000);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(wire),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      throw new LLMUpstreamError(0, String((err as Error).message ?? err));
    }
    clearTimeout(timeout);

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new LLMUpstreamError(resp.status, body);
    }
    if (!resp.body) {
      throw new LLMUpstreamError(resp.status, "empty body");
    }

    return mapStreamToDeltas(resp.body);
  }

  async completeText(req: ChatRequest): Promise<string> {
    const stream = await this.chat({ ...req, stream: true });
    let text = "";
    for await (const d of streamToAsyncIterable(stream)) {
      if (d.contentDelta) text += d.contentDelta;
    }
    return text;
  }

  // ── Wire shaping ────────────────────────────────────────────────────────

  private toWire(req: ChatRequest): WireRequest {
    const messages: WireMessage[] = req.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      ...(m.toolCalls && m.toolCalls.length > 0
        ? {
            tool_calls: m.toolCalls.map((t) => ({
              id: t.id,
              type: "function" as const,
              function: { name: t.name, arguments: t.arguments },
            })),
          }
        : {}),
    }));
    const tools: WireTool[] | undefined = req.tools?.length
      ? req.tools.map((t: ToolSpec) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }))
      : undefined;
    return {
      model: this.cfg.model,
      messages,
      tools,
      stream: req.stream ?? true,
      temperature: req.temperature ?? this.cfg.temperature,
      max_tokens: req.maxTokens ?? this.cfg.maxTokens,
    };
  }
}

// ── Stream mapping helpers (exported for tests) ──────────────────────────

/**
 * Map the SSE chunk stream to a `ReadableStream<ChatDelta>`. Each chunk
 * may contain one or more choices (we only consume index 0). Reasoning
 * tokens (`reasoning_content`) are silently ignored — the harness does
 * not surface them in v1, but we don't drop the connection if present.
 */
function mapStreamToDeltas(
  body: ReadableStream<Uint8Array>,
): ReadableStream<ChatDelta> {
  const iter = parseSSE(body)[Symbol.asyncIterator]();
  return new ReadableStream<ChatDelta>({
    async pull(controller) {
      // Use the iterator explicitly so we never block forever if the
      // upstream goes silent mid-stream.
      const next = await iter.next();
      if (next.done) {
        controller.close();
        return;
      }
      const ev = next.value;
      const chunk = ev.data as WireChunk;
      const choice = chunk.choices?.[0];
      const usage = chunk.usage;
      if (!choice && !usage) return this.pull?.(controller);

      const delta: ChatDelta = {};
      if (typeof choice?.delta?.content === "string") {
        delta.contentDelta = choice.delta.content;
      }
      // Tool-call deltas are emitted but most v1 routes don't need them.
      const tc = choice?.delta?.tool_calls?.[0];
      if (tc && tc.function) {
        delta.toolCallDelta = {
          id: tc.id ?? "",
          name: tc.function.name ?? "",
          arguments: tc.function.arguments ?? "",
        };
      }
      if (choice?.finish_reason) {
        delta.finishReason = choice.finish_reason === "tool_calls"
          ? "tool_calls"
          : choice.finish_reason === "length"
          ? "length"
          : "stop";
      }
      if (usage) {
        delta.usage = {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        };
      }
      controller.enqueue(delta);
    },
  });
}

/**
 * Tiny helper to convert a `ReadableStream` into an async iterable. Next 14
 * ships `ReadableStream.from` but Node 20 + Next 16 supports both shapes;
 * this polyfill is the safest path.
 */
export async function* streamToAsyncIterable<T>(
  stream: ReadableStream<T>,
): AsyncIterable<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
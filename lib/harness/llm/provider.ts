/**
 * Harness LLM Provider — provider-agnostic interface.
 *
 * `LLMProvider` is the single seam between the harness and any concrete
 * LLM API (OpenAI, Doubao Ark, DeepSeek, Ollama …). It deliberately mirrors
 * the OpenAI Chat Completions wire shape so that the openai-compatible
 * adapter is the default; everything else is a swap.
 *
 * The provider returns a streaming `ReadableStream<ChatDelta>` so callers
 * can pipe content deltas straight to a server-sent-event response without
 * having to buffer or re-chunk.
 *
 * No I/O happens in this file — concrete adapters do the fetch.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  /** Plain-text content. Multipart content for vision is out of scope (v1). */
  content: string;
  /** When `role === "assistant"` and the model wants to call a tool. */
  toolCalls?: ToolCall[];
  /** When `role === "tool"` — which assistant tool_call this responds to. */
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string from the model — parse before use. */
  arguments: string;
}

export interface ToolSpec {
  /** Function name. Must match a registered skill id (or a sub-action). */
  name: string;
  /** Human-readable description shown to the model. */
  description: string;
  /** JSON Schema object describing the parameters. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Default true — adapters should stream when supported. */
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatDelta {
  /** Incremental assistant content (text). */
  contentDelta?: string;
  /** Incremental tool-call argument delta; usually empty for v1 routing. */
  toolCallDelta?: ToolCall;
  finishReason?: "stop" | "tool_calls" | "length" | "error";
  /** Raw provider usage if it arrives in the final chunk. */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface LLMProvider {
  /** One-shot chat (non-streaming) — useful for intent classification. */
  chat(req: ChatRequest): Promise<ReadableStream<ChatDelta>>;
  /** Convenience: collect full content as a single string. */
  completeText(req: ChatRequest): Promise<string>;
}

export class LLMConfigError extends Error {
  constructor(msg: string) {
    super(`[harness/llm] ${msg}`);
    this.name = "LLMConfigError";
  }
}

export class LLMUpstreamError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`[harness/llm] upstream ${status}: ${body.slice(0, 200)}`);
    this.name = "LLMUpstreamError";
    this.status = status;
    this.body = body;
  }
}
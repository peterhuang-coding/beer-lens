/**
 * POST /api/chat — harness chat endpoint.
 *
 * Wire contract:
 *   Request:  application/json, { message: string, conversationId?: string }
 *   Response: text/event-stream
 *               event: meta     data: {"skill_id":"menu_recommend","reason":"..."}
 *               event: delta   data: {"text":"partial reply"}
 *               event: done    data: {"skill_id":"...", "latency_ms":1234}
 *               event: error   data: {"code":"...", "message":"..."}   (terminal)
 *
 * Pipeline:
 *   1. routeByLLM(userMessage)
 *   2. if skill_id is "none" or routing failed → emit a friendly fallback
 *   3. invokeSkill(skill_id, ctx) (deterministic)
 *   4. stream the skill's reply character-by-character (or compose via LLM)
 *
 * The endpoint never throws — every failure mode is converted to an
 * `error` SSE event so the client UI can show a toast and the connection
 * can be closed cleanly.
 */

import { NextResponse } from "next/server";
import { routeByLLM } from "@/lib/harness/router-llm";
import { invokeSkill, listEnabledSkillIds } from "@/lib/harness/router";
// Side-effect import: ensures the 8 default skills are registered before
// any rule lookup or skill invocation. Without this, listSkills() returns
// an empty array and every prompt would fall through to the LLM.
import "@/lib/harness/skill-registry";
import type { SkillContext, AgentReply } from "@/lib/harness/types";
import { buildReplyComposerMessages } from "@/lib/harness/llm/prompts/reply-composer";
import { OpenAICompatibleProvider, streamToAsyncIterable } from "@/lib/harness/llm/openai-compatible";
import { loadLLMConfig } from "@/lib/harness/llm/config";
import { LLMConfigError, LLMUpstreamError, type ChatDelta } from "@/lib/harness/llm/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatRequestBody {
  message?: unknown;
  conversationId?: unknown;
}

const encoder = new TextEncoder();

function sseEvent(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: Request): Promise<Response> {
  const t0 = Date.now();

  // ── Parse body ──────────────────────────────────────────────────────────
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }
  const conversationId =
    typeof body.conversationId === "string" && body.conversationId
      ? body.conversationId
      : `conv_${Date.now().toString(36)}`;

  // ── Route via LLM ──────────────────────────────────────────────────────
  const routeRes = await routeByLLM(message);
  if (!routeRes.ok) {
    // Routing failed — return a streaming error rather than 500 so the UI
    // can display the cause without losing the connection.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          sseEvent("error", { code: routeRes.reason, message: routeRes.message }),
        );
        controller.enqueue(
          sseEvent("done", { skill_id: "none", latency_ms: Date.now() - t0 }),
        );
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }
  const { skill_id, params, reason } = routeRes.decision;

  // ── Build SSE stream ────────────────────────────────────────────────────
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(sseEvent("meta", { skill_id, reason, params }));

        // Path A: no skill fits → friendly fallback line.
        if (skill_id === "none") {
          const reply = "我还在学习中,先告诉我你想推荐啤酒、查酒标,还是聊点啤酒知识?";
          controller.enqueue(sseEvent("delta", { text: reply }));
          controller.enqueue(sseEvent("done", { skill_id, latency_ms: Date.now() - t0 }));
          controller.close();
          return;
        }

        // Path B: invoke the skill deterministically.
        const ctx: SkillContext = {
          request: {
            // Minimal BeerDialogRequest — only fields the harness uses today.
            channel: "web",
            userId: "anon",
            conversationId,
            turnId: `t_${Date.now().toString(36)}`,
            messages: [{ role: "user", content: message }],
          },
          userId: "anon",
          conversationId,
          params,
        };
        const result = await invokeSkill(skill_id as never, ctx);
        if (!result.ok) {
          controller.enqueue(
            sseEvent("error", { code: result.error, message: result.message }),
          );
          controller.enqueue(sseEvent("done", { skill_id, latency_ms: Date.now() - t0 }));
          controller.close();
          return;
        }

        const skillReply: AgentReply = result;

        // Path C: stream the composer output if available, else stream the
        // skill's static reply character-by-character so the UI feels alive.
        const composerStream = await tryCompose(message, skill_id, skillReply);
        if (composerStream) {
          for await (const delta of composerStream) {
            if (delta.contentDelta) {
              controller.enqueue(sseEvent("delta", { text: delta.contentDelta }));
            }
          }
        } else {
          // Static fallback — chunk the skill reply so the UI gets a "stream".
          const text = skillReply.reply || "(无回复)";
          const CHUNK = 4;
          for (let i = 0; i < text.length; i += CHUNK) {
            controller.enqueue(sseEvent("delta", { text: text.slice(i, i + CHUNK) }));
          }
        }

        controller.enqueue(
          sseEvent("done", {
            skill_id,
            latency_ms: Date.now() - t0,
            enabled: listEnabledSkillIds(),
          }),
        );
        controller.close();
      } catch (err) {
        controller.enqueue(
          sseEvent("error", {
            code: "internal",
            message: String((err as Error).message ?? err),
          }),
        );
        controller.enqueue(sseEvent("done", { skill_id, latency_ms: Date.now() - t0 }));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Try the LLM reply composer. Returns null on any error so the caller can
 * fall back to streaming the static skill reply.
 */
async function tryCompose(
  userMessage: string,
  skillId: string,
  skillReply: AgentReply,
): Promise<AsyncIterable<ChatDelta> | null> {
  try {
    const provider = new OpenAICompatibleProvider(loadLLMConfig());
    const messages = buildReplyComposerMessages(userMessage, skillId, skillReply);
    const stream = await provider.chat({
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: 0.4,
      maxTokens: 200,
      stream: true,
    });
    return streamToAsyncIterable(stream);
  } catch (err) {
    if (err instanceof LLMConfigError || err instanceof LLMUpstreamError) return null;
    return null;
  }
}
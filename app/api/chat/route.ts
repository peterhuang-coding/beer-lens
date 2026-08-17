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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { appendTrace, previewMessage } from "@/lib/harness/trace-buffer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatRequestBody {
  message?: unknown;
  conversationId?: unknown;
  imageDataUrl?: unknown;
  imageName?: unknown;
  imageType?: unknown;
}

const encoder = new TextEncoder();

function sseEvent(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Beer-cache label lookup ───────────────────────────────────────────────
// The SkillResult.candidates array doesn't carry labelImage by default — it
// only carries text fields. We load data/beer_cache.json once at module
// load (≈200 KB, parsed once per process) and use it to attach label URLs
// + Untappd links so the chat UI can render beer cards with photos.

interface BeerCacheRecord {
  id: string;
  beerName: string;
  breweryName: string | null;
  labelImage: string | null;
  untappdUrl: string | null;
  ratingScore: number | null;
  ratingCount: number | null;
}

let _labelIndex: Map<string, BeerCacheRecord> | null = null;

function loadLabelIndex(): Map<string, BeerCacheRecord> {
  if (_labelIndex) return _labelIndex;
  try {
    const raw = readFileSync(
      join(process.cwd(), "data/beer_cache.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { beers: Record<string, BeerCacheRecord> };
    const idx = new Map<string, BeerCacheRecord>();
    for (const r of Object.values(parsed.beers ?? {})) {
      const key = `${r.beerName}::${r.breweryName ?? ""}`.toLowerCase();
      if (!idx.has(key)) idx.set(key, r);
    }
    _labelIndex = idx;
  } catch {
    _labelIndex = new Map();
  }
  return _labelIndex;
}

function enrichCandidateWithLabel(c: Record<string, unknown>): Record<string, unknown> {
  if (c.labelImage) return c;
  const idx = loadLabelIndex();
  const name = String(c.displayName ?? "").trim();
  const brewery = String(c.brewery ?? "").trim();
  if (!name) return c;
  const hit = idx.get(`${name}::${brewery}`.toLowerCase())
    ?? idx.get(`${name}::`.toLowerCase());
  if (!hit) return c;
  return {
    ...c,
    labelImage: hit.labelImage,
    untappdUrl: c.untappdUrl ?? hit.untappdUrl,
    untappdId: c.untappdId ?? hit.id,
  };
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
  const imageDataUrl =
    typeof body.imageDataUrl === "string" && body.imageDataUrl.startsWith("data:")
      ? body.imageDataUrl
      : undefined;
  const imageName =
    typeof body.imageName === "string" ? body.imageName : undefined;
  const imageType =
    typeof body.imageType === "string" ? body.imageType : undefined;
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
          appendTrace({
            ts: Date.now(),
            ts_iso: new Date().toISOString(),
            message: previewMessage(message),
            skill_id: "none",
            source: "none",
            ok: true,
            latency_ms: Date.now() - t0,
            candidate_count: 0,
            has_image: !!imageDataUrl,
            reason,
          });
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
            image: imageDataUrl
              ? {
                  dataUrl: imageDataUrl,
                  name: imageName ?? "upload",
                  type: imageType ?? "image/png",
                }
              : undefined,
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

        // Emit candidates/picks as their own SSE event so the chat UI can
        // render beer cards (labelImage + brewery + score) instead of just
        // text. Backwards compatible: any client that ignores "result" still
        // gets the full delta text below.
        const enrichedCandidates = (skillReply.candidates ?? []).map((c) =>
          enrichCandidateWithLabel(c as unknown as Record<string, unknown>),
        );
        // For recommend-style replies, also emit a "menu image" hint so the
        // UI can render a small tap-list illustration when no per-beer
        // labels are available (or to accompany them as context).
        const hasLabels = enrichedCandidates.some((c) => (c as { labelImage?: string | null }).labelImage);
        const menuImage =
          skill_id === "menu_recommend"
            ? "/images/tap-list.jpg"
            : undefined;
        controller.enqueue(
          sseEvent("result", {
            skill_id,
            reply: skillReply.reply,
            candidates: enrichedCandidates,
            picks: skillReply.picks,
            profileSummary: skillReply.profileSummary ?? "",
            menuImage,
            hasLabels,
          }),
        );
        appendTrace({
          ts: Date.now(),
          ts_iso: new Date().toISOString(),
          message: previewMessage(message),
          skill_id,
          source: routeRes.source,
          ok: true,
          latency_ms: Date.now() - t0,
          candidate_count: enrichedCandidates.length,
          has_image: !!imageDataUrl,
          reason,
        });

        // Path C: optionally stream the composer output. The composer is OFF
        // by default because the reasoning model (doubao-seed-evolving) eats
        // 30-60s on a 200-token wrapper pass and the skill's own reply is
        // already a polished line. Opt back in via LLM_COMPOSE_REPLY=1 if
        // you need the composer for a specific skill.
        const useComposer = process.env.LLM_COMPOSE_REPLY === "1";
        const composerStream = useComposer ? await tryCompose(message, skill_id, skillReply) : null;
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
        appendTrace({
          ts: Date.now(),
          ts_iso: new Date().toISOString(),
          message: previewMessage(message),
          skill_id: skill_id ?? "error",
          source: "error",
          ok: false,
          error_code: "internal",
          latency_ms: Date.now() - t0,
          candidate_count: 0,
          has_image: !!imageDataUrl,
          reason,
        });
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
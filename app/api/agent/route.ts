import { NextResponse } from "next/server";
import { runAgentTurn } from "@/lib/agent/controller";
import { createTraceId } from "@/lib/beer-agent/trace";
import type { AgentRequest } from "@/lib/beer-agent/types";

export const runtime = "nodejs";

// ── Task #6 — canonical userId / conversationId resolution for Web ──
//
// The frontend is required to send `userId` and `conversationId` (generated
// once per browser via `crypto.randomUUID()` and persisted in localStorage).
// We only fall back to a sentinel default if BOTH are absent, which lets
// existing curl / test scripts keep working without breaking.

const DEFAULT_USER_ID = "local-user";
const DEFAULT_CONVERSATION_ID = "local-web-session";

function sanitizeId(value: unknown, fallback: string, max = 96): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  // Keep alnum + a small set of separators; clamp length for FS safety.
  return trimmed.replace(/[^a-zA-Z0-9_\-:.]/g, "_").slice(0, max);
}

export async function POST(request: Request) {
  const body = (await request.json()) as AgentRequest;

  try {
    // Resolve canonical identifiers. Trust the client for both, but fall back
    // to safe defaults so legacy callers do not silently break.
    const userId =
      sanitizeId((body as any).userId, DEFAULT_USER_ID) || DEFAULT_USER_ID;
    const conversationId =
      sanitizeId(
        (body as any).conversationId,
        `${DEFAULT_CONVERSATION_ID}-${Date.now()}`,
      ) || `${DEFAULT_CONVERSATION_ID}-${Date.now()}`;

    const dialogRequest = {
      userId,
      channel: "web" as const,
      conversationId,
      turnId: createTraceId(),
      messages: body.messages,
      image: body.image,
      metadata: (body as any).metadata,
    };

    const result = await runAgentTurn(dialogRequest);
    // Echo the canonical identifiers back so clients can log/persist them.
    return NextResponse.json({
      ...result,
      userId,
      conversationId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

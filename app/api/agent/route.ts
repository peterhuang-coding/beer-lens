import { NextResponse } from "next/server";
import { runBeerDialogTurn } from "@/lib/beer-agent/orchestrator";
import { generateTraceId } from "@/lib/beer-agent/dialog-types";
import type { AgentRequest } from "@/lib/beer-agent/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as AgentRequest;

  try {
    const result = await runBeerDialogTurn({
      userId: (body as any).userId ?? "local-user",
      channel: "web",
      conversationId: (body as any).conversationId ?? "local-web-session",
      turnId: generateTraceId(),
      messages: body.messages,
      image: body.image,
      metadata: (body as any).metadata,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

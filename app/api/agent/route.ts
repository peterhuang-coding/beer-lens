import { NextResponse } from "next/server";
import { runAgentTurn } from "@/lib/agent/controller";
import { createTraceId } from "@/lib/beer-agent/trace";
import type { AgentRequest } from "@/lib/beer-agent/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as AgentRequest;

  try {
    const dialogRequest = {
      userId: (body as any).userId ?? "local-user",
      channel: "web" as const,
      conversationId: (body as any).conversationId ?? "local-web-session",
      turnId: createTraceId(),
      messages: body.messages,
      image: body.image,
      metadata: (body as any).metadata,
    };

    const result = await runAgentTurn(dialogRequest);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
